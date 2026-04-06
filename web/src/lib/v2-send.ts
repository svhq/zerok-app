/**
 * ZeroK v2 — Browser Smart Send Orchestrator (Browser Adapter)
 *
 * This is the browser's thin wrapper around v2-core.
 * It follows the SAME state machine as CLI's smartSend (sdk/v2/send.js):
 *
 *   1. Plan withdrawal (shared core planner)
 *   2. Execute re-denominations if needed (shared core witness + browser proof)
 *   3. Execute withdrawals (shared core witness + browser proof)
 *
 * Browser-specific: wallet signing, snarkjs URL paths, WebCrypto, React state.
 */

import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  Connection,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { initPoseidon } from './sdk/poseidon';
import { V2Note } from '@/types/note';
import { deriveV2PoolPDAs, getRelayUrl } from './v2-config';
import { executeV2Withdrawal, checkRootInHistory } from './v2-withdrawal';

// ── Shared core imports (SAME code as CLI) ──────────────────────────────────

// @ts-ignore
import { planWithdrawal, getInventory, greedySplit } from 'v2-core/planner';
// @ts-ignore
import { computeCommitment, computeNullifierHash } from 'v2-core/note';
// @ts-ignore
import { computeMerklePath, computeBatchMerklePaths, computeRoot, readLeafCount, readFrontier, isRootInHistory } from 'v2-core/merkle';
// @ts-ignore
import { buildReDenomWitness } from 'v2-core/witness';
// @ts-ignore
import { serializeProof } from 'v2-core/proof-serialize';
// @ts-ignore
import { submitReDenomToRelay } from 'v2-core/relay';
// @ts-ignore
import { fieldToBytesBE, uint8ToBase64, hexToBytes, bytesToHex } from 'v2-core/field';
// @ts-ignore
import { calculateRelayFee } from 'v2-core/fee';

const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

// ── Types ────────────────────────────────────────────────────────────────────

export interface BrowserSmartSendParams {
  connection: Connection;
  amount: bigint;              // Total lamports to send
  recipient: PublicKey;
  relayerPubkey: PublicKey;
  notes: V2Note[];             // Current note inventory
  setNotes: (fn: (prev: V2Note[]) => V2Note[]) => void; // React state setter
  encKey: CryptoKey;           // AES-256-GCM key for memo encryption
  signTransaction: (tx: Transaction) => Promise<Transaction>;
  walletPubkey: PublicKey;
  onProgress?: (status: string) => void;
}

export interface BrowserSmartSendResult {
  withdrawnNotes: V2Note[];
  redenominated: boolean;
  totalSent: bigint;
  lastSignature: string;
}

// ── Re-denomination proof generation (browser-specific: URL paths) ──────────

async function generateReDenomProof(
  witness: Record<string, string | string[]>,
): Promise<Uint8Array> {
  const snarkjs = await import('snarkjs');
  const { proof } = await snarkjs.groth16.fullProve(
    witness,
    '/artifacts/v2/re_denominate.wasm',
    '/artifacts/v2/redenom_final.zkey',
  );
  return serializeProof(proof as { pi_a: string[]; pi_b: string[][]; pi_c: string[] });
}

// ── Batch memo for re-denomination (browser-specific: wallet signing) ───────

/**
 * Send a batch memo containing all 10 target notes from a re-denomination.
 * Binary format v2: count(1) + targetDenom(8 LE) + [nullifier(32 BE) + secret(32 BE) + leafIndex(4 LE)] × count
 * Encrypted with user's AES key, wrapped in "zerok:v2:b:" prefix.
 */
async function sendBatchRedenomMemo(
  connection: Connection,
  walletPubkey: PublicKey,
  signTransaction: (tx: Transaction) => Promise<Transaction>,
  targetNotes: Array<{ nullifier: string; secret: string; leafIndex: number }>,
  targetDenom: bigint,
  encKey: CryptoKey,
): Promise<void> {
  const count = targetNotes.length;
  const PER_NOTE = 32 + 32 + 4; // nullifier + secret + leafIndex = 68 bytes
  const payload = new Uint8Array(1 + 8 + count * PER_NOTE);
  const dv = new DataView(payload.buffer);

  // Header: count + denomination
  payload[0] = count;
  dv.setBigUint64(1, targetDenom, true); // LE

  // Each note: nullifier(32 BE) + secret(32 BE) + leafIndex(4 LE)
  for (let i = 0; i < count; i++) {
    const off = 9 + i * PER_NOTE;
    const nBytes = fieldToBytesBE(BigInt(targetNotes[i].nullifier));
    const sBytes = fieldToBytesBE(BigInt(targetNotes[i].secret));
    payload.set(nBytes, off);
    payload.set(sBytes, off + 32);
    dv.setInt32(off + 64, targetNotes[i].leafIndex ?? -1, true); // LE
  }

  // Encrypt with AES-256-GCM
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    encKey,
    payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer,
  );
  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), 12);
  const encrypted = 'zerok:v2:b:' + btoa(String.fromCharCode(...combined));

  // Build memo-only transaction
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx.add(new TransactionInstruction({
    programId: MEMO_PROGRAM,
    keys: [{ pubkey: walletPubkey, isSigner: true, isWritable: false }],
    data: Buffer.from(encrypted, 'utf8'),
  }));

  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = walletPubkey;

  const signed = await signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction(sig, 'confirmed');
}

