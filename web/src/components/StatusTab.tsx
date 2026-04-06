'use client';

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { Connection, PublicKey } from '@solana/web3.js';
import { Card, Button } from './ui';
import { Note, NoteHealth, V2Note } from '@/types/note';
import { calculateNoteHealth, loadEncryptedBlobs } from '@/lib/note-storage';
import { deriveNoteEncryptionKey, decryptNote, decryptBatchMemo } from '@/lib/note-encryption';
import { parseDepositEvent, parseDepositEventFromLogs, parseV2DepositEventFromLogs, parseV2WithdrawEventFromLogs } from '@/lib/deposit-event';
import { computeMerklePathFromCommitments, batchCheckV2NotesSpent } from '@/lib/sdk/poseidon';
import { formatSol, getPoolConfig, isPoolDeployed, getDeployedPools } from '@/lib/pool-config';
import { getFullNoteStatuses, batchCheckNotesSpent, FullNoteStatus } from '@/lib/on-chain-status';
import { executeWithRotation, getScanEndpoint } from '@/lib/resilient-connection';
import { recoverFromPool } from '@/lib/note-recovery';
import { clearScanCheckpoint } from '@/lib/note-cache';
import WithdrawBar from './WithdrawBar';
import V2WithdrawPanel from './V2WithdrawPanel';
import { getCachedKey } from '@/lib/note-encryption';

// ── Memo recovery constants ───────────────────────────────────────────────────

const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const MEMO_PREFIX     = 'zerok:v1:';
const MEMO_PREFIX_V2  = 'zerok:v2:';
const MEMO_PREFIX_BATCH = 'zerok:v2:b:';
const SPENT_CACHE_KEY = 'zerok-spent-v1';

