/**
 * V3 Pool-Based Note Recovery
 *
 * Core insight: scan the POOL's transaction history (bounded, ZeroK-only)
 * instead of the USER's wallet history (unbounded, noisy).
 *
 * Flow:
 *   1. getSignaturesForAddress(statePda) — only ZeroK deposit/withdrawal txs
 *   2. Filter by sig.memo containing "zerok:v3:" prefix
 *   3. Try-decrypt each memo with wallet key — only owner's notes succeed
 *   4. For own notes only: fetch full tx → parse DepositProofData event
 *   5. Batch nullifier spent-check on-chain
 *   6. Save checkpoint for incremental scanning
 *
 * Privacy: identical to reading the public blockchain. No user identifier is
 * transmitted. The relay (if used later) sees the same opaque ciphertext.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { V2Note } from '@/types/note';
import { tryDecryptV3Memo, tryDecryptV4BinaryMemo, tryDecryptV5SeedMemo, MEMO_PREFIX_V3, MEMO_PREFIX_V4, MEMO_PREFIX_V5 } from './note-encryption';
import { parseDepositEventFromLogs, parseAllDepositEventsFromLogs } from './deposit-event';
import {
  computeCommitmentFromBigInts,
  bytesToFieldBE,
  fieldToBytesBE,
  initPoseidon,
  isRootInHistory,
  computeRootFromPath,
} from './sdk/poseidon';
import {
  ScanCheckpoint,
  saveScanCheckpoint,
  loadScanCheckpoint,
} from './note-cache';

// ─── Constants ──────────────────────────────────────────────────────────────

const NULLIFIER_SEED = new TextEncoder().encode('nullifier');
const TX_FETCH_BATCH = 10;

// ─── Types ──────────────────────────────────────────────────────────────────

interface PoolTarget {
  poolId: string;
  statePda: string;
  programId: string;
  denominationLamports: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Clean memo string from getSignaturesForAddress result (may have length prefix/brackets). */
function cleanMemo(raw: string): string {
  // Solana RPC wraps memo as: "[<byteLen>] <memoText>" or '["<memoText>"]'
  // Examples: "[261] zerok:v3:..." or '["zerok:v3:..."]'
  let cleaned = raw;
  // Strip byte-length prefix: "[261] " → ""
  const prefixMatch = cleaned.match(/^\[\d+\]\s*/);
  if (prefixMatch) cleaned = cleaned.slice(prefixMatch[0].length);
  // Strip JSON array brackets: '["..."]' → '...'
  if (cleaned.startsWith('["')) cleaned = cleaned.slice(2);
  if (cleaned.endsWith('"]')) cleaned = cleaned.slice(0, -2);
  if (cleaned.startsWith('"')) cleaned = cleaned.slice(1);
  if (cleaned.endsWith('"')) cleaned = cleaned.slice(0, -1);
  return cleaned.trim();
}

/** Derive V3 nullifier PDA: seeds = ["nullifier", statePda, nullifierHashBE] */
function deriveV3NullifierPda(
  statePda: PublicKey,
  nullifierHashBE: Uint8Array,
  programId: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [NULLIFIER_SEED, statePda.toBuffer(), nullifierHashBE],
    programId,
  );
  return pda;
}

// ─── Main Recovery Function ─────────────────────────────────────────────────

/**
 * Recover V3 notes by scanning a pool's on-chain history.
 *
 * @param scanConn    - Solana connection (preferably Helius/Alchemy with sig.memo support)
 * @param pool        - Pool target info (statePda, programId, denomination)
 * @param wallet      - Wallet public key string (for checkpoint scoping)
 * @param encryptionKey - AES-256-GCM key derived from wallet signature
 * @returns Recovered V2Notes + updated checkpoint
 */