// ── Ensure note has valid Merkle path ───────────────────────────────────────

async function ensureNotePath(
  note: V2Note,
  connection: Connection,
  poseidon: any,
): Promise<V2Note> {
  // If note has valid path + root, check root is in history
  if (note.pathElements.length > 0 && note.merkleRoot) {
    return note;
  }

  if (note.leafIndex < 0) {
    throw new Error('Note leaf index not resolved. Please wait for recovery scan to complete.');
  }

  // Compute path from pool state
  const denom = BigInt(note.amount);
  const { statePda } = deriveV2PoolPDAs(denom);
  const stateInfo = await connection.getAccountInfo(statePda);
  if (!stateInfo) throw new Error(`Pool state not found for ${Number(denom)/1e9} SOL`);

  const stateData = new Uint8Array(stateInfo.data);
  const frontier = readFrontier(stateData);
  const { pathElements, pathIndices } = computeMerklePath(note.leafIndex, frontier);

  const commitment = computeCommitment(poseidon, denom, BigInt(note.nullifier), BigInt(note.secret));
  const root = computeRoot(poseidon, commitment, pathElements, pathIndices)
    .toString(16).padStart(64, '0');

  // Verify the computed root is in the pool's 256-entry history.
  // computeMerklePath(frontier) only produces a valid root for the latest leaf.
  // For older leaves (e.g., batch-inserted from redenom), the frontier has
  // changed and the computed root won't be in history.
  if (!isRootInHistory(root, stateData)) {
    throw new Error(
      `Merkle path invalid for leaf ${note.leafIndex} — root not in pool history. ` +
      `This note was inserted when the pool had a different state. ` +
      `Deposit fresh funds to continue.`
    );
  }

  return {
    ...note,
    pathElements: pathElements.map((e: bigint) => e.toString()),
    pathIndices,
    merkleRoot: root,
  };
}

// ── Browser Smart Send ──────────────────────────────────────────────────────

/**
 * Browser's smartSend — follows the SAME state machine as CLI's smartSend.
 *
 * State machine:
 *   1. planWithdrawal() — shared core planner
 *   2. For each redenomStep: buildWitness → prove → relay → batchPaths → batchMemo
 *   3. For each directStep: ensurePath → executeV2Withdrawal → markSpent
 */
