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
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  SystemProgram,
  ComputeBudgetProgram,
  Connection,
} from '@solana/web3.js';
import { Button } from './ui';
import { V2Note } from '@/types/note';
import { Note } from '@/types/note';
import {
  computeCommitmentFromBigInts,
  computeV2CommitmentFromBigInts,
  bytesToFieldBE,
  initPoseidon,
} from '@/lib/sdk/poseidon';
// @ts-ignore — shared v2-core module (same code as CLI)
import { computeBatchMerklePaths } from 'v2-core/merkle';
import { reconcileNotes } from '@/lib/reconcile';
import {
  deriveNoteEncryptionKey,
  getCachedKey,
  encryptV4BinaryMemo,
  encryptV5SeedMemo,
  deriveNoteFromSeed,
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
import { getPoolConfig, getDeployedPools, getAvailableDenominations } from '@/lib/pool-config';
import {
  createSession, markBatchSent, markBatchConfirmed, markBatchNotesSaved,
  markSessionComplete, markSessionFailed, loadIncompleteSession, getSessionSummary, clearSession,
} from '@/lib/deposit-session';

/** Get program ID from loaded pool config (config-driven, not hardcoded). */
function getConfigProgramId(): PublicKey {
  const pools = getDeployedPools();
  if (pools.length > 0) {
    const pc = getPoolConfig(pools[0].id);
    return new PublicKey(pc.programId);
  }
  return V2_PROGRAM_ID; // fallback to hardcoded
}

const MEMO_PROGRAM   = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const MEMO_PREFIX_V3 = 'zerok:v3:';
const RELAY_PUBKEY   = new PublicKey('BEWNKrbVnLuWxPqVLSszwZpC6o86mC8RoSAWDaWwFivq');

const _enc = new TextEncoder();

const MIN_DEPOSIT_SOL = 0.1;
const DEPOSIT_CU = 200_000; // V3 deposit (~80K CU) + safety margin. Memo w/ keys:[] costs only ~5K CU.

// V5 batch planner constants — seed memo replaces N per-note memos with 1 per batch
// With batch deposit instruction: ~25 notes/tx (vs 12 before), max 15 per pool per instruction
const V5_SAFE_CAP = 25;         // theoretical tx-size ceiling; exact-fit planner auto-shrinks if >1232 bytes
// Batch instruction deployed + verified on mainnet (2026-04-09).
// CLI single deposit, batch deposit, and withdrawal all confirmed working.
const BATCH_SAFE_CAP = 15;      // max commitments per batch instruction (Solana heap limit)
const V5_CU_PER_NOTE = 30_000;  // ~24-28K measured per commitment in batch instruction
const V5_CU_OVERHEAD = 50_000;  // memo + compute budget ixs + validation overhead

// ─── Deposit helpers ──────────────────────────────────────────────────────────

/**
 * Pairwise Phantom batch send: process V0 txs in pairs of 2, confirm between pairs.
 *
 * Why pairs: Phantom simulates ALL txs against the same base state. For state-dependent
 * txs (multiple deposits to the same pool), 3+ txs fail because later txs see stale state.
 * 2 txs is the proven safe zone. Confirming between pairs updates on-chain state.
 *
 * Tx cloning: Phantom may mutate VersionedTransaction objects internally. We clone
 * before passing to Phantom so originals remain usable for retries.
 *
 * Popup count: ceil(N/2) popups instead of N.
 */
async function sendWithPairwiseBatching(
  phantomProvider: any,
  v0Txs: VersionedTransaction[],
  sigs: string[],
  sendTransaction: (tx: any, conn: any) => Promise<string>,
  connection: Connection,
  blockhash: string,
  lastValidBlockHeight: number,
): Promise<void> {
  for (let i = 0; i < v0Txs.length; i += 2) {
    const chunk = v0Txs.slice(i, Math.min(i + 2, v0Txs.length));
    const pairIdx = Math.floor(i / 2) + 1;
    const totalPairs = Math.ceil(v0Txs.length / 2);

    if (chunk.length === 2) {
      // Clone txs to prevent Phantom from mutating originals
      const clones = chunk.map(tx => VersionedTransaction.deserialize(tx.serialize()));
      console.log(`[ZeroK] Phantom pair ${pairIdx}/${totalPairs}: signAndSendAll for 2 txs`);
      try {
        const result = await phantomProvider.signAndSendAllTransactions(clones);
        for (const sig of result.signatures) {
          if (sig != null) sigs.push(sig);
        }
      } catch (e: any) {
        if (e?.code === 4001 || e?.message?.includes('User rejected')) throw e;
        console.warn(`[ZeroK] Pair ${pairIdx} failed (${e.message}), sending individually...`);
        // Fall back to sequential for this pair using ORIGINAL (non-mutated) txs
        for (const tx of chunk) {
          const sig = await sendTransaction(tx, connection);
          sigs.push(sig);
        }
      }
    } else {
      // Single remaining tx — use sendTransaction
      console.log(`[ZeroK] Phantom pair ${pairIdx}/${totalPairs}: sendTransaction for 1 tx`);
      const sig = await sendTransaction(chunk[0], connection);
      sigs.push(sig);
    }

    // Confirm this pair before sending next (state must update for next pair's simulation)
    if (i + 2 < v0Txs.length) {
      const pairSigs = sigs.slice(-chunk.length);
      console.log(`[ZeroK] Confirming pair ${pairIdx} before next pair...`);
      for (const sig of pairSigs) {
        await connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
      }
    }
  }
}

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

// V3 batch deposit discriminator: SHA256("global:deposit_batch_v2_clean")[0..8]
async function getBatchDepositDisc(): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    _enc.encode('global:deposit_batch_v2_clean') as unknown as ArrayBuffer,
  );
  return new Uint8Array(buf).slice(0, 8);
}

