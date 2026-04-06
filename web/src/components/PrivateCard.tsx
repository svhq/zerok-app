'use client';

/**
 * PrivateCard — Unified v2 deposit + withdrawal interface
 *
 * Inspired by Privacy Cash's minimalist single-card design.
 * Two modes: Deposit (freeform SOL amount) and Send (fixed denomination withdrawal).
 * Private balance shown inline, recovery runs automatically on wallet connect.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
  Connection,
} from '@solana/web3.js';
import { Button } from './ui';
import { V2Note } from '@/types/note';
import { Note } from '@/types/note';
import {
  generateRandomFieldElement,
  computeCommitmentFromBigInts,
  computeV2CommitmentFromBigInts,
  bytesToFieldBE,
} from '@/lib/sdk/poseidon';
import { reconcileNotes } from '@/lib/reconcile';
import {
  deriveNoteEncryptionKey,
  getCachedKey,
} from '@/lib/note-encryption';
import { formatSol } from '@/lib/pool-config';
import { loadCachedNotes, saveNote, saveCachedNotes, updateNoteStatus, rebuildCache, initChainId } from '@/lib/note-cache';
import { detectNetworkFromHostname } from '@/lib/network-config';
import { downloadNote, downloadAllNotes } from '@/lib/note-export';
import { getScanEndpoint } from '@/lib/resilient-connection';
import {
  computeMerklePathFromCommitments,
  readFrontierFromState,
  readLeafCountFromState,
  computeMerklePathFromFrontier,
  computeRootFromPath,
} from '@/lib/sdk/poseidon';
import {
  V2_DENOMINATIONS,
  checkRootInHistory,
  executeV2Withdrawal,
} from '@/lib/v2-withdrawal';
import V3WithdrawPage from './V3WithdrawPage';

// ─── v2 program constants (multi-denomination aware) ─────────────────────────

import { V2_PROGRAM_ID, deriveV2PoolPDAs, greedySplit, calculateRelayFee, getRelayUrl } from '@/lib/v2-config';
import { getPoolConfig, getDeployedPools } from '@/lib/pool-config';

const MEMO_PROGRAM   = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const MEMO_PREFIX_V3 = 'zerok:v3:';
const RELAY_PUBKEY   = new PublicKey('BEWNKrbVnLuWxPqVLSszwZpC6o86mC8RoSAWDaWwFivq');

const _enc = new TextEncoder();

const MIN_DEPOSIT_SOL = 0.1;
const DEPOSIT_CU = 200_000; // V3 deposit (~57K CU) + Memo program (~64K CU for Ed25519 signer verify)

// ─── Deposit helpers ──────────────────────────────────────────────────────────

function snapToGrid(sol: number): number {
  // Round to nearest 0.1 SOL — use Math.round to avoid floating point truncation
  // (e.g., 0.3 / 0.1 = 2.9999... → Math.floor gives 2 → 0.2 SOL, wrong)
  return Math.round(sol * 10) / 10;
}

/** Enforce max 1 decimal place while typing — prevents "1.22" from ever appearing. */
function sanitizeAmountInput(raw: string): string {
  // Strip non-numeric except one dot
  let val = raw.replace(/[^0-9.]/g, '');
  const dotIdx = val.indexOf('.');
  if (dotIdx !== -1) {
    // Keep only 1 decimal place
    val = val.slice(0, dotIdx + 1) + val.slice(dotIdx + 1).replace(/\./g, '').slice(0, 1);
  }
  return val;
}

// V3 deposit discriminator: SHA256("global:deposit_v2_clean")[0..8]
async function getDepositV3Disc(): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    _enc.encode('global:deposit_v2_clean') as unknown as ArrayBuffer,
  );
  return new Uint8Array(buf).slice(0, 8);
}

// V3 memo: zerok:v3: + base64(IV[12] + AES-GCM-ciphertext + tag[16])
// Payload: { d: denomination, n: nullifier hex, s: secret hex, v: 3 }
async function encryptV3Memo(
  key: CryptoKey,
  payload: { d: string; n: string; s: string; v: number },
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = _enc.encode(JSON.stringify(payload));
  const buf = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buf);
  const combined = new Uint8Array(12 + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), 12);
  return MEMO_PREFIX_V3 + btoa(String.fromCharCode(...combined));
}