export async function browserSmartSend(params: BrowserSmartSendParams): Promise<BrowserSmartSendResult> {
  const {
    connection, amount, recipient, relayerPubkey,
    notes, setNotes, encKey,
    signTransaction, walletPubkey, onProgress,
  } = params;

  const poseidon = await initPoseidon();
  const relayUrl = getRelayUrl();

  // ── Step 0: Plan ──────────────────────────────────────────────────────────

  onProgress?.('Planning withdrawal...');
  const plan = planWithdrawal(amount, getInventory(notes));

  if (plan.error) {
    throw new Error(plan.error);
  }

  console.log('[browserSmartSend] Plan:', {
    directSteps: plan.directSteps.map((d: bigint) => Number(d)/1e9 + ' SOL'),
    redenomSteps: plan.redenomSteps.map((s: { sourceDenom: bigint; targetDenom: bigint }) =>
      `${Number(s.sourceDenom)/1e9} → 10×${Number(s.targetDenom)/1e9}`),
  });

  let redenominated = false;
  // Keep a mutable copy of notes for tracking during this send
  let currentNotes = [...notes];

  // ── Step 1: Execute re-denominations (largest sourceDenom first) ──────────

  for (const { sourceDenom, targetDenom } of plan.redenomSteps) {
    const srcDenom = BigInt(sourceDenom);
    const tgtDenom = BigInt(targetDenom);

    // Find an available source note
    const sourceNote = currentNotes.find(
      (n: V2Note) => n.status === 'unspent' && BigInt(n.amount) === srcDenom
    );
    if (!sourceNote) {
      throw new Error(`No ${Number(srcDenom)/1e9} SOL note available for re-denomination`);
    }

    onProgress?.(`Re-denominating ${Number(srcDenom)/1e9} SOL → 10×${Number(tgtDenom)/1e9} SOL...`);
    console.log('[browserSmartSend] Re-denomination:', Number(srcDenom)/1e9, '→ 10×', Number(tgtDenom)/1e9);

    // Read TARGET pool pre-state (needed for batch path computation AFTER relay confirms)
    const tgtPDAs = deriveV2PoolPDAs(tgtDenom);
    const tgtInfo = await connection.getAccountInfo(tgtPDAs.statePda);
    if (!tgtInfo) throw new Error(`Target pool not found for ${Number(tgtDenom)/1e9} SOL`);
    const tgtData = new Uint8Array(tgtInfo.data);
    const preFrontier = readFrontier(tgtData);
    const preLeafCount = readLeafCount(tgtData);

    // Ensure source note has valid Merkle path
    const readySource = await ensureNotePath(sourceNote, connection, poseidon);

    // Build witness (shared core — same as CLI)
    onProgress?.('Building re-denomination witness...');
    console.log('[browserSmartSend] Source note for redenom:', {
      amount: readySource.amount,
      leafIndex: readySource.leafIndex,
      merkleRoot: readySource.merkleRoot?.substring(0, 20) + '...',
      pathLen: readySource.pathElements.length,
    });
    const { witness, targetNotes, targetCommitments, nullifierHash } = buildReDenomWitness(poseidon, {
      inputNote: readySource,
      sourceDenom: srcDenom,
      targetDenom: tgtDenom,
      merkleRoot: readySource.merkleRoot,
      pathElements: readySource.pathElements.map((e: string) => BigInt(e)),
      pathIndices: readySource.pathIndices,
    });

    // Generate proof (browser-specific: URL paths, ~30-60s)
    onProgress?.('Generating re-denomination proof (30-60s)...');
    console.log('[browserSmartSend] Redenom witness sourceRoot:', String(witness.sourceRoot).substring(0, 20));
    console.log('[browserSmartSend] Redenom witness targetCommitments count:', (witness.targetCommitments as string[])?.length);
    const proofBytes = await generateReDenomProof(witness);
    console.log('[browserSmartSend] Proof generated, size:', proofBytes.length);

    // Submit to relay (shared core)
    onProgress?.('Submitting re-denomination to relay...');
    const nullifierHashBytes = fieldToBytesBE(nullifierHash);
    const targetCommitmentBytes = targetCommitments.map((c: bigint) => fieldToBytesBE(c));

    console.log('[browserSmartSend] Sending to relay:', {
      proofLen: proofBytes.length,
      nullLen: nullifierHashBytes.length,
      sourceRoot: readySource.merkleRoot?.substring(0, 20),
      commitsCount: targetCommitmentBytes.length,
      srcDenom: Number(srcDenom),
      tgtDenom: Number(tgtDenom),
    });

    // Mark source note as pending (provisional — reverts on failure)
    setNotes(prev => prev.map(n => n.id === sourceNote.id ? { ...n, status: 'pending_spend' as const } : n));

    let relayResult: any;
    try {
      relayResult = await submitReDenomToRelay(relayUrl, {
        proofBytes,
        nullifierHashBytes,
        sourceRoot: readySource.merkleRoot,
        targetCommitmentBytes,
      }, srcDenom, tgtDenom);
    } catch (e: any) {
      // Revert to unspent — on-chain nullifier was never created
      sourceNote.status = 'unspent';
      setNotes(prev => prev.map(n => n.id === sourceNote.id ? { ...n, status: 'unspent' as const } : n));
      throw new Error(`Re-denomination failed: ${e.message}`);
    }

    onProgress?.(`Re-denomination confirmed: ${relayResult.signature?.substring(0, 12)}...`);
    console.log('[browserSmartSend] Redenom confirmed:', relayResult.signature);

    // Committed — nullifier PDA exists on-chain
    sourceNote.status = 'spent';
    setNotes(prev => prev.map(n => n.id === sourceNote.id ? { ...n, status: 'spent' as const } : n));

    // Compute batch Merkle paths for all 10 new notes (shared core — same as CLI)
    onProgress?.('Computing Merkle paths for 10 new notes...');
    const firstLeafIndex = preLeafCount;
    const batchCommitments = targetNotes.map((tNote: any) =>
      computeCommitment(poseidon, tgtDenom, BigInt(tNote.nullifier), BigInt(tNote.secret))
    );
    const batchPaths = computeBatchMerklePaths(poseidon, batchCommitments, firstLeafIndex, preFrontier);

    // Enrich target notes with paths (same as CLI)
    const enrichedNotes: V2Note[] = [];
    for (let i = 0; i < 10; i++) {
      const tNote = targetNotes[i];
      const v2Note: V2Note = {
        id: tNote.commitment,
        amount: tNote.amount,
        nullifier: tNote.nullifier,
        secret: tNote.secret,
        commitment: tNote.commitment,
        nullifierHash: tNote.nullifierHash,
        leafIndex: firstLeafIndex + i,
        merkleRoot: batchPaths[i].root,
        pathElements: batchPaths[i].pathElements.map((e: bigint) => e.toString()),
        pathIndices: batchPaths[i].pathIndices,
        status: 'unspent' as const,
        createdAt: new Date().toISOString(),
      };
      enrichedNotes.push(v2Note);
      currentNotes.push(v2Note);
    }

    // Add new notes to React state
    setNotes(prev => [...prev, ...enrichedNotes]);

    // Send batch memo for recovery (browser-specific: wallet signing)
    try {
      onProgress?.('Saving batch memo for recovery...');
      await sendBatchRedenomMemo(
        connection, walletPubkey, signTransaction,
        enrichedNotes.map(n => ({ nullifier: n.nullifier, secret: n.secret, leafIndex: n.leafIndex })),
        tgtDenom, encKey,
      );
      console.log('[browserSmartSend] Batch memo saved');
    } catch (e: any) {
      console.warn('[browserSmartSend] Batch memo failed (non-fatal):', e.message);
      // Non-fatal: notes are in local state, just not recoverable from memos
    }

    redenominated = true;
  }

  // ── Step 2: Execute withdrawals ───────────────────────────────────────────

  // Rebuild inventory from current notes (includes newly created redenom notes)
  // Sort: notes with valid paths first (ready to withdraw without path computation)
  const sortedNotes = [...currentNotes].sort((a, b) => {
    const aHasPath = a.pathElements.length > 0 && a.merkleRoot ? 1 : 0;
    const bHasPath = b.pathElements.length > 0 && b.merkleRoot ? 1 : 0;
    return bHasPath - aHasPath; // notes with paths first
  });
  const inventory = getInventory(sortedNotes);
  const withdrawnNotes: V2Note[] = [];
  let totalSent = 0n;
  let lastSignature = '';

  // Count how many of each denom we need
  const needCount: Record<string, number> = {};
  for (const d of plan.directSteps) {
    const key = d.toString();
    needCount[key] = (needCount[key] || 0) + 1;
  }

  let step = 0;
  const totalSteps = plan.directSteps.length;

  for (const [denomStr, count] of Object.entries(needCount)) {
    const denom = BigInt(denomStr);
    const available = inventory[denomStr] || [];
    let usedFromPool = 0;

    for (let i = 0; i < count; i++) {
      step++;
      const denomSol = Number(denom) / 1e9;
      onProgress?.(`Withdrawing ${denomSol} SOL (${step}/${totalSteps})...`);

      // Find a note with a valid Merkle path (skip pathless recovered notes)
      let readyNote: V2Note | null = null;
      while (usedFromPool < available.length) {
        const candidate = available[usedFromPool] as V2Note;
        usedFromPool++;
        try {
          readyNote = await ensureNotePath(candidate, connection, poseidon);
          console.log(`[browserSmartSend] Withdrawal ${step}/${totalSteps}: ${denomSol} SOL (leaf ${readyNote.leafIndex})`);
          break;
        } catch (e: any) {
          console.warn(`[browserSmartSend] Skipping leaf ${candidate.leafIndex}: ${e.message}`);
          continue;
        }
      }
      if (!readyNote) {
        throw new Error(`Not enough withdrawable ${denomSol} SOL notes (${count - i} needed, all remaining lack valid paths)`);
      }

      // Mark as pending (provisional — reverts on failure)
      setNotes(prev => prev.map(n => n.id === readyNote.id ? { ...n, status: 'pending_spend' as const } : n));

      // Full-drain withdrawal: withdrawalAmount = denomination, change = 0
      let result: any;
      try {
        result = await executeV2Withdrawal({
          note: readyNote,
          withdrawalAmount: denom,
          recipient,
          relayerPubkey,
          encKey,
          onProgress: msg => onProgress?.(`(${step}/${totalSteps}) ${msg}`),
        });
      } catch (e: any) {
        // Revert to unspent — on-chain nullifier was never created
        setNotes(prev => prev.map(n => n.id === readyNote!.id ? { ...n, status: 'unspent' as const } : n));
        throw new Error(`Withdrawal ${step}/${totalSteps} failed: ${e.message}`);
      }

      lastSignature = result.signature;
      console.log(`[browserSmartSend] Withdrawal ${step}/${totalSteps}: CONFIRMED`, result.signature);

      // Committed — nullifier PDA exists on-chain
      setNotes(prev => prev.map(n => n.id === readyNote.id ? { ...n, status: 'spent' as const } : n));
      withdrawnNotes.push(readyNote);
      totalSent += denom;

      // Brief pause between sequential withdrawals to avoid relay 409
      if (step < totalSteps) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  return { withdrawnNotes, redenominated, totalSent, lastSignature };
}