/**
 * Build a batch deposit instruction: one instruction per pool holding N commitments.
 * Data layout: disc(8) + vec_len(4 LE) + N × commitment(32)
 */
function buildBatchDepositIx(
  programId: PublicKey,
  batchDisc: Uint8Array,
  commitmentsBE: Uint8Array[],
  keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[],
): TransactionInstruction {
  const n = commitmentsBE.length;
  const data = new Uint8Array(8 + 4 + n * 32);
  data.set(batchDisc, 0);
  const view = new DataView(data.buffer);
  view.setUint32(8, n, true); // little-endian vec length
  for (let i = 0; i < n; i++) {
    data.set(commitmentsBE[i], 12 + i * 32);
  }
  return new TransactionInstruction({ programId, keys, data: Buffer.from(data) });
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

/** Resolve V3 pool PDAs + programId + ALT from config for a given denomination. */
function getV3PoolPDAs(denomination: bigint): {
  programId: PublicKey; statePda: PublicKey; vaultPda: PublicKey; rootRingPda: PublicKey;
  metadataPda: PublicKey; shardPdas: PublicKey[]; altAddress: string | undefined;
} {
  const pools = getDeployedPools();
  for (const { id } of pools) {
    const pc = getPoolConfig(id);
    if (BigInt(pc.denominationLamports) === denomination) {
      return {
        programId: new PublicKey(pc.programId),
        statePda: new PublicKey(pc.statePda),
        vaultPda: new PublicKey(pc.vaultPda),
        rootRingPda: new PublicKey(pc.rootRingPda),
        metadataPda: new PublicKey(pc.metadataPda),
        shardPdas: (pc.shardPdas || []).map((s: string) => new PublicKey(s)),
        altAddress: pc.altAddress,
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
  const { publicKey, signTransaction, signAllTransactions, sendTransaction, signMessage, connected } = useWallet();
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
  // Show only withdrawable notes in balance (excludes ghost notes from closed programs)
  const withdrawableNotes = unspent.filter(n => n.withdrawable !== false);
  const totalBalance = withdrawableNotes.reduce((sum, n) => sum + BigInt(n.amount), 0n);
  const staleCount = unspent.length - withdrawableNotes.length;

  // Log balance changes
  useEffect(() => {
    if (v2Notes.length > 0) {
      const inv: Record<string, number> = {};
      for (const n of withdrawableNotes) {
        const label = `${Number(BigInt(n.amount))/1e9}`;
        inv[label] = (inv[label] || 0) + 1;
      }
      console.log(`[ZeroK] Balance: ${Number(totalBalance)/1e9} SOL | ${withdrawableNotes.length} withdrawable notes | ${staleCount > 0 ? staleCount + ' stale | ' : ''}${JSON.stringify(inv)}`);
    }
  }, [totalBalance, withdrawableNotes.length, staleCount]); // eslint-disable-line react-hooks/exhaustive-deps

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

      // Check for incomplete deposit session
      const incomplete = loadIncompleteSession(publicKey.toBase58());
      if (incomplete) {
        const summary = getSessionSummary(incomplete);
        console.log(`[ZeroK] Incomplete deposit session detected: ${summary.depositedSol}/${summary.totalSol} SOL deposited, ${summary.confirmedBatches}/${summary.totalBatches} batches confirmed`);
        // Recovery scan will handle reconstructing notes from on-chain memos
        // Just log for now — the recovery scan below will pick up confirmed batches
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
    console.log('[ZeroK] Program ID:', getConfigProgramId().toBase58());

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
        programId: getConfigProgramId(),
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
    if (!publicKey || !signTransaction || !sendTransaction || !depositValid) return;
    if (depositInFlight.current) return; // Prevent double-click race
    depositInFlight.current = true;
    setDepositError(null);
    setDepositPhase('generating');

    try {
      // Split deposit into denomination-sized pieces using ONLY deployed pool denominations
      const availDenoms = getAvailableDenominations();
      if (availDenoms.length === 0) throw new Error('No pools available — config not loaded');
      const denomSplits = greedySplit(depositLamports, availDenoms);
      // Check for remainder (amount that can't be decomposed into available denominations)
      const totalSplit = denomSplits.reduce((a, b) => a + b, 0n);
      if (totalSplit < depositLamports) {
        const remainder = Number(depositLamports - totalSplit) / 1e9;
        const smallest = Number(availDenoms[availDenoms.length - 1]) / 1e9;
        throw new Error(`Cannot deposit exactly ${Number(depositLamports)/1e9} SOL — ${remainder} SOL remainder is smaller than the minimum pool denomination (${smallest} SOL). Please adjust your amount.`);
      }
      console.log(`[ZeroK] Deposit ${Number(depositLamports)/1e9} SOL → ${denomSplits.length} notes:`, denomSplits.map(d => `${Number(d)/1e9} SOL`));
      const disc = await getDepositV3Disc();
      const batchDisc = await getBatchDepositDisc();
      // Derive encryption key on-demand if not cached (handles case where recovery scan was skipped)
      let aesKey = getCachedKey(publicKey.toBase58());
      if (!aesKey && signMessage) {
        console.log('[ZeroK] Deriving encryption key on-demand...');
        aesKey = await deriveNoteEncryptionKey(publicKey.toBase58(), signMessage);
      }

      // ── V5 Seed Memo: per-batch seed derivation ──────────────────────────────
      // Instead of generating random secrets per-note and encrypting N memos,
      // each batch generates one random seed and derives all note secrets from it.
      // ONE seed memo per batch replaces N per-note memos → fits ~6 notes/tx.
      //
      // IMPORTANT: Batch note order is the original greedySplit order and MUST NEVER
      // be re-sorted. Index 0,1,2... is part of the cryptographic derivation identity.

      // Read pool state BEFORE deposit to get leaf indices + frontiers
      const denomPoolState = new Map<string, { leafCount: number; frontier: string[]; poolPDAs: ReturnType<typeof getV3PoolPDAs>; activeShardIdx: number; shardCapacity: number; nextRootIndex: number; numShards: number }>();
      const uniqueDenoms = [...new Set(denomSplits.map(d => d.toString()))];
      for (const denomStr of uniqueDenoms) {
        const denom = BigInt(denomStr);
        const poolPDAs = getV3PoolPDAs(denom);
        const info = await connection.getAccountInfo(poolPDAs.statePda);
        if (!info) throw new Error(`Pool not found for ${Number(denom)/1e9} SOL`);
        const stateBytes = info.data as unknown as Uint8Array;
        const leafCount = readLeafCountFromState(stateBytes);
        const frontier = readFrontierFromState(stateBytes);
        const activeShardIdx = await readActiveShardIndex(connection, poolPDAs.metadataPda);
        // Read shard rotation params from ring metadata
        const metaInfo = await connection.getAccountInfo(poolPDAs.metadataPda);
        const metaData = metaInfo?.data;
        const shardCapacity = metaData ? (metaData[20] | (metaData[21] << 8) | (metaData[22] << 16) | (metaData[23] << 24)) : 128;
        const numShards = metaData ? (metaData[24] | (metaData[25] << 8) | (metaData[26] << 16) | (metaData[27] << 24)) : 20;
        const nextRootIndex = metaData ? (metaData[28] | (metaData[29] << 8) | (metaData[30] << 16) | (metaData[31] << 24)) : 0;
        denomPoolState.set(denomStr, { leafCount, frontier, poolPDAs, activeShardIdx, shardCapacity, nextRootIndex, numShards });
        console.log(`[ZeroK] Pool ${Number(denom)/1e9} SOL: leafCount=${leafCount}, activeShard=${activeShardIdx}, nextRootIdx=${nextRootIndex}, shardCap=${shardCapacity}`);
      }

      // Get programId bytes for V5 memo context binding
      const programIdPubkey = [...denomPoolState.values()][0]?.poolPDAs.programId;
      const programIdBytes = programIdPubkey ? programIdPubkey.toBytes() : new Uint8Array(4);

      // Network audit log
      console.log('[ZeroK] NETWORK AUDIT:', JSON.stringify({
        hostname: typeof window !== 'undefined' ? window.location.hostname : 'ssr',
        network: detectNetworkFromHostname(),
        programId: programIdPubkey?.toBase58() || 'unknown',
        pools: Object.fromEntries(
          [...denomPoolState.entries()].map(([k, v]) => [`${Number(BigInt(k))/1e9} SOL`, { leafCount: v.leafCount }])
        ),
      }));

      // Fetch ALTs for all pools involved
      const altAddressSet = new Set<string>();
      for (const denomStr of uniqueDenoms) {
        const pool = denomPoolState.get(denomStr)!;
        if (pool.poolPDAs.altAddress) altAddressSet.add(pool.poolPDAs.altAddress);
      }
      const altAccounts: AddressLookupTableAccount[] = [];
      for (const altAddr of altAddressSet) {
        const altResult = await connection.getAddressLookupTable(new PublicKey(altAddr));
        if (altResult.value) altAccounts.push(altResult.value);
      }

      // ── Deterministic V5 Batch Planner ───────────────────────────────────────
      // For each batch: generate seed → derive notes → build deposit ixs + 1 seed memo
      // → build V0 → measure exact size → shrink if needed → accept batch.
      setDepositPhase('signing');
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

      const TX_LIMIT = 1232;
      const HEURISTIC_PER_NOTE = 38;   // ~32 bytes per commitment + amortized batch overhead
      const HEURISTIC_OVERHEAD = 420;  // sig + header + keys + blockhash + compute + ALT + seed memo + batch headers
      const heuristicMax = Math.min(V5_SAFE_CAP,
        Math.max(1, Math.floor((TX_LIMIT - HEURISTIC_OVERHEAD) / HEURISTIC_PER_NOTE)));

      type NoteDataEntry = { denom: bigint; nullifier: bigint; secret: bigint; commitment: Uint8Array; nullifierHash: Uint8Array; commitHex: string; leafIndex: number; pathElements: string[]; pathIndices: number[]; merkleRoot: string };
      type Batch = { notes: NoteDataEntry[]; v0Tx: VersionedTransaction; size: number; seed: Uint8Array };
      const batches: Batch[] = [];
      const allNoteData: NoteDataEntry[] = [];
      let remaining = [...Array(denomSplits.length).keys()]; // indices into denomSplits
      const denomCounters = new Map<string, number>(); // shared leaf index tracking across batches
      // Track cumulative deposits per pool for shard rotation prediction
      const poolDepositsSoFar = new Map<string, number>();

      while (remaining.length > 0) {
        // Select indices respecting BATCH_SAFE_CAP per denomination (on-chain heap limit)
        const maxTotal = Math.min(remaining.length, heuristicMax);
        const selectedIndices: number[] = [];
        {
          const tempCounts = new Map<string, number>();
          for (let r = 0; r < remaining.length && selectedIndices.length < maxTotal; r++) {
            const dk = denomSplits[remaining[r]].toString();
            const cnt = tempCounts.get(dk) || 0;
            if (cnt < BATCH_SAFE_CAP) {
              tempCounts.set(dk, cnt + 1);
              selectedIndices.push(remaining[r]);
            }
          }
        }
        let batchSize = selectedIndices.length;
        const batchSeed = crypto.getRandomValues(new Uint8Array(32));
        let lastFit: Batch | null = null;

        // Shrink until it fits (or reaches 1 note which always fits)
        while (batchSize >= 1) {
          const batchDenomIndices = selectedIndices.slice(0, batchSize);
          const batchDenoms = batchDenomIndices.map(i => denomSplits[i]);

          // Derive notes from batch seed (batch-local indices 0..batchSize-1)
          const batchNotes: NoteDataEntry[] = [];
          // Save/restore denomCounters so shrinking doesn't double-count leaf indices
          const savedCounters = new Map(denomCounters);
          for (let j = 0; j < batchSize; j++) {
            const denom = batchDenoms[j];
            const { nullifier, secret } = await deriveNoteFromSeed(batchSeed, j);
            const { commitment, nullifierHash } = await computeCommitmentFromBigInts(nullifier, secret);
            const commitHex = Array.from(commitment).map(b => b.toString(16).padStart(2, '0')).join('');

            // Assign leaf index from shared counters
            const denomKey = denom.toString();
            const pool = denomPoolState.get(denomKey)!;
            const offset = denomCounters.get(denomKey) || 0;
            const leafIndex = pool.leafCount + offset;
            denomCounters.set(denomKey, offset + 1);

            // Compute provisional Merkle path from pre-deposit frontier
            const { pathElements, pathIndices } = await computeMerklePathFromFrontier(leafIndex, pool.frontier);
            const commitBigInt = bytesToFieldBE(commitment);
            const merkleRoot = await computeRootFromPath(commitBigInt, pathElements, pathIndices);

            batchNotes.push({ denom, nullifier, secret, commitment, nullifierHash, commitHex, leafIndex, pathElements, pathIndices, merkleRoot });
          }

          // Build BATCH deposit instructions (one per pool, NOT one per note)
          // Group notes by denomination → build one deposit_batch_v2_clean per pool
          // Min 200K (single deposit needs ~80-100K + safety margin), scale up for batches
          const cuBudget = Math.min(Math.max(batchSize * V5_CU_PER_NOTE + V5_CU_OVERHEAD, 200_000), 1_400_000);
          console.log(`[ZeroK] CU budget: ${cuBudget} (${batchSize} notes × ${V5_CU_PER_NOTE} + ${V5_CU_OVERHEAD}, floor=200K)`);
          const batchIxs: TransactionInstruction[] = [
            ComputeBudgetProgram.setComputeUnitLimit({ units: cuBudget }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
          ];

          // Group batch notes by denomination
          const denomGroups = new Map<string, NoteDataEntry[]>();
          for (const note of batchNotes) {
            const dk = note.denom.toString();
            if (!denomGroups.has(dk)) denomGroups.set(dk, []);
            denomGroups.get(dk)!.push(note);
          }

          // Build instructions per pool: single deposit for 1 note, batch for 2+
          for (const [denomKey, groupNotes] of denomGroups) {
            const pool = denomPoolState.get(denomKey)!;
            const { programId: poolProgramId, statePda, vaultPda, rootRingPda, metadataPda, shardPdas } = pool.poolPDAs;

            // Compute starting shard for this pool group
            const prevBatchDeposits = poolDepositsSoFar.get(denomKey) || 0;
            const startIdx = pool.nextRootIndex + prevBatchDeposits;
            const startShard = pool.shardCapacity > 0
              ? Math.floor(startIdx / pool.shardCapacity) % pool.numShards
              : pool.activeShardIdx;
            const activeShardPda = shardPdas[startShard] || shardPdas[0];

            const baseKeys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [
              { pubkey: statePda, isSigner: false, isWritable: true },
              { pubkey: vaultPda, isSigner: false, isWritable: true },
              { pubkey: publicKey, isSigner: true, isWritable: true },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
              { pubkey: poolProgramId, isSigner: false, isWritable: false },  // cooldown_config (skip)
              { pubkey: poolProgramId, isSigner: false, isWritable: false },  // user_cooldown (skip)
              { pubkey: rootRingPda, isSigner: false, isWritable: true },     // legacy root_ring
              { pubkey: metadataPda, isSigner: false, isWritable: true },
              { pubkey: activeShardPda, isSigner: false, isWritable: true },
            ];

            if (groupNotes.length === 1) {
              // Single note → use proven deposit_v2_clean (no batch overhead)
              console.log(`[ZeroK] Pool ${Number(denomKey)/1e9} SOL: SINGLE deposit (1 note) → deposit_v2_clean, shard=${startShard}`);
              const data = new Uint8Array(8 + 32 + 7);
              data.set(disc, 0);
              data.set(groupNotes[0].commitment, 8);
              batchIxs.push(new TransactionInstruction({
                programId: poolProgramId,
                keys: baseKeys,
                data: Buffer.from(data),
              }));
            } else {
              // 2+ notes → use deposit_batch_v2_clean (efficient batching)
              const keys = [...baseKeys];

              // Check if batch crosses shard boundary → need next shard in remaining_accounts
              const endIdx = startIdx + groupNotes.length - 1;
              const endShard = pool.shardCapacity > 0
                ? Math.floor(endIdx / pool.shardCapacity) % pool.numShards
                : pool.activeShardIdx;
              const crossesBoundary = startShard !== endShard;
              if (crossesBoundary) {
                const nextShardPda = shardPdas[endShard] || shardPdas[0];
                keys.push({ pubkey: nextShardPda, isSigner: false, isWritable: true });
                console.log(`[ZeroK] Pool ${Number(denomKey)/1e9} SOL: BATCH deposit (${groupNotes.length} notes) → deposit_batch_v2_clean, shard=${startShard}→${endShard} ⚠️ CROSSES BOUNDARY, next_shard_pda added`);
              } else {
                console.log(`[ZeroK] Pool ${Number(denomKey)/1e9} SOL: BATCH deposit (${groupNotes.length} notes) → deposit_batch_v2_clean, shard=${startShard}`);
              }

              const commitmentsBE = groupNotes.map(n => n.commitment);
              batchIxs.push(buildBatchDepositIx(poolProgramId, batchDisc, commitmentsBE, keys));
            }
          }

          // Add ONE V5 seed memo for this batch
          if (aesKey) {
            const memoText = await encryptV5SeedMemo(aesKey, batchSeed, batchDenoms, programIdBytes);
            batchIxs.push(new TransactionInstruction({
              programId: MEMO_PROGRAM,
              keys: [],
              data: Buffer.from(memoText, 'utf8'),
            }));
          }

          // Build V0 and measure exact serialized size
          try {
            const msgV0 = new TransactionMessage({
              payerKey: publicKey,
              recentBlockhash: blockhash,
              instructions: batchIxs,
            }).compileToV0Message(altAccounts.length > 0 ? altAccounts : undefined);
            const v0Tx = new VersionedTransaction(msgV0);
            const size = v0Tx.serialize().length;
            if (size <= TX_LIMIT) {
              lastFit = { notes: batchNotes, v0Tx, size, seed: batchSeed };
              break;
            }
          } catch { /* compilation failed — shrink */ }

          // Restore denomCounters before trying smaller batch
          denomCounters.clear();
          for (const [k, v] of savedCounters) denomCounters.set(k, v);
          batchSize--;
        }

        if (lastFit) {
          batches.push(lastFit);
          allNoteData.push(...lastFit.notes);
          // Update cumulative deposits per pool for shard rotation in subsequent batches
          for (const note of lastFit.notes) {
            const dk = note.denom.toString();
            poolDepositsSoFar.set(dk, (poolDepositsSoFar.get(dk) || 0) + 1);
          }
          // Remove the specific selected indices from remaining (may not be contiguous)
          const usedSet = new Set(selectedIndices.slice(0, lastFit.notes.length));
          remaining = remaining.filter(idx => !usedSet.has(idx));
        } else {
          // Single note must always fit — legacy tx with V4 memo as absolute fallback
          const idx = remaining[0];
          const denom = denomSplits[idx];
          const fallbackSeed = crypto.getRandomValues(new Uint8Array(32));
          const { nullifier, secret } = await deriveNoteFromSeed(fallbackSeed, 0);
          const { commitment, nullifierHash } = await computeCommitmentFromBigInts(nullifier, secret);
          const commitHex = Array.from(commitment).map(b => b.toString(16).padStart(2, '0')).join('');
          const denomKey = denom.toString();
          const pool = denomPoolState.get(denomKey)!;
          const offset = denomCounters.get(denomKey) || 0;
          const leafIndex = pool.leafCount + offset;
          denomCounters.set(denomKey, offset + 1);
          const { pathElements, pathIndices } = await computeMerklePathFromFrontier(leafIndex, pool.frontier);
          const commitBigInt = bytesToFieldBE(commitment);
          const merkleRoot = await computeRootFromPath(commitBigInt, pathElements, pathIndices);
          const noteEntry: NoteDataEntry = { denom, nullifier, secret, commitment, nullifierHash, commitHex, leafIndex, pathElements, pathIndices, merkleRoot };

          // Use V4 memo for single-note fallback
          const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash });
          tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: DEPOSIT_CU }));
          tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }));
          const { programId: poolProgramId, statePda, vaultPda, rootRingPda, metadataPda, shardPdas } = pool.poolPDAs;
          const activeShardPda = shardPdas[pool.activeShardIdx] || shardPdas[0];
          const data = new Uint8Array(8 + 32 + 7);
          data.set(disc, 0);
          data.set(commitment, 8);
          tx.add(new TransactionInstruction({
            programId: poolProgramId,
            keys: [
              { pubkey: statePda, isSigner: false, isWritable: true },
              { pubkey: vaultPda, isSigner: false, isWritable: true },
              { pubkey: publicKey, isSigner: true, isWritable: true },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
              { pubkey: poolProgramId, isSigner: false, isWritable: false },
              { pubkey: poolProgramId, isSigner: false, isWritable: false },
              { pubkey: rootRingPda, isSigner: false, isWritable: true },
              { pubkey: metadataPda, isSigner: false, isWritable: true },
              { pubkey: activeShardPda, isSigner: false, isWritable: true },
            ],
            data: Buffer.from(data),
          }));
          if (aesKey) {
            const v4Memo = await encryptV4BinaryMemo(aesKey, denom, nullifier, secret);
            tx.add(new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(v4Memo, 'utf8') }));
          }
          const legacySize = tx.compileMessage().serialize().length + 65;
          batches.push({ notes: [noteEntry], v0Tx: null as any, size: legacySize, seed: fallbackSeed });
          allNoteData.push(noteEntry);
          remaining = remaining.slice(1);
        }
      }

      // Log batch plan
      const batchSizes = batches.map(b => b.notes.length);
      console.log(`[ZeroK] Deposit plan: ${allNoteData.length} notes in ${batches.length} batch(es) [${batchSizes.join('+')}] — V5 seed memo`);

      // ── Write-before-send: persist deposit session BEFORE sending ──────────
      const walletStr = publicKey.toBase58();
      const programIdStr = [...denomPoolState.values()][0]?.poolPDAs.programId?.toBase58() || '';
      createSession(
        walletStr, programIdStr, depositLamports,
        denomSplits,
        batches.map(b => b.seed),
        batches.map(b => b.notes.map(n => n.denom)),
      );

      // ── Send batches ─────────────────────────────────────────────────────────
      // Phantom path: signAndSendAllTransactions (ONE popup, Phantom controls submission)
      // Non-Phantom path: sequential sendTransaction per batch (1 popup each)
      // IMPORTANT: Do NOT use signAllTransactions + sendRawTransaction — Phantom support
      // (Rory, 2026-04-06) confirmed this triggers Blowfish "malicious dApp" warning.
      const sigs: string[] = [];

      // Detect Phantom provider with batch send support
      const phantomProvider = typeof window !== 'undefined'
        ? (window as any).phantom?.solana
        : null;
      const hasPhantomBatchSend = phantomProvider?.signAndSendAllTransactions
        && phantomProvider?.isPhantom;

      // Collect V0 batch transactions
      const v0Batches = batches.filter(b => b.v0Tx);
      const usePhantomBatch = hasPhantomBatchSend && v0Batches.length > 1;

      console.log(`[ZeroK] Phantom detected: ${!!phantomProvider}, hasSignAndSendAll: ${!!phantomProvider?.signAndSendAllTransactions}, isPhantom: ${!!phantomProvider?.isPhantom}, v0Batches: ${v0Batches.length}, usePhantomBatch: ${usePhantomBatch}`);

      if (usePhantomBatch) {
        // ── Phantom: pairwise batching (pairs of 2, confirm between pairs) ──
        const v0Txs = v0Batches.map(b => b.v0Tx);
        await sendWithPairwiseBatching(phantomProvider, v0Txs, sigs, sendTransaction, connection, blockhash, lastValidBlockHeight);
      } else {
        // ── Non-Phantom or single batch: sequential sendTransaction ──────────
        // IMPORTANT: Confirm between batches that share pool state. Without this,
        // batch N+1's simulation sees stale state from batch N and fails.
        for (let b = 0; b < batches.length; b++) {
          const batch = batches[b];
          const t0 = Date.now();
          console.log(`[ZeroK] Batch ${b+1}/${batches.length}: ${batch.notes.length} notes, ${batch.size} bytes`);
          const sig = await sendTransaction(batch.v0Tx, connection);
          sigs.push(sig);
          console.log(`[ZeroK] Batch ${b+1} sent in ${Date.now() - t0}ms`);
          // Confirm before next batch so state updates on-chain
          if (b + 1 < batches.length) {
            await connection.confirmTransaction(
              { signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
            console.log(`[ZeroK] Batch ${b+1} confirmed, sending next...`);
          }
        }
      }

      // Build note-to-sig mapping: which sig covers which note index
      // Also update session journal with signatures per batch
      const noteToSig = new Map<number, string>();
      let sigIdx = 0;
      for (let bIdx = 0; bIdx < batches.length; bIdx++) {
        const batch = batches[bIdx];
        const sig = sigs[sigIdx++] || sigs[sigs.length - 1];
        for (let ni = 0; ni < batch.notes.length; ni++) {
          const globalIdx = allNoteData.indexOf(batch.notes[ni]);
          noteToSig.set(globalIdx, sig);
        }
        markBatchSent(walletStr, bIdx, sig);
      }

      // Confirm all transactions (use strategy-based overload, not deprecated string overload)
      setDepositPhase('confirming');
      const uniqueSigs = [...new Set(sigs)];
      for (const sig of uniqueSigs) {
        await connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          'confirmed',
        );
        console.log(`[ZeroK] Deposit CONFIRMED: ${sig.substring(0,16)}...`);
        // Mark confirmed in session journal
        for (let bIdx = 0; bIdx < batches.length; bIdx++) {
          const batchSig = sigs[bIdx];
          if (batchSig === sig) markBatchConfirmed(walletStr, bIdx);
        }
      }

      // ── Compute correct Merkle paths using batch simulation ──────────────
      // computeBatchMerklePaths simulates sequential insertions from the PRE-deposit
      // frontier, producing correct (path, root) for EACH note — not just the last.
      // This fixes the InvalidProof bug where computeMerklePathFromFrontier only
      // gives a valid path for the most recently inserted leaf.
      const depositedBatch: V2Note[] = [];
      const poseidon = await initPoseidon();

      // Group notes by pool denomination (preserving insertion order)
      const notesByPool = new Map<string, { notes: NoteDataEntry[]; globalIndices: number[] }>();
      for (let i = 0; i < allNoteData.length; i++) {
        const key = allNoteData[i].denom.toString();
        if (!notesByPool.has(key)) notesByPool.set(key, { notes: [], globalIndices: [] });
        notesByPool.get(key)!.notes.push(allNoteData[i]);
        notesByPool.get(key)!.globalIndices.push(i);
      }

      // For each pool, compute batch paths from PRE-deposit frontier
      for (const [denomStr, { notes: poolNotes, globalIndices }] of notesByPool) {
        const prePool = denomPoolState.get(denomStr)!;
        const commitments = poolNotes.map(nd => bytesToFieldBE(nd.commitment));
        const firstLeafIdx = prePool.leafCount;

        const batchPaths = computeBatchMerklePaths(poseidon, commitments, firstLeafIdx, prePool.frontier);

        for (let i = 0; i < poolNotes.length; i++) {
          const bp = batchPaths[i];
          poolNotes[i].leafIndex = firstLeafIdx + i;
          poolNotes[i].pathElements = bp.pathElements.map((pe: bigint) => pe.toString());
          poolNotes[i].pathIndices = bp.pathIndices;
          poolNotes[i].merkleRoot = bp.root;
        }
      }

      // Build V2Note objects and save
      for (let i = 0; i < allNoteData.length; i++) {
        const nd = allNoteData[i];
        console.log(`[ZeroK] Note created: ${Number(nd.denom)/1e9} SOL, leaf=${nd.leafIndex}, root=${nd.merkleRoot.substring(0,12)}...`);
        const newNote: V2Note = {
          id: nd.commitHex,
          amount: nd.denom.toString(),
          nullifier: nd.nullifier.toString(),
          secret: nd.secret.toString(),
          commitment: nd.commitHex,
          nullifierHash: Array.from(nd.nullifierHash).map(b => b.toString(16).padStart(2, '0')).join(''),
          leafIndex: nd.leafIndex,
          merkleRoot: nd.merkleRoot,
          pathElements: nd.pathElements,
          pathIndices: nd.pathIndices,
          status: 'unspent' as const,
          depositTx: noteToSig.get(i) || sigs[0],
          createdAt: new Date().toISOString(),
          noteVersion: 3,
        };
        depositedBatch.push(newNote);
        saveNote(publicKey.toBase58(), newNote);
        setV2Notes(prev => [...prev, newNote]);
      }

      // Mark all batches as notes-saved in session journal
      for (let bIdx = 0; bIdx < batches.length; bIdx++) {
        markBatchNotesSaved(walletStr, bIdx);
      }
      markSessionComplete(walletStr);

      setLastDepositedNotes(depositedBatch);
      setDepositPhase('done');
      setAmountSol('');
      depositInFlight.current = false;
      // Trigger re-scan to fill in leafIndex + path from on-chain events
      setTimeout(() => handleRecovery(), 2000);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[ZeroK] Deposit FAILED:`, errMsg);
      if (err instanceof Error && err.stack) console.error(`[ZeroK] Stack:`, err.stack);
      // Detect Phantom Lighthouse/Blowfish guard blocking (error 0x1900 on state PDA size)
      if (errMsg.includes('0x1900') || errMsg.includes('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95')) {
        console.error(`[ZeroK] ⚠️ BLOWFISH/PHANTOM BLOCK DETECTED`);
        setDepositError(
          'Phantom\'s security scanner blocked this transaction (known issue with new protocols). ' +
          'Please use Solflare wallet instead, or enable Phantom\'s "Testnet Mode" in Settings \u2192 Developer Settings.'
        );
      } else {
        setDepositError(errMsg);
      }
      setDepositPhase('error');
      depositInFlight.current = false;
      // Mark session as failed (but don't clear — recovery can still use it)
      if (publicKey) markSessionFailed(publicKey.toBase58());
    }
  }

  // ─── Send (withdraw) handler ──────────────────────────────────────────────

  function pickNote(minBalance: bigint): V2Note | null {
    // Only pick from withdrawable notes (excludes ghost notes from closed programs)
    return withdrawableNotes.find(n => BigInt(n.amount) >= minBalance && n.pathElements.length > 0)
        ?? withdrawableNotes.find(n => BigInt(n.amount) >= minBalance && n.leafIndex >= 0)
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
        {withdrawableNotes.length > 0 && (
          <div className="text-xs text-zk-text-muted mt-0.5">
            {withdrawableNotes.length} private note{withdrawableNotes.length !== 1 ? 's' : ''}
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

          {/* Denomination breakdown preview — uses deployed pool denominations only */}
          {depositValid && depositPhase === 'idle' && (() => {
            const availDenoms = getAvailableDenominations();
            if (availDenoms.length === 0) return null;
            const splits = greedySplit(depositLamports, availDenoms);
            const totalSplit = splits.reduce((a, b) => a + b, 0n);
            const hasRemainder = totalSplit < depositLamports;
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
                {hasRemainder && (
                  <span className="ml-2 text-red-400">
                    ({Number(depositLamports - totalSplit) / 1e9} SOL cannot be deposited — below minimum pool size)
                  </span>
                )}
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
          {withdrawableNotes.length > 0 && (
            <div className="mt-4 pt-3 border-t border-zk-border/30">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm text-zk-text font-medium">{formatSol(totalBalance)} SOL</span>
                  <span className="text-xs text-zk-text-muted ml-2">{withdrawableNotes.length} note{withdrawableNotes.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowNotesExpanded(!showNotesExpanded)}
                    className="text-xs text-zk-teal hover:text-zk-teal/80 transition-colors"
                  >
                    {showNotesExpanded ? 'Hide notes \u25B2' : 'View notes \u25BC'}
                  </button>
                  <button
                    onClick={() => downloadAllNotes(withdrawableNotes)}
                    className="text-xs text-zk-text-muted/60 hover:text-zk-text-muted transition-colors"
                  >
                    Backup all
                  </button>
                </div>
              </div>

              {/* Collapsible notes list */}
              {showNotesExpanded && (
                <div className="mt-2 space-y-1 max-h-48 overflow-y-auto">
                  {[...withdrawableNotes].sort((a, b) => b.leafIndex - a.leafIndex).map(note => (
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