/** Persist spent/expired commitment hashes to avoid re-checking them on reconnect. */
function loadSpentCache(): Set<string> {
  try {
    const raw = localStorage.getItem(SPENT_CACHE_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch { return new Set(); }
}
function saveSpentCache(cache: Set<string>) {
  try { localStorage.setItem(SPENT_CACHE_KEY, JSON.stringify([...cache])); } catch { /* ignore */ }
}

/** Extract zerok:v1:<blob> from a raw transaction — instructions first, logs as fallback. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractMemoFromRawTx(tx: any): string | null {
  const msg = tx?.transaction?.message;
  if (msg) {
    const accounts: string[] = (msg.accountKeys || msg.staticAccountKeys || [])
      .map((k: unknown) => typeof k === 'string' ? k : String(k));
    const memoIdx = accounts.indexOf(MEMO_PROGRAM_ID);
    if (memoIdx !== -1) {
      for (const ix of (msg.instructions || msg.compiledInstructions || [])) {
        if ((ix.programIdIndex ?? ix.programIndex) !== memoIdx) continue;
        const text = typeof ix.data === 'string'
          ? Buffer.from(ix.data, 'base64').toString('utf8')
          : Buffer.from(ix.data).toString('utf8');
        if (text.startsWith(MEMO_PREFIX)) return text.slice(MEMO_PREFIX.length);
      }
    }
  }
  // Fallback: log parsing
  for (const log of (tx?.meta?.logMessages ?? []) as string[]) {
    const idx = log.indexOf(MEMO_PREFIX);
    if (idx === -1) continue;
    let blob = log.slice(idx + MEMO_PREFIX.length);
    if (blob.endsWith('"')) blob = blob.slice(0, -1);
    return blob;
  }
  return null;
}

/**
 * Extract zerok:v2: or zerok:v2:b: memo from a raw tx.
 * Returns the FULL memo text (including prefix) so the caller can detect
 * batch vs single format and route to the correct decryptor.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractV2MemoFromRawTx(tx: any): string | null {
  const msg = tx?.transaction?.message;
  if (msg) {
    const accounts: string[] = (msg.accountKeys || msg.staticAccountKeys || [])
      .map((k: unknown) => typeof k === 'string' ? k : String(k));
    const memoIdx = accounts.indexOf(MEMO_PROGRAM_ID);
    if (memoIdx !== -1) {
      for (const ix of (msg.instructions || msg.compiledInstructions || [])) {
        if ((ix.programIdIndex ?? ix.programIndex) !== memoIdx) continue;
        const text = typeof ix.data === 'string'
          ? Buffer.from(ix.data, 'base64').toString('utf8')
          : Buffer.from(ix.data).toString('utf8');
        // Return full text for both batch (zerok:v2:b:) and single (zerok:v2:) memos
        if (text.startsWith(MEMO_PREFIX_V2)) return text;
      }
    }
  }
  for (const log of (tx?.meta?.logMessages ?? []) as string[]) {
    const idx = log.indexOf(MEMO_PREFIX_V2);
    if (idx === -1) continue;
    let fullMemo = log.slice(idx);
    if (fullMemo.endsWith('"')) fullMemo = fullMemo.slice(0, -1);
    return fullMemo;
  }
  return null;
}

// v2 program ID for nullifier PDA derivation
const V2_PROGRAM_ID_STR = 'HVcTokFF4rwvcU7sC7GjS317CSf7QDgfCvW7edijKS2v';

/** Normalize base64(32 bytes BE) or decimal string to decimal BigInt string. */
function toDecimal(v: string): string {
  if (!v) return '0';
  if (v.length === 44 && /^[A-Za-z0-9+/]+=*$/.test(v)) {
    const hex = Array.from(atob(v)).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    return BigInt('0x' + hex).toString();
  }
  return v;
}

/**
 * Scan wallet tx history for zerok:v2: memo-embedded notes.
 *
 * Three-phase recovery:
 *   Phase A: Decrypt memos + parse on-chain events → get leafIndex, merkleRoot
 *   Phase B: Batch nullifier spent-check → filter to unspent notes
 *   Phase C: Compute Merkle paths for unspent notes → ready to withdraw
 *
 * After this function, every returned V2Note has complete data for withdrawal
 * (or is marked spent). No CLI fallback needed.
 */
async function scanV2WalletMemos(
  publicKey: { toBase58: () => string },
  key: CryptoKey,
  scanConn: Connection,
  prefetchedSigs: { signature: string; memo?: string | null }[] | null,
): Promise<V2Note[]> {
  const rawSigs = prefetchedSigs ?? await scanConn
    .getSignaturesForAddress(new PublicKey(publicKey.toBase58()), { limit: 1000 })
    .catch(() => [] as { signature: string; memo?: string | null }[]);
  if (!rawSigs.length) return [];

  const memoSupported = rawSigs.some(s => s.memo != null);
  const candidates = memoSupported
    ? rawSigs.filter(s => s.memo != null && s.memo.includes(MEMO_PREFIX_V2))
    : rawSigs.slice(0, 50);
  if (memoSupported && !candidates.length) return [];

  // Fetch full tx data (needed for both memo decryption AND event parsing)
  const BATCH = 10;
  const txResults: unknown[] = [];
  for (let b = 0; b < candidates.length; b += BATCH) {
    const chunk = candidates.slice(b, b + BATCH);
    const results = await Promise.all(
      chunk.map(s =>
        scanConn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null)
      )
    );
    txResults.push(...results);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase A: Decrypt memos + parse on-chain events
  // ═══════════════════════════════════════════════════════════════════════════

  const recovered: V2Note[] = [];
  for (let i = 0; i < candidates.length; i++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const txAny = txResults[i] as any;
    if (!txAny?.meta) continue;

    // Decrypt memo → get secrets (handles both single and batch formats)
    const fullMemo = extractV2MemoFromRawTx(txAny);
    if (!fullMemo) continue;

    // Batch re-denomination memo (zerok:v2:b:)
    if (fullMemo.startsWith(MEMO_PREFIX_BATCH)) {
      const batch = await decryptBatchMemo(fullMemo, key);
      if (batch?.isBatch) {
        for (const bn of batch.notes) {
          recovered.push({
            id:           bn.nullifier,
            amount:       bn.amount,
            nullifier:    bn.nullifier,
            secret:       bn.secret,
            commitment:   '',
            nullifierHash: '',
            leafIndex:    bn.leafIndex,
            merkleRoot:   '',
            pathElements: [],
            pathIndices:  [],
            status:       'unspent' as const,
            depositTx:    candidates[i].signature,
            createdAt:    new Date().toISOString(),
          });
        }
      }
      continue;
    }

    // Single deposit/withdrawal memo (zerok:v2:)
    const encBlob = fullMemo.slice(MEMO_PREFIX_V2.length);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = await decryptNote(encBlob, key) as any;
    if (!raw?.n || !raw?.a) continue;

    const nullifier = toDecimal(String(raw.n));
    const secret    = toDecimal(String(raw.s));
    const amount    = String(raw.a);

    // Parse on-chain event from the SAME tx's logs → get leafIndex + root
    const logs: string[] = txAny.meta.logMessages ?? [];
    let leafIndex = Number(raw.i ?? -1);
    let merkleRoot = '';

    const depEvent = await parseV2DepositEventFromLogs(logs);
    if (depEvent) {
      leafIndex = depEvent.leafIndex;
      merkleRoot = depEvent.newRoot;
    } else {
      const wdEvent = await parseV2WithdrawEventFromLogs(logs);
      if (wdEvent) {
        leafIndex = wdEvent.leafIndex;
        merkleRoot = wdEvent.newRoot;
      }
    }

    recovered.push({
      id:           String(raw.c ?? nullifier),
      amount,
      nullifier,
      secret,
      commitment:   String(raw.c ?? ''),
      nullifierHash: '',
      leafIndex,
      merkleRoot,
      pathElements: [],
      pathIndices:  [],
      status:       'unspent' as const,
      depositTx:    candidates[i].signature,
      createdAt:    new Date().toISOString(),
    });
  }

  if (!recovered.length) return [];

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase B: Nullifier spent-check
  // ═══════════════════════════════════════════════════════════════════════════

  try {
    const programId = new PublicKey(V2_PROGRAM_ID_STR);
    const spentFlags = await batchCheckV2NotesSpent(scanConn, recovered, programId);
    for (let i = 0; i < recovered.length; i++) {
      if (spentFlags[i]) recovered[i].status = 'spent';
    }
  } catch (err) {
    console.warn('[Recovery] v2 spent-check failed (non-fatal):', err);
  }

  const unspent = recovered.filter(n => n.status === 'unspent');
  if (!unspent.length) return recovered; // all spent, no path computation needed

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase C: Compute Merkle paths for unspent notes
  // ═══════════════════════════════════════════════════════════════════════════

  // Check which notes already have valid paths (root still in pool history)
  const needPaths = unspent.filter(n => n.leafIndex >= 0 && n.pathElements.length === 0);
  if (!needPaths.length) return recovered;

  try {
    // Fetch pool state for root-history check
    const v2Enc = new TextEncoder();
    const [statePda] = PublicKey.findProgramAddressSync(
      [v2Enc.encode('zerok_v2')],
      new PublicKey(V2_PROGRAM_ID_STR),
    );
    const poolInfo = await scanConn.getAccountInfo(statePda);
    if (!poolInfo) {
      console.warn('[Recovery] v2 pool state not found — skipping path computation');
      return recovered;
    }

    // Fetch all pool commitments (for tree rebuild)
    // Scan pool's tx history (not user's — pool has ALL deposits/withdrawals)
    const allSigs = await scanConn
      .getSignaturesForAddress(statePda, { limit: 1000 })
      .catch(() => []);

    const commitments: bigint[] = [];
    const sigBatches: string[][] = [];
    for (let b = 0; b < allSigs.length; b += BATCH) {
      sigBatches.push(allSigs.slice(b, b + BATCH).map(s => s.signature));
    }

    for (const batch of sigBatches) {
      const txs = await Promise.all(
        batch.map(sig =>
          scanConn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null)
        )
      );
      for (const tx of txs) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const txData = tx as any;
        if (!txData?.meta?.logMessages) continue;
        const txLogs: string[] = txData.meta.logMessages;

        const dep = await parseV2DepositEventFromLogs(txLogs);
        if (dep) {
          commitments[dep.leafIndex] = BigInt('0x' + dep.commitment);
        }
        const wd = await parseV2WithdrawEventFromLogs(txLogs);
        if (wd) {
          commitments[wd.leafIndex] = BigInt('0x' + wd.outCommitment);
        }
      }
    }

    // Fill any gaps with zero (shouldn't happen, but safety)
    for (let i = 0; i < commitments.length; i++) {
      if (commitments[i] === undefined) commitments[i] = 0n;
    }

    // Compute paths for all notes needing them (memoized — efficient for batch)
    for (const note of needPaths) {
      if (note.leafIndex < 0 || note.leafIndex >= commitments.length) continue;
      try {
        const { pathElements, pathIndices, computedRoot } =
          await computeMerklePathFromCommitments(commitments, note.leafIndex);
        note.pathElements = pathElements;
        note.pathIndices  = pathIndices;
        note.merkleRoot   = computedRoot;
      } catch (err) {
        console.warn(`[Recovery] Path computation failed for leaf ${note.leafIndex}:`, err);
      }
    }
  } catch (err) {
    console.warn('[Recovery] v2 path computation failed (non-fatal):', err);
  }

  return recovered;
}