/** Resolve V3 pool PDAs from config for a given denomination. */
function getV3PoolPDAs(denomination: bigint): {
  statePda: PublicKey; vaultPda: PublicKey; rootRingPda: PublicKey;
  metadataPda: PublicKey; shardPdas: PublicKey[];
} {
  const pools = getDeployedPools();
  for (const { id } of pools) {
    const pc = getPoolConfig(id);
    if (BigInt(pc.denominationLamports) === denomination) {
      return {
        statePda: new PublicKey(pc.statePda),
        vaultPda: new PublicKey(pc.vaultPda),
        rootRingPda: new PublicKey(pc.rootRingPda),
        metadataPda: new PublicKey(pc.metadataPda),
        shardPdas: (pc.shardPdas || []).map((s: string) => new PublicKey(s)),
      };
    }
  }
  throw new Error(`V3 pool not found for denomination ${denomination}`);
}

/** Read active shard index from ring metadata account (matches CLI sdk/v3/deposit.js:161). */
async function readActiveShardIndex(conn: Connection, metadataPda: PublicKey): Promise<number> {
  const info = await conn.getAccountInfo(metadataPda);
  if (!info) return 0;
  // Ring metadata layout: active_shard_index at offset 32, u32 LE
  const view = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
  return view.getUint32(32, true);
}

// ─── Memo recovery helpers ────────────────────────────────────────────────────


// ─── Component ────────────────────────────────────────────────────────────────

type Mode = 'deposit' | 'send';
type DepositPhase = 'idle' | 'generating' | 'signing' | 'confirming' | 'done' | 'error';
type SendPhase = 'idle' | 'checking' | 'proving' | 'submitting' | 'done' | 'error';