export async function recoverFromPool(
  scanConn: Connection,
  pool: PoolTarget,
  wallet: string,
  encryptionKey: CryptoKey,
  options?: { skipSpentCheck?: boolean },
): Promise<V2Note[]> {
  const statePda = new PublicKey(pool.statePda);
  const programId = new PublicKey(pool.programId);
  const denomination = pool.denominationLamports;

  // Load checkpoint for incremental scanning
  const checkpoint = loadScanCheckpoint(wallet, denomination);

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 1: Fetch pool signatures (incremental if checkpoint exists)
  // ═══════════════════════════════════════════════════════════════════════════

  type SigInfo = { signature: string; memo?: string | null; slot?: number; blockTime?: number | null };
  const allSigs: SigInfo[] = [];

  try {
    // Paginate through all signatures since last checkpoint
    let before: string | undefined;
    let done = false;

    while (!done) {
      const opts: { limit: number; before?: string; until?: string } = { limit: 1000 };
      if (before) opts.before = before;
      if (checkpoint?.lastSignature) opts.until = checkpoint.lastSignature;

      const page: SigInfo[] = await scanConn.getSignaturesForAddress(statePda, opts);

      if (page.length === 0) {
        done = true;
      } else {
        allSigs.push(...page);
        before = page[page.length - 1].signature;
        if (page.length < 1000) done = true; // last page
      }
    }
  } catch (err) {
    console.warn(`[PoolRecovery] Failed to fetch signatures for ${pool.poolId}:`, err);
    return [];
  }

  if (allSigs.length === 0) {
    console.log(`[PoolRecovery] ${pool.poolId}: no new deposits since last scan`);
    return checkpoint ? [] : []; // nothing new
  }

  console.log(`[PoolRecovery] ${pool.poolId}: ${allSigs.length} new signatures to scan`);

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 2: Filter by memo prefix + try-decrypt (NO RPC calls needed)
  // ═══════════════════════════════════════════════════════════════════════════

  const ownDeposits: Array<{
    signature: string;
    nullifier: string;
    secret: string;
    denomination: string;
  }> = [];

  // Check if any sig has memo field populated (Helius/Alchemy do this, public RPCs don't)
  const memoSupported = allSigs.some(s => s.memo != null);
  console.log(`[PoolRecovery] Memo support: ${memoSupported ? 'YES (fast path)' : 'NO (slow path, fetching txs)'}`);

  if (memoSupported) {
    // Fast path: use sig.memo to filter + decrypt without fetching full txs
    const v3Candidates = allSigs.filter(
      s => s.memo != null && (s.memo.includes(MEMO_PREFIX_V3) || s.memo.includes(MEMO_PREFIX_V4) || s.memo.includes(MEMO_PREFIX_V5))
    );
    console.log(`[PoolRecovery] Found ${v3Candidates.length} memo candidates (of ${allSigs.length} total sigs)`);

    for (const sig of v3Candidates) {
      const cleaned = cleanMemo(sig.memo!);
      if (cleaned.includes(MEMO_PREFIX_V5)) {
        // V5 seed memo: one memo → N notes (batch-local indices 0..count-1)
        const notes = await tryDecryptV5SeedMemo(cleaned, encryptionKey);
        if (notes) {
          console.log(`[PoolRecovery] V5 seed memo → ${notes.length} notes (sig=${sig.signature.slice(0, 16)}...)`);
          for (const payload of notes) {
            ownDeposits.push({
              signature: sig.signature,
              nullifier: hexToDecimal(payload.n),
              secret: hexToDecimal(payload.s),
              denomination: payload.d,
            });
          }
        }
      } else {
        // V4 binary or V3 JSON: single note per memo
        const payload = cleaned.includes(MEMO_PREFIX_V4)
          ? await tryDecryptV4BinaryMemo(cleaned, encryptionKey)
          : await tryDecryptV3Memo(cleaned, encryptionKey);
        if (payload) {
          ownDeposits.push({
            signature: sig.signature,
            nullifier: hexToDecimal(payload.n),
            secret: hexToDecimal(payload.s),
            denomination: payload.d,
          });
        }
      }
    }
  } else {
    // Slow path: no memo field — need to fetch transactions to extract memos.
    // Only check up to 200 most recent sigs to avoid excessive RPC calls.
    const toCheck = allSigs.slice(0, 200);

    for (let b = 0; b < toCheck.length; b += TX_FETCH_BATCH) {
      const chunk = toCheck.slice(b, b + TX_FETCH_BATCH);
      const txs = await Promise.all(
        chunk.map(s =>
          scanConn.getTransaction(s.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          }).catch(() => null)
        )
      );

      for (let i = 0; i < chunk.length; i++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tx = txs[i] as any;
        if (!tx?.transaction?.message) continue;

        const memo = extractMemoFromTx(tx);
        if (!memo || !(memo.includes(MEMO_PREFIX_V3) || memo.includes(MEMO_PREFIX_V4) || memo.includes(MEMO_PREFIX_V5))) continue;

        if (memo.includes(MEMO_PREFIX_V5)) {
          const notes = await tryDecryptV5SeedMemo(memo, encryptionKey);
          if (notes) {
            for (const payload of notes) {
              ownDeposits.push({
                signature: chunk[i].signature,
                nullifier: hexToDecimal(payload.n),
                secret: hexToDecimal(payload.s),
                denomination: payload.d,
              });
            }
          }
          continue;
        }

        const payload = memo.includes(MEMO_PREFIX_V4)
          ? await tryDecryptV4BinaryMemo(memo, encryptionKey)
          : await tryDecryptV3Memo(memo, encryptionKey);
        if (payload) {
          ownDeposits.push({
            signature: chunk[i].signature,
            nullifier: hexToDecimal(payload.n),
            secret: hexToDecimal(payload.s),
            denomination: payload.d,
          });
        }
      }
    }
  }

  // Skip notes already known from previous scans
  const knownSet = new Set(checkpoint?.knownNullifiers ?? []);
  const newDeposits = ownDeposits.filter(d => !knownSet.has(d.nullifier));

  if (newDeposits.length === 0) {
    // Save checkpoint even if no new notes — so we don't re-scan this range
    saveNewCheckpoint(wallet, denomination, allSigs, checkpoint);
    return [];
  }

  console.log(`[PoolRecovery] ${pool.poolId}: ${newDeposits.length} own notes found (${ownDeposits.length - newDeposits.length} already known)`);

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 3: Fetch full transactions for OWN notes only (Merkle path data)
  //
  // V5 batch deposits put multiple deposit instructions in one tx, each emitting
  // its own DepositProofData event. We parse ALL events and match each note to
  // its event by cryptographic consistency: computeRootFromPath(commitment,
  // event.siblings, event.positions) === event.rootAfter.
  // ═══════════════════════════════════════════════════════════════════════════

  let recovered: V2Note[] = [];

  // Deduplicate tx fetches: V5 batch notes share the same signature
  const notesBySig = new Map<string, Array<{ nullifier: string; secret: string; denomination: string; signature: string }>>();
  for (const dep of newDeposits) {
    if (!notesBySig.has(dep.signature)) notesBySig.set(dep.signature, []);
    notesBySig.get(dep.signature)!.push(dep);
  }

  // Fetch each unique tx once, then match notes to events
  const uniqueSigs = [...notesBySig.keys()];
  for (let b = 0; b < uniqueSigs.length; b += TX_FETCH_BATCH) {
    const sigChunk = uniqueSigs.slice(b, b + TX_FETCH_BATCH);
    const txs = await Promise.all(
      sigChunk.map(sig =>
        scanConn.getTransaction(sig, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        }).catch(() => null)
      )
    );

    for (let t = 0; t < sigChunk.length; t++) {
      const sig = sigChunk[t];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tx = txs[t] as any;
      const sigNotes = notesBySig.get(sig)!;

      // Parse ALL deposit events from this tx (may be 1 for single deposits, N for V5 batches)
      const allEvents = tx?.meta?.logMessages
        ? parseAllDepositEventsFromLogs(tx.meta.logMessages)
        : [];

      for (const dep of sigNotes) {
        const nullBigInt = BigInt(dep.nullifier);
        const secBigInt = BigInt(dep.secret);
        const { commitment, nullifierHash } = await computeCommitmentFromBigInts(nullBigInt, secBigInt);
        const commitmentHex = Array.from(commitment).map((x: number) => x.toString(16).padStart(2, '0')).join('');
        const nullifierHashHex = Array.from(nullifierHash).map((x: number) => x.toString(16).padStart(2, '0')).join('');

        // Match this note to its event by cryptographic consistency:
        // Find the event where computeRootFromPath(commitment, siblings, positions) === rootAfter
        let leafIndex = -1;
        let merkleRoot = '';
        let siblings: string[] = [];
        let positions: number[] = [];

        const commitBigInt = bytesToFieldBE(commitment);
        for (const event of allEvents) {
          const computedRoot = await computeRootFromPath(commitBigInt, event.siblings, event.positions);
          const normalizedEventRoot = event.rootAfter.replace(/^0x/, '');
          if (computedRoot === normalizedEventRoot) {
            leafIndex = event.leafIndex;
            merkleRoot = event.rootAfter;
            siblings = [...event.siblings];
            positions = [...event.positions];
            break;
          }
        }

        if (leafIndex === -1 && allEvents.length === 1) {
          // Fallback for single-deposit txs (V3/V4): use the only event
          const event = allEvents[0];
          leafIndex = event.leafIndex;
          merkleRoot = event.rootAfter;
          siblings = [...event.siblings];
          positions = [...event.positions];
        }

        recovered.push({
          id: commitmentHex,
          amount: dep.denomination,
          nullifier: dep.nullifier,
          secret: dep.secret,
          commitment: commitmentHex,
          nullifierHash: nullifierHashHex,
          leafIndex,
          merkleRoot,
          pathElements: siblings,
          pathIndices: positions,
          status: 'unspent',
          depositTx: sig,
          createdAt: new Date().toISOString(),
          noteVersion: 3,
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 3.5: Root-in-history validation — filter notes from old pool deployments
  // ═══════════════════════════════════════════════════════════════════════════

  if (recovered.length > 0) {
    try {
      const stateInfo = await scanConn.getAccountInfo(statePda);
      if (stateInfo) {
        const stateData = new Uint8Array(stateInfo.data);
        const before = recovered.length;
        recovered = recovered.filter(note => {
          if (!note.merkleRoot) return true; // no root to check, keep
          return isRootInHistory(note.merkleRoot, stateData);
        });
        if (recovered.length < before) {
          console.log(`[PoolRecovery] Filtered ${before - recovered.length} notes with stale roots (old pool deployment)`);
        }
      }
    } catch (err) {
      console.warn('[PoolRecovery] Root validation failed (non-fatal):', err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 4: Batch nullifier spent-check (skippable when caller handles it)
  // ═══════════════════════════════════════════════════════════════════════════

  if (recovered.length > 0 && !options?.skipSpentCheck) {
    try {
      const poseidon = await initPoseidon();
      const pdas: PublicKey[] = [];

      for (const note of recovered) {
        const nullBigInt = BigInt(note.nullifier);
        const hashField = poseidon([nullBigInt]);
        const hashBytes = fieldToBytesBE(poseidon.F.toObject(hashField) as bigint);
        pdas.push(deriveV3NullifierPda(statePda, hashBytes, programId));
      }

      // Batch RPC call
      const BATCH = 100;
      for (let b = 0; b < pdas.length; b += BATCH) {
        const chunk = pdas.slice(b, b + BATCH);
        const infos = await scanConn.getMultipleAccountsInfo(chunk);
        for (let i = 0; i < chunk.length; i++) {
          if (infos[i] !== null) {
            recovered[b + i].status = 'spent';
          }
        }
      }
    } catch (err) {
      console.warn(`[PoolRecovery] Spent-check failed for ${pool.poolId} (non-fatal):`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 5: Save checkpoint
  // ═══════════════════════════════════════════════════════════════════════════

  const allKnown = [
    ...(checkpoint?.knownNullifiers ?? []),
    ...recovered.map(n => n.nullifier),
  ];
  saveNewCheckpoint(wallet, denomination, allSigs, checkpoint, allKnown);

  console.log(`[PoolRecovery] ${pool.poolId}: recovered ${recovered.length} notes (${recovered.filter(n => n.status === 'unspent').length} unspent)`);

  return recovered;
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/** Convert hex string (possibly without 0x prefix) to decimal BigInt string. */
function hexToDecimal(hex: string): string {
  const clean = hex.startsWith('0x') ? hex : '0x' + hex;
  return BigInt(clean).toString();
}

/** Extract memo text from a fetched transaction (fallback when sig.memo is unavailable). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractMemoFromTx(tx: any): string | null {
  const MEMO_PID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
  const msg = tx?.transaction?.message;
  if (!msg) return null;

  const accounts: string[] = (msg.accountKeys || msg.staticAccountKeys || [])
    .map((k: unknown) => typeof k === 'string' ? k : String(k));
  const memoIdx = accounts.indexOf(MEMO_PID);
  if (memoIdx === -1) return null;

  for (const ix of (msg.instructions || msg.compiledInstructions || [])) {
    if ((ix.programIdIndex ?? ix.programIndex) !== memoIdx) continue;
    const text = typeof ix.data === 'string'
      ? Buffer.from(ix.data, 'base64').toString('utf8')
      : Buffer.from(ix.data).toString('utf8');
    if (text.includes(MEMO_PREFIX_V3) || text.includes(MEMO_PREFIX_V4) || text.includes(MEMO_PREFIX_V5)) return text;
  }
  return null;
}

/** Save a new checkpoint from the latest signature batch. */
function saveNewCheckpoint(
  wallet: string,
  denomination: string,
  sigs: Array<{ signature: string; slot?: number }>,
  oldCheckpoint: ScanCheckpoint | null,
  knownNullifiers?: string[],
): void {
  // The newest signature is sigs[0] (getSignaturesForAddress returns newest-first)
  const newest = sigs[0];
  if (!newest) return;

  saveScanCheckpoint(wallet, denomination, {
    lastSignature: newest.signature,
    lastSlot: newest.slot ?? 0,
    knownNullifiers: knownNullifiers ?? oldCheckpoint?.knownNullifiers ?? [],
    timestamp: Date.now(),
  });
}