/**
 * Scan this wallet's full tx history for ZeroK Memo-embedded notes.
 *
 * - Uses getSignaturesForAddress via executeWithRotation (Helius/Alchemy populate sig.memo)
 * - sig.memo prefilter: with a good RPC endpoint, only zerok txs are fetched (fast)
 * - Fallback: when sig.memo is unavailable, checks 50 most recent txs
 * - No cursor — always scans up to 1000 txs (cheap because sig.memo prefilters fetch calls)
 * - Only decryptable by the wallet that made the deposit (AES-256-GCM with wallet-derived key)
 */
async function scanWalletMemos(
  publicKey: { toBase58: () => string },
  key: CryptoKey,
  scanConn: Connection,
  prefetchedSigs: { signature: string; memo?: string | null }[] | null,
): Promise<Note[]> {
  // Use pre-fetched sigs when available (fetched during Phantom popup — zero extra wait).
  // Fall back to fetching now only if pre-fetch failed.
  let rawSigs: { signature: string; memo?: string | null }[];
  if (prefetchedSigs) {
    rawSigs = prefetchedSigs;
  } else {
    try {
      rawSigs = await scanConn.getSignaturesForAddress(new PublicKey(publicKey.toBase58()), { limit: 1000 });
    } catch {
      rawSigs = await executeWithRotation(conn =>
        conn.getSignaturesForAddress(new PublicKey(publicKey.toBase58()), { limit: 1000 })
      );
    }
  }
  if (rawSigs.length === 0) return [];

  // Prefilter: paid endpoints populate sig.memo — use it to skip non-zerok txs entirely.
  // Fallback: when sig.memo is null (public endpoint), check 50 most recent txs.
  const memoSupported = rawSigs.some(s => s.memo != null);
  const candidateSigs = memoSupported
    ? rawSigs.filter(s => s.memo != null && s.memo.includes(MEMO_PREFIX))
    : rawSigs.slice(0, 50);
  if (memoSupported && candidateSigs.length === 0) return [];

  // Fetch candidate txs in parallel batches of 10.
  // Parallel within each batch (fast), batched to avoid overwhelming the endpoint.
  // With Alchemy (25+ req/sec limit): 10 parallel = ~200ms/batch vs 5s sequential per batch.
  const BATCH = 10;
  const txResults: unknown[] = [];
  for (let b = 0; b < candidateSigs.length; b += BATCH) {
    const chunk = candidateSigs.slice(b, b + BATCH);
    const chunkResults = await Promise.all(
      chunk.map(sig =>
        scanConn.getTransaction(sig.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
          .catch(() => null)
      )
    );
    txResults.push(...chunkResults);
  }

  // Helper: ensure hex values have 0x prefix (withdrawal.ts uses BigInt() on these fields)
  const hex = (s: string) => s.startsWith('0x') ? s : `0x${s}`;

  const recovered: Note[] = [];
  for (let i = 0; i < candidateSigs.length; i++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const txAny = txResults[i] as any;
    if (!txAny?.meta) continue;

    const encBlob = extractMemoFromRawTx(txAny);
    if (!encBlob) continue;

    // Decrypt — only succeeds for this wallet's key (AES-GCM auth tag rejects wrong key)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = await decryptNote(encBlob, key) as any;
    if (!raw?.n) continue; // not a compact zerok Memo (or wrong wallet)

    // Skip notes from pools that no longer exist in the current config (old deployments)
    if (!isPoolDeployed(String(raw.p))) {
      console.warn('[Recovery] Skipping note from unknown pool:', raw.p);
      continue;
    }

    // Parse Merkle path from deposit event in the SAME tx (no extra RPC call)
    const merkle = parseDepositEventFromLogs(txAny.meta.logMessages ?? []);
    if (!merkle) continue;

    recovered.push({
      id: String(raw.c),             // no 0x — matches fresh deposit id format for dedup
      poolId: String(raw.p),
      commitment: hex(String(raw.c)),
      nullifierSecret: hex(String(raw.n)),  // FIX: plain hex → 0x-prefixed; BigInt() requires it
      noteSecret: hex(String(raw.s)),        // FIX: plain hex → 0x-prefixed; BigInt() requires it
      nullifierHash: hex(String(raw.h)),
      leafIndex: merkle.leafIndex,
      rootAfter: merkle.rootAfter,
      siblings: merkle.siblings,
      depositTx: candidateSigs[i].signature,
      createdAt: new Date().toISOString(),
      status: 'confirmed',
    });
  }

  return recovered;
}

interface LoadedNote {
  note: Note;
  health: NoteHealth;
  selected: boolean;
  status: 'checking' | 'ready' | 'expiring' | 'spent' | 'expired' | 'error';
  error?: string;
}

export default function StatusTab({ depositTrigger = 0, freshNotes = [], onKeyReady }: { depositTrigger?: number; freshNotes?: Note[]; onKeyReady?: () => void }) {
  const { publicKey, signMessage, connected } = useWallet();
  const { connection } = useConnection();

  const [loadedNotes, setLoadedNotes] = useState<LoadedNote[]>([]);
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);
  const [pendingNotes, setPendingNotes] = useState<Note[]>([]);
  const [isRecovering, setIsRecovering] = useState(false);
  // v2 JoinSplit notes (arbitrary amounts, recovered from zerok:v2: memos)
  const [v2Notes, setV2Notes] = useState<V2Note[]>([]);

  // Single-flight guard: prevent concurrent status check requests
  const statusCheckInFlight = useRef(false);
  // Single-flight guard: prevent concurrent wallet recovery scans
  const recoveryInFlight = useRef(false);

  // Check on-chain status when new notes are added
  useEffect(() => {
    if (pendingNotes.length === 0) return;

    // Single-flight guard: skip if a check is already in progress
    if (statusCheckInFlight.current) {
      console.log('[StatusTab] Skipping status check - already in flight');
      return;
    }

    const checkStatuses = async () => {
      statusCheckInFlight.current = true;
      setIsCheckingStatus(true);
      try {
        const statuses = await getFullNoteStatuses(pendingNotes);

        // Convert to LoadedNote format
        const newLoadedNotes: LoadedNote[] = pendingNotes.map((note, index) => {
          const status = statuses[index];
          return {
            note,
            health: status.health,
            selected: false,
            status: status.finalStatus,
            error: status.error,
          };
        });

        setLoadedNotes(prev => {
          // Filter out duplicates
          const existingIds = new Set(prev.map(n => n.note.id));
          const uniqueNew = newLoadedNotes.filter(n => !existingIds.has(n.note.id));
          return [...prev, ...uniqueNew];
        });

        // Persist spent/expired commitments so future reconnects skip their RPC checks
        const spentCache = loadSpentCache();
        let cacheUpdated = false;
        for (const ln of newLoadedNotes) {
          if (ln.status === 'spent' || ln.status === 'expired') {
            spentCache.add(ln.note.commitment);
            cacheUpdated = true;
          }
        }
        if (cacheUpdated) saveSpentCache(spentCache);
      } catch (error) {
        console.error('Failed to check note statuses:', error);
        // Add notes with 'error' status if check fails
        const errorNotes: LoadedNote[] = pendingNotes.map(note => {
          const poolConfig = getPoolConfig(note.poolId);
          return {
            note,
            health: calculateNoteHealth(note.leafIndex, 0, poolConfig.ringCapacity),
            selected: false,
            status: 'error' as const,
            error: error instanceof Error ? error.message : 'Failed to check status',
          };
        });
        setLoadedNotes(prev => {
          const existingIds = new Set(prev.map(n => n.note.id));
          const uniqueNew = errorNotes.filter(n => !existingIds.has(n.note.id));
          return [...prev, ...uniqueNew];
        });
      } finally {
        statusCheckInFlight.current = false;
        setIsCheckingStatus(false);
        setPendingNotes([]);
      }
    };

    checkStatuses();
  }, [pendingNotes]);

  // Refresh all notes' status
  const refreshStatuses = useCallback(async () => {
    if (loadedNotes.length === 0) return;

    // Single-flight guard: skip if a check is already in progress
    if (statusCheckInFlight.current) {
      console.log('[StatusTab] Skipping refresh - already in flight');
      return;
    }

    statusCheckInFlight.current = true;
    setIsCheckingStatus(true);
    try {
      // Skip spent/expired — their on-chain status is immutable, re-checking wastes RPC calls
      const activeNotes = loadedNotes.filter(n => n.status !== 'spent' && n.status !== 'expired');
      if (activeNotes.length === 0) return;

      const notes = activeNotes.map(n => n.note);
      const statuses = await getFullNoteStatuses(notes);

      setLoadedNotes(prev => prev.map(item => {
        if (item.status === 'spent' || item.status === 'expired') return item;
        const idx = activeNotes.findIndex(n => n.note.id === item.note.id);
        if (idx === -1) return item;
        const status = statuses[idx];
        return { ...item, health: status.health, status: status.finalStatus, error: status.error };
      }));
    } catch (error) {
      console.error('Failed to refresh statuses:', error);
    } finally {
      statusCheckInFlight.current = false;
      setIsCheckingStatus(false);
    }
  }, [loadedNotes]);

  // Auto-scan: always derive key + scan on wallet connect (one signMessage popup per session).
  // This ensures the key is cached BEFORE any deposit, so every deposit gets a Memo written.
  // Recovery from any device: connect → sign once → notes appear from on-chain Memo scan.
  //
  // !!signMessage is included in deps because StatusTab mounts while the wallet adapter is
  // still initializing — connected+publicKey arrive before signMessage. Without this dep,
  // the effect fires early (returns at !signMessage guard) and never re-runs after signMessage
  // becomes available, leaving notes invisible until the user manually clicks "Load my notes".
  useEffect(() => {
    if (!connected || !publicKey || !signMessage) return;
    handleWalletRecovery();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, publicKey?.toBase58(), !!signMessage]);

  // Re-scan after each deposit to pick up Memo-based notes (if key is cached)
  useEffect(() => {
    if (!depositTrigger || !connected || !publicKey || !signMessage) return;
    handleWalletRecovery();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depositTrigger]);

  // Directly inject freshly deposited notes — no scan needed, always immediate.
  // This ensures notes appear right after deposit regardless of whether a Memo was written.
  useEffect(() => {
    if (!freshNotes.length) return;
    setPendingNotes(prev => {
      const existing = new Set(prev.map(n => n.id));
      return [...prev, ...freshNotes.filter(n => !existing.has(n.id))];
    });
  }, [freshNotes]);

  // Calculate totals - each note uses its own pool's denomination
  const { availableNotes, selectedNotes, selectedBalance, totalBalance } = useMemo(() => {
    const available = loadedNotes.filter(n => n.status === 'ready' || n.status === 'expiring');
    const selected = loadedNotes.filter(n => n.selected);

    // Sum up balances using each note's pool denomination
    const selectedBal = selected.reduce((sum, item) => {
      const poolConfig = getPoolConfig(item.note.poolId);
      return sum + BigInt(poolConfig.denominationLamports);
    }, 0n);

    const totalBal = available.reduce((sum, item) => {
      const poolConfig = getPoolConfig(item.note.poolId);
      return sum + BigInt(poolConfig.denominationLamports);
    }, 0n);

    return {
      availableNotes: available,
      selectedNotes: selected.map(n => n.note),
      selectedBalance: selectedBal,
      totalBalance: totalBal,
    };
  }, [loadedNotes]);

  // Recover notes from wallet encryption key.
  // Algorithm:
  //   1. Sign message → derive AES key (one popup, cached for session)
  //   2. Merge localStorage blobs + relay blobs
  //   3. Decrypt each blob — successes are this wallet's notes
  //   4. Re-fetch Merkle path from depositTx for each recovered note
  //   5. Add to pending notes → existing status-check pipeline handles the rest
  const handleWalletRecovery = useCallback(async () => {
    if (!publicKey || !signMessage) return;
    if (recoveryInFlight.current) return; // already scanning — don't fire again
    recoveryInFlight.current = true;

    setIsRecovering(true);

    try {
      // Start signature fetch BEFORE the Phantom popup — no key needed to fetch sigs.
      // User takes ~1-2s to read + approve Phantom; this overlaps that wait with the RPC call.
      const scanConn = new Connection(getScanEndpoint(), { commitment: 'confirmed', disableRetryOnRateLimit: true });
      const sigsPromise = scanConn
        .getSignaturesForAddress(new PublicKey(publicKey.toBase58()), { limit: 1000 })
        .catch(() => null);

      // Step 1: derive key — triggers Phantom popup (sig fetch runs concurrently)
      const key = await deriveNoteEncryptionKey(publicKey.toBase58(), signMessage);
      onKeyReady?.(); // unlock DepositCard — key is now cached, every deposit will get a Memo

      // Step 2a: localStorage blobs (synchronous, ~0ms)
      // Relay omitted — it's in-memory and resets on every Railway deploy, so it's rarely useful.
      // Memo recovery (step 2b) and localStorage cover all real-world recovery cases.
      const localBlobs = loadEncryptedBlobs();

      // Step 2b: scan wallet tx history for Memo-embedded notes (durable path — cross-device).
      // Sigs were already fetched during the Phantom popup — pass them in to skip the wait.
      const prefetchedSigs = await sigsPromise;
      const memoScanPromise = scanWalletMemos(publicKey, key, scanConn, prefetchedSigs).catch(err => {
        console.warn('[Recovery] Memo scan failed (non-fatal):', err);
        return [] as Note[];
      });

      // v2 scan runs in parallel — no extra RPC calls needed (reuses prefetchedSigs)
      const v2ScanPromise = scanV2WalletMemos(publicKey, key, scanConn, prefetchedSigs).catch(err => {
        console.warn('[Recovery] v2 memo scan failed (non-fatal):', err);
        return [] as V2Note[];
      });

      // V3 pool scan: scan each pool's statePda instead of user's wallet.
      // Much faster for power users — scans only ZeroK deposits, not all wallet activity.
      // Runs in parallel with v1/v2 wallet scans.
      const v3ScanPromise = (async (): Promise<V2Note[]> => {
        const pools = getDeployedPools();
        const allV3Notes: V2Note[] = [];
        for (const { id: poolId } of pools) {
          try {
            const pc = getPoolConfig(poolId);
            const notes = await recoverFromPool(scanConn, {
              poolId: pc.poolId,
              statePda: pc.statePda,
              programId: pc.programId,
              denominationLamports: String(pc.denominationLamports),
            }, publicKey.toBase58(), key);
            allV3Notes.push(...notes);
          } catch (err) {
            console.warn(`[Recovery] V3 pool scan failed for ${poolId} (non-fatal):`, err);
          }
        }
        return allV3Notes;
      })().catch(err => {
        console.warn('[Recovery] V3 pool scan failed (non-fatal):', err);
        return [] as V2Note[];
      });

      // Step 3: decrypt localStorage blobs
      const recoveredPartials: Array<Partial<Note>> = [];
      for (const [, blob] of Object.entries(localBlobs)) {
        const decrypted = await decryptNote(blob, key);
        if (decrypted) recoveredPartials.push(decrypted);
      }

      // Wait for v1, v2, and v3 scans (all launched in parallel above)
      const memoNotes = await memoScanPromise;
      const v2Recovered = await v2ScanPromise;
      const v3Recovered = await v3ScanPromise;

      // Merge V2 + V3 into v2Notes state (V3 uses same V2Note type)
      const allV2V3 = [...v2Recovered, ...v3Recovered];
      if (allV2V3.length > 0) {
        setV2Notes(prev => {
          const existing = new Set(prev.map(n => n.id));
          return [...prev, ...allV2V3.filter(n => !existing.has(n.id))];
        });
      }

      // Step 3.5: pre-filter relay/local partials before any RPC work.
      // Skip: cached-spent, already-loaded, duplicates from Memo scan.
      const memoCommitments = new Set(memoNotes.map(n => n.commitment));
      const spentCache = loadSpentCache();
      const candidatePartials = recoveredPartials.filter(partial => {
        if (!partial.commitment || !partial.nullifierHash || !partial.poolId || !partial.depositTx) return false;
        const c = partial.commitment.replace('0x', '');
        if (spentCache.has(partial.commitment) || spentCache.has(c)) return false;
        if (memoCommitments.has(partial.commitment) || memoCommitments.has(c)) return false;
        if (loadedNotes.some(n => n.note.commitment === partial.commitment || n.note.commitment === c)) return false;
        if (pendingNotes.some(n => n.commitment === partial.commitment || n.commitment === c)) return false;
        return true;
      });

      // Step 3.6: batch-check spent status for candidates (1 RPC call total).
      // Only fetch Merkle paths for confirmed-unspent notes — prevents N×getTransaction for spent notes.
      let unspentPartials = candidatePartials;
      if (candidatePartials.length > 0) {
        const tempNotes = candidatePartials.map(p => ({
          id: p.commitment!,
          nullifierHash: p.nullifierHash!,
          poolId: p.poolId!,
        })) as Note[];
        const spentStatuses = await batchCheckNotesSpent(tempNotes);

        // Save newly-discovered-spent to cache; filter to unspent only
        const updatedCache = loadSpentCache();
        let cacheUpdated = false;
        unspentPartials = candidatePartials.filter((partial, i) => {
          if (spentStatuses[i]?.isSpent) {
            updatedCache.add(partial.commitment!);
            cacheUpdated = true;
            return false;
          }
          return true;
        });
        if (cacheUpdated) saveSpentCache(updatedCache);
      }

      // Step 4: fetch Merkle paths ONLY for unspent relay/local notes.
      const fullNotes: Note[] = [...memoNotes];
      let merkleFails = 0;
      for (const partial of unspentPartials) {
        const commitment = partial.commitment!.replace('0x', '');
        try {
          const merkleData = await parseDepositEvent(connection, partial.depositTx!);
          fullNotes.push({
            id: commitment,
            poolId: partial.poolId!,
            commitment: partial.commitment!,
            nullifierSecret: partial.nullifierSecret!,
            noteSecret: partial.noteSecret!,
            nullifierHash: partial.nullifierHash!,
            leafIndex: merkleData.leafIndex,
            rootAfter: merkleData.rootAfter,
            siblings: merkleData.siblings,
            depositTx: partial.depositTx!,
            createdAt: partial.createdAt || new Date().toISOString(),
            status: 'confirmed',
          });
        } catch {
          merkleFails++;
          console.warn('[Recovery] Failed to fetch Merkle path for', partial.commitment?.slice(0, 10));
        }
      }

      // Filter Memo notes: skip cached-spent and already-loaded
      const finalSpentCache = loadSpentCache();
      const newNotes = fullNotes.filter(n => {
        const c = n.commitment.replace('0x', '');
        if (finalSpentCache.has(n.commitment) || finalSpentCache.has(c)) return false;
        return !loadedNotes.some(ln => ln.note.commitment === n.commitment || ln.note.commitment === c)
            && !pendingNotes.some(pn => pn.commitment === n.commitment || pn.commitment === c);
      });

      // Step 5: add to pending notes (triggers on-chain status check pipeline)
      if (newNotes.length > 0) {
        setPendingNotes(prev => [...prev, ...newNotes]);
      }

    } catch {
      // Silent fail — notes will appear when available; user can retry via "Load my notes"
    } finally {
      recoveryInFlight.current = false;
      setIsRecovering(false);
    }
  }, [publicKey, signMessage, connection, loadedNotes, pendingNotes]);

  // Full rescan: clear pool scan checkpoints then re-run recovery
  const handleFullRescan = useCallback(async () => {
    if (!publicKey) return;
    clearScanCheckpoint(publicKey.toBase58());
    await handleWalletRecovery();
  }, [publicKey, handleWalletRecovery]);

  // Toggle note selection
  const toggleSelect = useCallback((noteId: string) => {
    setLoadedNotes(prev => prev.map(n => {
      if (n.note.id === noteId && (n.status === 'ready' || n.status === 'expiring')) {
        return { ...n, selected: !n.selected };
      }
      return n;
    }));
  }, []);

  // Remove note from view
  const removeNote = useCallback((noteId: string) => {
    setLoadedNotes(prev => prev.filter(n => n.note.id !== noteId));
  }, []);

  // Select all available
  const selectAll = useCallback(() => {
    setLoadedNotes(prev => prev.map(n => ({
      ...n,
      selected: n.status === 'ready' || n.status === 'expiring',
    })));
  }, []);

  // Clear selection
  const clearSelection = useCallback(() => {
    setLoadedNotes(prev => prev.map(n => ({ ...n, selected: false })));
  }, []);

  // Format date
  const formatDate = (isoString: string) => {
    const date = new Date(isoString);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  // Get status display
  const getStatusDisplay = (status: LoadedNote['status']) => {
    switch (status) {
      case 'checking': return { text: 'Checking...', color: 'text-zk-text-muted' };
      case 'ready': return { text: 'Ready', color: 'text-zk-success' };
      case 'expiring': return { text: 'Expiring', color: 'text-zk-warning' };
      case 'spent': return { text: 'Spent', color: 'text-zk-text-muted' };
      case 'expired': return { text: 'Expired', color: 'text-zk-danger' };
      case 'error': return { text: 'Error', color: 'text-zk-danger' };
      default: return { text: 'Unknown', color: 'text-zk-text-muted' };
    }
  };

  // Colored status dot — replaces health bar
  const getStatusDot = (status: LoadedNote['status'], healthPercent: number) => {
    if (status === 'checking') return 'bg-zk-text-muted/50 animate-pulse';
    if (status === 'error') return 'bg-red-400';
    if (status === 'expiring' || healthPercent < 33) return healthPercent < 15 ? 'bg-red-400' : 'bg-yellow-400';
    return 'bg-emerald-400';
  };

  const selectedCount = loadedNotes.filter(n => n.selected).length;

  return (
    <div className="border-t border-zk-border pb-24">
      {/* v2 Private Balance Summary + Withdraw Panel */}
      {v2Notes.length > 0 && (() => {
        const unspentV2 = v2Notes.filter(n => n.status === 'unspent');
        const v2Balance = unspentV2.reduce((sum, n) => sum + BigInt(n.amount), 0n);
        const encKey = publicKey ? getCachedKey(publicKey.toBase58()) : undefined;
        return (
          <div className="mx-6 mt-5 mb-4 px-4 py-3 rounded-lg bg-blue-950/30 border border-blue-800/40">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-semibold text-blue-300 uppercase tracking-wider">
                  Private Balance (v2)
                </span>
                <div className="text-lg font-semibold text-white mt-0.5">
                  {formatSol(v2Balance)} SOL
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-xs text-blue-400 text-right">
                  <div>{unspentV2.length} note{unspentV2.length !== 1 ? 's' : ''}</div>
                  <div className="text-blue-500">JoinSplit pool</div>
                </div>
                {encKey && v2Balance > 0n && (
                  <V2WithdrawPanel
                    v2Notes={unspentV2}
                    encKey={encKey}
                    onWithdrawComplete={(spentId, changeNote) => {
                      // Mark the spent note
                      setV2Notes(prev => prev.map(n =>
                        n.id === spentId ? { ...n, status: 'spent' as const } : n
                      ));
                      // Add change note if non-zero
                      if (changeNote && changeNote.amount !== '0') {
                        setV2Notes(prev => [...prev, {
                          id: changeNote.nullifier, // temporary id until scan
                          amount: changeNote.amount,
                          nullifier: changeNote.nullifier,
                          secret: changeNote.secret,
                          commitment: '',
                          nullifierHash: '',
                          leafIndex: -1,
                          merkleRoot: '',
                          pathElements: [],
                          pathIndices: [],
                          status: 'unspent' as const,
                          createdAt: new Date().toISOString(),
                        }]);
                      }
                    }}
                  />
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Section Header */}
      <div className="flex items-center justify-between px-6 pt-5 mb-4">
        <div>
          <h2 className="text-xl font-semibold text-zk-text">
            Withdraw{availableNotes.length > 0 ? ` (${availableNotes.length})` : ''}
          </h2>
          {availableNotes.length > 0 && (
            <p className="text-zk-text-muted text-sm">
              <span className="text-zk-text">{formatSol(totalBalance)} SOL</span> available
            </p>
          )}
        </div>

        {loadedNotes.length > 0 && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={refreshStatuses}
              disabled={isCheckingStatus}
            >
              <svg
                className={`w-4 h-4 mr-1 ${isCheckingStatus ? 'animate-spin' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {isCheckingStatus ? 'Checking...' : 'Refresh'}
            </Button>

            {selectedCount > 0 ? (
              <Button variant="outline" size="sm" onClick={clearSelection}>
                Clear ({selectedCount})
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={selectAll} disabled={availableNotes.length === 0}>
                Select All
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Content: scanning / empty / notes table */}
      {isRecovering ? (
        <div className="text-center py-12 px-6">
          <div className="animate-spin w-8 h-8 border-2 border-zk-teal border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-zk-text-muted text-sm">Scanning your transaction history...</p>
        </div>
      ) : loadedNotes.length === 0 ? (
        <div className="text-center py-10 px-6">
          <p className="text-zk-text-muted text-sm mb-4">
            No notes to withdraw. Deposits will appear here after confirmation.
          </p>
          {publicKey && signMessage && (
            <div className="flex gap-2 justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={handleWalletRecovery}
                loading={isRecovering}
                disabled={isRecovering}
              >
                Scan again
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleFullRescan}
                disabled={isRecovering}
              >
                Full rescan
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-zk-teal/20">
                <th className="w-12 p-3"></th>
                <th className="text-left text-zk-text-muted text-xs font-medium p-3">Note</th>
                <th className="text-left text-zk-text-muted text-xs font-medium p-3">Amount</th>
                <th className="text-left text-zk-text-muted text-xs font-medium p-3">Status</th>
                <th className="text-right text-zk-text-muted text-xs font-medium p-3"></th>
              </tr>
            </thead>
            <tbody>
              {[...loadedNotes]
                .filter(item => item.status !== 'spent' && item.status !== 'expired')
                .sort((a, b) => {
                  // Newest first: sort by deposit time descending, then by leafIndex descending
                  const tDiff = new Date(b.note.createdAt).getTime() - new Date(a.note.createdAt).getTime();
                  if (tDiff !== 0) return tDiff;
                  return b.note.leafIndex - a.note.leafIndex;
                })
                .map((item) => {
                const isSelectable = item.status === 'ready' || item.status === 'expiring';
                const isSpent = item.status === 'spent';
                const statusDisplay = getStatusDisplay(item.status);
                const notePoolConfig = getPoolConfig(item.note.poolId);

                return (
                  <tr
                    key={item.note.id}
                    className={`note-row border-b border-zk-teal/10 last:border-0 ${
                      item.selected ? 'selected' : ''
                    } ${isSpent ? 'opacity-50' : ''}`}
                    onClick={() => isSelectable && toggleSelect(item.note.id)}
                  >
                    {/* Checkbox */}
                    <td className="p-3">
                      {isSelectable ? (
                        <input
                          type="checkbox"
                          className="custom-checkbox"
                          checked={item.selected}
                          onChange={() => toggleSelect(item.note.id)}
                          onClick={e => e.stopPropagation()}
                        />
                      ) : (
                        <span className="w-5 h-5 flex items-center justify-center text-zk-text-muted">
                          {isSpent ? '✓' : '-'}
                        </span>
                      )}
                    </td>

                    {/* Note ID */}
                    <td className="p-3 font-mono text-sm text-zk-text-muted">
                      {item.note.id.slice(0, 8)}...
                    </td>

                    {/* Amount */}
                    <td className={`p-3 font-medium ${isSpent ? 'line-through text-zk-text-muted' : 'text-zk-text'}`}>
                      {notePoolConfig.denominationDisplay}
                    </td>

                    {/* Status + dot */}
                    <td className="p-3">
                      <span className="flex items-center gap-1.5">
                        <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${getStatusDot(item.status, item.health.healthPercent)}`} />
                        <span className={`text-sm ${statusDisplay.color}`}>{statusDisplay.text}</span>
                      </span>
                    </td>

                    {/* Remove button */}
                    <td className="p-3 text-right">
                      <button
                        className="text-zk-text-muted hover:text-zk-danger transition-colors p-1"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeNote(item.note.id);
                        }}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Withdraw Bar */}
      {selectedCount > 0 && (
        <WithdrawBar
          selectedNotes={selectedNotes}
          selectedBalance={selectedBalance}
          onClear={clearSelection}
        />
      )}
    </div>
  );
}