export default function PrivateCard({ onKeyReady }: { onKeyReady?: () => void }) {
  const { publicKey, signTransaction, signAllTransactions, signMessage, connected } = useWallet();
  const { connection } = useConnection();

  // Mode & state
  const [mode, setMode] = useState<Mode>('deposit');
  const [v2Notes, setV2Notes] = useState<V2Note[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [syncState, setSyncState] = useState<'cached' | 'checking' | 'provisional' | 'confirmed'>('cached');
  const scanInFlight = useRef(false);
  const depositInFlight = useRef(false);

  // Deposit state
  const [amountSol, setAmountSol] = useState('');
  const [depositPhase, setDepositPhase] = useState<DepositPhase>('idle');
  const [depositError, setDepositError] = useState<string | null>(null);
  const [lastDepositedNotes, setLastDepositedNotes] = useState<V2Note[]>([]);
  const [showNotesExpanded, setShowNotesExpanded] = useState(false);

  // Send state
  const [sendAmountSol, setSendAmountSol] = useState('');
  const [recipient, setRecipient] = useState('');
  const [sendPhase, setSendPhase] = useState<SendPhase>('idle');
  const [sendProgress, setSendProgress] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);

  // Computed values
  // Dedup by nullifier (cache + recovery may both add same note)
  const seenNullifiers = new Set<string>();
  const unspent = v2Notes.filter(n => {
    if (n.status !== 'unspent') return false;
    if (seenNullifiers.has(n.nullifier)) return false;
    seenNullifiers.add(n.nullifier);
    return true;
  });
  const totalBalance = unspent.reduce((sum, n) => sum + BigInt(n.amount), 0n);

  // Log balance changes
  useEffect(() => {
    if (v2Notes.length > 0) {
      const inv: Record<string, number> = {};
      for (const n of unspent) {
        const label = `${Number(BigInt(n.amount))/1e9}`;
        inv[label] = (inv[label] || 0) + 1;
      }
      console.log(`[ZeroK] Balance: ${Number(totalBalance)/1e9} SOL | ${unspent.length} unspent notes | ${JSON.stringify(inv)}`);
    }
  }, [totalBalance, unspent.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const depositLamports = (() => {
    const n = parseFloat(amountSol);
    if (isNaN(n) || n <= 0) return 0n;
    return BigInt(Math.round(snapToGrid(n) * 1e9));
  })();
  const depositValid = depositLamports >= BigInt(MIN_DEPOSIT_SOL * 1e9);

  // Send amount: user types any multiple of 0.1 SOL, we break it into denominations
  const sendLamports = (() => {
    const n = parseFloat(sendAmountSol);
    if (isNaN(n) || n <= 0) return 0n;
    return BigInt(Math.round(snapToGrid(n) * 1e9));
  })();
  const sendValid = sendLamports >= 100_000_000n && sendLamports <= totalBalance;

  /** Break a send amount into optimal denomination steps (greedy, largest first). */
  function breakIntoDenominations(lamports: bigint): bigint[] {
    const denoms = [100_000_000_000n, 10_000_000_000n, 1_000_000_000n, 100_000_000n]; // 100, 10, 1, 0.1 SOL
    const steps: bigint[] = [];
    let remaining = lamports;
    for (const d of denoms) {
      while (remaining >= d) {
        steps.push(d);
        remaining -= d;
      }
    }
    return steps;
  }

  // NOTE: Notes are persisted explicitly at each mutation:
  // - Deposit: saveNote() called per note after creation
  // - Reconciliation: rebuildCache() called once at the end of reconcileNotes()
  // - Withdrawal: updateNoteStatus() called in V3WithdrawPage

  // ─── Auto-scan on wallet connect ──────────────────────────────────────────

  useEffect(() => {
    if (!connected || !publicKey || !signMessage) return;

    (async () => {
      // Init chain fingerprint (instant for mainnet/devnet, one RPC call for localnet)
      const scanConn = new Connection(getScanEndpoint(), { commitment: 'confirmed' });
      await initChainId(detectNetworkFromHostname(), scanConn);

      // Load cache (chain-scoped — only notes from current chain)
      const cached = loadCachedNotes(publicKey.toBase58());
      if (cached.length > 0) {
        console.log(`[ZeroK] Loaded ${cached.length} notes from local cache`);
        setV2Notes(cached);
        setSyncState('cached');
      }

      // Run single-pass reconciliation pipeline
      handleRecovery();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, publicKey?.toBase58(), !!signMessage]);

  // ─── Single-pass reconciliation ───────────────────────────────────────────

  const handleRecovery = useCallback(async () => {
    if (!publicKey || !signMessage) return;
    if (scanInFlight.current) return;
    scanInFlight.current = true;
    setIsScanning(true);
    setSyncState('checking');
    console.log('[ZeroK] Recovery scan starting for', publicKey.toBase58().substring(0, 12) + '...');
    console.log('[ZeroK] Program ID:', V2_PROGRAM_ID.toBase58());

    try {
      const scanConn = new Connection(getScanEndpoint(), { commitment: 'confirmed', disableRetryOnRateLimit: true });

      // Derive encryption key (triggers Phantom popup first time)
      const keyPromise = deriveNoteEncryptionKey(publicKey.toBase58(), signMessage);
      const timeoutPromise = new Promise<null>((_, reject) => setTimeout(() => reject(new Error('Key derivation timed out')), 30000));
      let key: CryptoKey;
      try {
        key = await Promise.race([keyPromise, timeoutPromise]) as CryptoKey;
      } catch {
        console.warn('[Recovery] Key derivation timed out or failed, skipping scan');
        return;
      }
      onKeyReady?.();

      // Run single-pass chain-authoritative reconciliation
      const cached = loadCachedNotes(publicKey.toBase58());
      const result = await reconcileNotes({
        wallet: publicKey.toBase58(),
        connection: scanConn,
        encryptionKey: key,
        programId: V2_PROGRAM_ID,
        cachedNotes: cached,
        onProvisional: notes => {
          setV2Notes(notes);
          setSyncState('provisional');
        },
      });

      if (result) {
        // Pipeline completed (not stale)
        setV2Notes(result.notes);
        rebuildCache(publicKey.toBase58(), result.notes);
        setSyncState('confirmed');

        const bal = result.notes.filter(n => n.status === 'unspent').reduce((s, n) => s + Number(BigInt(n.amount)), 0);
        console.log(`[ZeroK] Balance: ${bal / 1e9} SOL | ${result.stats.unspent} unspent notes | ${result.stats.withdrawable} withdrawable`);
      }
    } catch (err) {
      console.warn('[Recovery] scan failed:', err);
    } finally {
      scanInFlight.current = false;
      setIsScanning(false);
    }
  }, [publicKey, signMessage, connection, onKeyReady]);

  // ─── Deposit handler ──────────────────────────────────────────────────────

  async function handleDeposit() {
    if (!publicKey || !signTransaction || !signAllTransactions || !depositValid) return;
    if (depositInFlight.current) return; // Prevent double-click race
    depositInFlight.current = true;
    setDepositError(null);
    setDepositPhase('generating');

    try {
      // Split deposit into denomination-sized pieces (e.g., 2.3 SOL → 2×1 + 3×0.1)
      const denomSplits = greedySplit(depositLamports);
      console.log(`[ZeroK] Deposit ${Number(depositLamports)/1e9} SOL → ${denomSplits.length} notes:`, denomSplits.map(d => `${Number(d)/1e9} SOL`));
      console.log(`[ZeroK] Program ID: ${V2_PROGRAM_ID.toBase58()}`);
      const disc = await getDepositV3Disc();
      // Derive encryption key on-demand if not cached (handles case where recovery scan was skipped)
      let aesKey = getCachedKey(publicKey.toBase58());
      if (!aesKey && signMessage) {
        console.log('[ZeroK] Deriving encryption key on-demand...');
        aesKey = await deriveNoteEncryptionKey(publicKey.toBase58(), signMessage);
      }

      // Build all deposit instructions + memos, then batch into minimal transactions.
      const noteData: Array<{ denom: bigint; nullifier: bigint; secret: bigint; commitment: Uint8Array; nullifierHash: Uint8Array; commitHex: string; memoText: string | null }> = [];

      for (const denom of denomSplits) {
        const nullifier = generateRandomFieldElement();
        const secret = generateRandomFieldElement();
        // V3: Poseidon(nullifier, secret) — no amount field (V1 style)
        const { commitment, nullifierHash } = await computeCommitmentFromBigInts(nullifier, secret);
        const commitHex = Array.from(commitment).map(b => b.toString(16).padStart(2, '0')).join('');
        let memoText: string | null = null;
        if (aesKey) {
          // V3 memo: hex nullifier/secret, denomination, version
          memoText = await encryptV3Memo(aesKey, {
            d: denom.toString(),
            n: nullifier.toString(16).padStart(62, '0'),
            s: secret.toString(16).padStart(62, '0'),
            v: 3,
          });
        }
        noteData.push({ denom, nullifier, secret, commitment, nullifierHash, commitHex, memoText });
      }

      // Read pool state BEFORE deposit to get leaf indices + frontiers (like CLI deposit.js)
      // V3: use config PDAs instead of deriving with V2 seeds
      const denomPoolState = new Map<string, { leafCount: number; frontier: string[]; poolPDAs: ReturnType<typeof getV3PoolPDAs>; activeShardIdx: number }>();
      for (const nd of noteData) {
        const key = nd.denom.toString();
        if (!denomPoolState.has(key)) {
          const poolPDAs = getV3PoolPDAs(nd.denom);
          const info = await connection.getAccountInfo(poolPDAs.statePda);
          if (!info) throw new Error(`Pool not found for ${Number(nd.denom)/1e9} SOL`);
          const stateBytes = info.data as unknown as Uint8Array;
          const leafCount = readLeafCountFromState(stateBytes);
          const frontier = readFrontierFromState(stateBytes);
          const activeShardIdx = await readActiveShardIndex(connection, poolPDAs.metadataPda);
          denomPoolState.set(key, { leafCount, frontier, poolPDAs, activeShardIdx });
          console.log(`[ZeroK] Pool ${Number(nd.denom)/1e9} SOL: leafCount=${leafCount}, activeShard=${activeShardIdx}`);
        }
      }

      // Network audit log — helps diagnose mainnet alignment issues
      console.log('[ZeroK] NETWORK AUDIT:', JSON.stringify({
        hostname: typeof window !== 'undefined' ? window.location.hostname : 'ssr',
        network: detectNetworkFromHostname(),
        programId: V2_PROGRAM_ID.toBase58(),
        pools: Object.fromEntries(
          [...denomPoolState.entries()].map(([k, v]) => [`${Number(BigInt(k))/1e9} SOL`, { leafCount: v.leafCount }])
        ),
      }));

      // Assign leaf indices AND compute Merkle paths at deposit time (matching CLI exactly).
      // Each note gets: leafIndex, pathElements, pathIndices, merkleRoot — immediately withdrawable.
      const denomCounters = new Map<string, number>();
      for (const nd of noteData) {
        const key = nd.denom.toString();
        const pool = denomPoolState.get(key)!;
        const offset = denomCounters.get(key) || 0;
        const leafIndex = pool.leafCount + offset;
        denomCounters.set(key, offset + 1);

        // Compute path from pre-deposit frontier (like CLI deposit.js line 141)
        const { pathElements, pathIndices } = await computeMerklePathFromFrontier(leafIndex, pool.frontier);

        // Compute root = what the tree root will be after this leaf is inserted
        const commitBigInt = bytesToFieldBE(nd.commitment);
        const merkleRoot = await computeRootFromPath(commitBigInt, pathElements, pathIndices);

        // Store on note data for later use
        (nd as any).leafIndex = leafIndex;
        (nd as any).pathElements = pathElements;
        (nd as any).pathIndices = pathIndices;
        (nd as any).merkleRoot = merkleRoot;
      }

      // Update memo payloads with correct leaf indices (V3 memo doesn't include leafIndex)
      // V3 memo is already correct — it contains {d, n, s, v} which don't change with leaf assignment

      // Build all deposit transactions, then sign ALL at once (ONE Phantom popup)
      setDepositPhase('signing');
      const txs: Transaction[] = [];
      const { blockhash } = await connection.getLatestBlockhash();

      for (let i = 0; i < noteData.length; i++) {
        const { denom, commitment, memoText } = noteData[i];
        const pool = denomPoolState.get(denom.toString())!;
        const { statePda, vaultPda, rootRingPda, metadataPda, shardPdas } = pool.poolPDAs;
        const activeShardPda = shardPdas[pool.activeShardIdx] || shardPdas[0];
        console.log(`[ZeroK] Building tx ${i+1}/${noteData.length}: ${Number(denom)/1e9} SOL → pool ${statePda.toBase58().substring(0,12)}... (leaf ${(noteData[i] as any).leafIndex})`);

        // V3 deposit data: disc(8) + commitment_BE(32) + light_fields(7) = 47 bytes
        const data = new Uint8Array(8 + 32 + 7);
        data.set(disc, 0);
        data.set(commitment, 8);
        // Last 7 bytes are zeros (Light Protocol fields unused)

        const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash });
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: DEPOSIT_CU }));
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }));
        // V3 deposit: 9 accounts (Source of Truth Section 7)
        tx.add(new TransactionInstruction({
          programId: V2_PROGRAM_ID,
          keys: [
            { pubkey: statePda, isSigner: false, isWritable: true },          // 0: pool_state
            { pubkey: vaultPda, isSigner: false, isWritable: true },          // 1: vault
            { pubkey: publicKey, isSigner: true, isWritable: true },          // 2: depositor
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 3: system_program
            { pubkey: V2_PROGRAM_ID, isSigner: false, isWritable: false },    // 4: cooldown_config (skip)
            { pubkey: V2_PROGRAM_ID, isSigner: false, isWritable: false },    // 5: user_cooldown (skip)
            { pubkey: rootRingPda, isSigner: false, isWritable: true },       // 6: root_ring
            { pubkey: metadataPda, isSigner: false, isWritable: true },       // 7: ring_metadata
            { pubkey: activeShardPda, isSigner: false, isWritable: true },    // 8: active_shard
          ],
          data: Buffer.from(data),
        }));
        if (memoText) {
          tx.add(new TransactionInstruction({
            programId: MEMO_PROGRAM,
            keys: [],  // No signers — avoids Phantom MissingRequiredSignature
            data: Buffer.from(memoText, 'utf8'),
          }));
        }
        txs.push(tx);
      }

      // Sign all transactions in ONE Phantom popup
      console.log(`[ZeroK] Signing ${txs.length} transactions (1 Phantom popup)...`);
      const signedTxs = await signAllTransactions(txs);

      // Send and confirm sequentially, re-reading pool state after each to get correct frontier
      setDepositPhase('confirming');
      const depositedBatch: V2Note[] = [];
      for (let i = 0; i < signedTxs.length; i++) {
        console.log(`[ZeroK] Sending deposit ${i+1}/${signedTxs.length}...`);
        const sig = await connection.sendRawTransaction(signedTxs[i].serialize(), { skipPreflight: false });
        await connection.confirmTransaction(sig, 'confirmed');
        console.log(`[ZeroK] Deposit ${i+1}/${signedTxs.length}: CONFIRMED ${sig.substring(0,16)}...`);

        // Re-read pool state AFTER this deposit confirms to get updated frontier + leafIndex
        // This ensures path is always correct, even for multiple deposits to the same pool.
        const nd = noteData[i];
        const postPool = denomPoolState.get(nd.denom.toString())!;
        const postStatePda = postPool.poolPDAs.statePda;
        const postInfo = await connection.getAccountInfo(postStatePda);
        let leafIdx = (nd as any).leafIndex as number;
        let pathEls = (nd as any).pathElements as string[];
        let pathIdx = (nd as any).pathIndices as number[];
        let mRoot = (nd as any).merkleRoot as string;

        if (postInfo) {
          // Recompute path from post-deposit state (the note is now the latest leaf)
          const postState = postInfo.data as unknown as Uint8Array;
          const postLeafCount = readLeafCountFromState(postState);
          const actualLeafIdx = postLeafCount - 1; // Our deposit was the last insertion
          const postFrontier = readFrontierFromState(postState);
          const { pathElements: newPath, pathIndices: newIdx } = await computeMerklePathFromFrontier(actualLeafIdx, postFrontier);
          const commitBigInt = bytesToFieldBE(nd.commitment);
          const newRoot = await computeRootFromPath(commitBigInt, newPath, newIdx);
          leafIdx = actualLeafIdx;
          pathEls = newPath;
          pathIdx = newIdx;
          mRoot = newRoot;
        }

        console.log(`[ZeroK] Note created: ${Number(nd.denom)/1e9} SOL, leaf=${leafIdx}, root=${mRoot.substring(0,12)}...`);
        const newNote: V2Note = {
          id: nd.commitHex,
          amount: nd.denom.toString(),
          nullifier: nd.nullifier.toString(),
          secret: nd.secret.toString(),
          commitment: nd.commitHex,
          nullifierHash: Array.from(nd.nullifierHash).map(b => b.toString(16).padStart(2, '0')).join(''),
          leafIndex: leafIdx,
          merkleRoot: mRoot,
          pathElements: pathEls,
          pathIndices: pathIdx,
          status: 'unspent' as const,
          depositTx: sig,
          createdAt: new Date().toISOString(),
          noteVersion: 3,
        };
        depositedBatch.push(newNote);
        saveNote(publicKey.toBase58(), newNote);
        setV2Notes(prev => [...prev, newNote]);
      }

      setLastDepositedNotes(depositedBatch);
      setDepositPhase('done');
      setAmountSol('');
      depositInFlight.current = false;
      // Trigger re-scan to fill in leafIndex + path from on-chain events
      setTimeout(() => handleRecovery(), 2000);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Detect Phantom Lighthouse/Blowfish guard blocking (error 0x1900 on state PDA size)
      if (errMsg.includes('0x1900') || errMsg.includes('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95')) {
        setDepositError(
          'Phantom\'s security scanner blocked this transaction (known issue with new protocols). ' +
          'Please use Solflare wallet instead, or enable Phantom\'s "Testnet Mode" in Settings \u2192 Developer Settings.'
        );
      } else {
        setDepositError(errMsg);
      }
      setDepositPhase('error');
      depositInFlight.current = false;
    }
  }

  // ─── Send (withdraw) handler ──────────────────────────────────────────────

  function pickNote(minBalance: bigint): V2Note | null {
    // Prefer notes with paths already computed, fallback to any with sufficient balance
    return unspent.find(n => BigInt(n.amount) >= minBalance && n.pathElements.length > 0)
        ?? unspent.find(n => BigInt(n.amount) >= minBalance && n.leafIndex >= 0)
        ?? null;
  }

  /** Fetch Merkle proof from relay (one HTTP call instead of 116 RPC calls). */
  async function ensurePath(note: V2Note, progressFn: (msg: string) => void): Promise<V2Note> {
    if (note.pathElements.length > 0 && note.merkleRoot) return note;

    // If leafIndex is -1, try to find a recovered version of this note (from memo scan)
    if (note.leafIndex < 0) {
      console.log('[ensurePath] Note has leafIndex -1, looking for recovered version...');
      const recovered = v2Notes.find(n =>
        n.nullifier === note.nullifier && n.leafIndex >= 0 && n.status === 'unspent'
      );
      if (recovered) {
        console.log('[ensurePath] Found recovered note with leafIndex', recovered.leafIndex);
        note = { ...recovered };
        if (note.pathElements.length > 0 && note.merkleRoot) return note;
      } else {
        progressFn('Resolving note index...');
        console.log('[ensurePath] No recovered version, waiting for recovery...');
        await new Promise(r => setTimeout(r, 3000));
        const retried = v2Notes.find(n =>
          n.nullifier === note.nullifier && n.leafIndex >= 0 && n.status === 'unspent'
        );
        if (retried) {
          note = { ...retried };
          if (note.pathElements.length > 0 && note.merkleRoot) return note;
        } else {
          throw new Error('Note leaf index not yet resolved. Please wait a moment and try again.');
        }
      }
    }

    // Compute path locally from pool state (like the CLI — no relay dependency)
    progressFn('Computing Merkle path...');
    console.log('[ensurePath] Computing path for leaf', note.leafIndex, 'from pool state');

    const denom = BigInt(note.amount);
    const { statePda } = deriveV2PoolPDAs(denom);
    const stateInfo = await connection.getAccountInfo(statePda);
    if (!stateInfo) throw new Error(`Pool state not found for ${Number(denom)/1e9} SOL denomination`);

    const frontier = readFrontierFromState(stateInfo.data as unknown as Uint8Array);
    const { pathElements, pathIndices } = await computeMerklePathFromFrontier(note.leafIndex, frontier);

    // Compute the commitment for root derivation
    const { commitment } = await computeV2CommitmentFromBigInts(
      denom, BigInt(note.nullifier), BigInt(note.secret),
    );
    const commitBigInt = bytesToFieldBE(commitment);
    const root = await computeRootFromPath(commitBigInt, pathElements, pathIndices);
    console.log('[ensurePath] Computed root:', root.substring(0, 16) + '...');

    // Update the note in state + cache so we don't recompute next time
    const updated = { ...note, pathElements, pathIndices, merkleRoot: root };
    if (publicKey) saveNote(publicKey.toBase58(), updated);
    setV2Notes(prev => prev.map(n => n.id === note.id ? updated : n));
    return updated;
  }

  // handleSend removed — V3WithdrawPage handles withdrawals directly

  // ─── Render ───────────────────────────────────────────────────────────────

  const sendBusy = sendPhase === 'checking' || sendPhase === 'proving' || sendPhase === 'submitting';
  const depositBusy = depositPhase === 'signing' || depositPhase === 'confirming' || depositPhase === 'generating';

  return (
    <div className="space-y-0">
      {/* Tab bar */}
      <div className="flex border-b border-zk-border">
        <button
          onClick={() => setMode('deposit')}
          className={`flex-1 py-3.5 text-sm font-medium transition-colors
            ${mode === 'deposit'
              ? 'text-zk-text border-b-2 border-zk-teal'
              : 'text-zk-text-muted hover:text-zk-text'}`}
        >
          Deposit
        </button>
        <button
          onClick={() => setMode('send')}
          className={`flex-1 py-3.5 text-sm font-medium transition-colors
            ${mode === 'send'
              ? 'text-zk-text border-b-2 border-zk-teal'
              : 'text-zk-text-muted hover:text-zk-text'}`}
        >
          Send Privately
        </button>
      </div>

      {/* Private balance */}
      <div className="px-6 pt-4 pb-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-zk-text-muted">Private balance</span>
          {isScanning && (
            <span className="text-xs text-zk-text-muted flex items-center gap-1.5">
              <span className="animate-spin inline-block w-3 h-3 border border-zk-teal border-t-transparent rounded-full" />
              Scanning...
            </span>
          )}
        </div>
        <div className="text-2xl font-semibold text-zk-text mt-0.5">
          {formatSol(totalBalance)} <span className="text-base text-zk-text-muted font-normal">SOL</span>
        </div>
        {unspent.length > 0 && (
          <div className="text-xs text-zk-text-muted mt-0.5">
            {unspent.length} private note{unspent.length !== 1 ? 's' : ''}
          </div>
        )}
      </div>

      {/* Deposit mode */}
      {mode === 'deposit' && (
        <div className="px-6 pb-6 space-y-4">
          {/* Amount input — always visible */}
          {(
          <div>
            <label className="text-xs text-zk-text-muted mb-1.5 block">Amount (SOL)</label>
            <div className="flex gap-2">
              <input
                type="text"
                inputMode="decimal"
                placeholder="0.0"
                value={amountSol}
                onChange={e => { setAmountSol(sanitizeAmountInput(e.target.value)); setDepositError(null); }}
                disabled={depositBusy}
                className="flex-1 bg-zk-surface border border-zk-border rounded-lg px-4 py-3 text-lg text-zk-text
                           placeholder-zk-text-muted focus:outline-none focus:border-zk-teal disabled:opacity-50"
              />
              <div className="flex items-center px-3 bg-zk-surface border border-zk-border rounded-lg text-sm text-zk-text-muted">
                SOL
              </div>
            </div>
            {amountSol && !depositValid && parseFloat(amountSol) > 0 && (
              <p className="text-xs text-red-400 mt-1.5">Minimum deposit: {MIN_DEPOSIT_SOL} SOL</p>
            )}
          </div>
          )}

          {/* Denomination breakdown preview */}
          {depositValid && depositPhase === 'idle' && (() => {
            const splits = greedySplit(depositLamports);
            const grouped: Record<string, number> = {};
            for (const d of splits) {
              const label = `${Number(d) / 1e9} SOL`;
              grouped[label] = (grouped[label] || 0) + 1;
            }
            return (
              <div className="text-xs text-zk-text-muted bg-zk-surface/50 rounded-lg px-3 py-2">
                <span className="text-zk-text-muted/60">You will receive:</span>
                {Object.entries(grouped).map(([label, count]) => (
                  <span key={label} className="ml-2">{label} &times; {count}</span>
                ))}
              </div>
            );
          })()}

          {/* Deposit progress indicator */}
          {depositBusy && (
            <div className="flex items-center gap-2 text-sm text-zk-teal">
              <span className="animate-spin inline-block w-4 h-4 border-2 border-zk-teal border-t-transparent rounded-full" />
              {depositPhase === 'generating' && 'Preparing deposit...'}
              {depositPhase === 'signing' && 'Approve in your wallet...'}
              {depositPhase === 'confirming' && 'Confirming on-chain...'}
            </div>
          )}

          {depositPhase === 'done' && lastDepositedNotes.length > 0 && (
            <div className="space-y-3">
              <div className="text-sm text-emerald-400 bg-emerald-900/20 rounded-lg p-4 text-center">
                <div className="font-medium">Deposit successful</div>
                <div className="text-emerald-400/60 text-xs mt-1">Your funds are now private</div>
              </div>

              <button
                onClick={() => downloadAllNotes(lastDepositedNotes)}
                className="w-full text-sm text-zk-teal hover:text-zk-teal/80 transition-colors py-2.5
                           border border-zk-teal/20 rounded-lg hover:bg-zk-teal/5"
              >
                Backup your funds
              </button>
              <p className="text-xs text-zk-text-muted/60 text-center">
                Required to recover your funds on another device
              </p>

              <div className="flex gap-2">
                <Button onClick={() => { setDepositPhase('idle'); setLastDepositedNotes([]); }} className="flex-1 h-10">
                  Deposit more
                </Button>
                <Button variant="outline" onClick={() => { setDepositPhase('idle'); setLastDepositedNotes([]); setMode('send'); }} className="h-10">
                  Send
                </Button>
              </div>
            </div>
          )}

          {depositPhase === 'done' && lastDepositedNotes.length === 0 && (
            <div className="text-sm text-emerald-400 bg-emerald-900/20 rounded-lg p-3 text-center">
              Deposit confirmed!
            </div>
          )}

          {depositPhase !== 'done' && (
            <Button
              onClick={handleDeposit}
              disabled={!publicKey || !depositValid || depositBusy}
              className="w-full h-12 text-base"
            >
              {depositBusy ? 'Processing...' : 'Deposit'}
            </Button>
          )}
          {depositError && (
            <p className="text-xs text-red-400 bg-red-900/20 rounded-lg p-2.5 break-all">{depositError}</p>
          )}

          {/* Persistent mini summary with collapsible notes panel */}
          {unspent.length > 0 && (
            <div className="mt-4 pt-3 border-t border-zk-border/30">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm text-zk-text font-medium">{formatSol(totalBalance)} SOL</span>
                  <span className="text-xs text-zk-text-muted ml-2">{unspent.length} note{unspent.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowNotesExpanded(!showNotesExpanded)}
                    className="text-xs text-zk-teal hover:text-zk-teal/80 transition-colors"
                  >
                    {showNotesExpanded ? 'Hide notes \u25B2' : 'View notes \u25BC'}
                  </button>
                  <button
                    onClick={() => downloadAllNotes(unspent)}
                    className="text-xs text-zk-text-muted/60 hover:text-zk-text-muted transition-colors"
                  >
                    Backup all
                  </button>
                </div>
              </div>

              {/* Collapsible notes list */}
              {showNotesExpanded && (
                <div className="mt-2 space-y-1 max-h-48 overflow-y-auto">
                  {[...unspent].sort((a, b) => b.leafIndex - a.leafIndex).map(note => (
                    <div key={note.nullifier} className="flex items-center justify-between px-3 py-1.5 bg-zk-surface/50 rounded">
                      <span className="text-xs text-zk-text">
                        {Number(BigInt(note.amount)) / 1e9} SOL
                        <span className="text-zk-text-muted/50 ml-1">#{note.leafIndex}</span>
                      </span>
                      <button
                        onClick={() => downloadNote(note)}
                        className="text-xs text-zk-text-muted/40 hover:text-zk-teal transition-colors"
                      >
                        &#8681;
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Send mode — V3 note-based withdrawal */}
      {mode === 'send' && (
        <div className="px-6 pb-6">
          <V3WithdrawPage
            notes={v2Notes}
            setNotes={setV2Notes}
            onRecoveryScan={handleRecovery}
          />
        </div>
      )}
    </div>
  );
}
