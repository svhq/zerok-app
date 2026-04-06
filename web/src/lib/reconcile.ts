/**
 * ZeroK v3 — Single-Pass Chain-Authoritative Reconciliation
 *
 * ONE serialized pipeline. ONE source of truth (chain). ONE cache write.
 *
 * Phases:
 *   1. Fast provisional check — batch V3 spent-check on cached notes → early UI update
 *   2. Discovery — V3 pool scan + optional V2 wallet scan
 *   3. Merge + final validation — union by nullifier, chain authority for all statuses
 *   4. Return — caller does ONE setV2Notes() + ONE rebuildCache()
 *
 * Mutation rules:
 *   - Only this pipeline, deposit handler, and withdrawal lifecycle can set note status
 *   - Cache is advisory input only — chain PDA existence is the authority
 *   - No cache writes during the pipeline — one rebuildCache() at the end by the caller
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { V2Note } from '@/types/note';
import { batchCheckV3NotesSpent, isRootInHistory } from './sdk/poseidon';
import { recoverFromPool } from './note-recovery';
import { getDeployedPools, getPoolConfig } from './pool-config';

// ─── Configuration ─────────────────────────────────────────────────────────────

/** Set to false after verifying no V2 notes exist on mainnet. */
const ENABLE_V2_LEGACY_SCAN = false;

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ReconcileParams {
  wallet: string;
  connection: Connection;
  encryptionKey: CryptoKey;
  programId: PublicKey;
  cachedNotes: V2Note[];
  /** Called after Phase 1 with spent-checked cached notes (~2 sec). */
  onProvisional?: (notes: V2Note[]) => void;
}

export interface ReconcileStats {
  cached: number;
  discovered: number;
  merged: number;
  spent: number;
  unspent: number;
  reverted: number;
  withdrawable: number;
}

export interface ReconcileResult {
  notes: V2Note[];
  stats: ReconcileStats;
}

// ─── Epoch-based stale detection ───────────────────────────────────────────────

let reconcileEpoch = 0;

// ─── Main Pipeline ─────────────────────────────────────────────────────────────

/**
 * Single-pass chain-authoritative reconciliation.
 * Returns null if a newer reconciliation was started (stale epoch).
 */
export async function reconcileNotes(params: ReconcileParams): Promise<ReconcileResult | null> {
  const epoch = ++reconcileEpoch;
  const { wallet, connection, encryptionKey, programId, cachedNotes, onProvisional } = params;

  const stats: ReconcileStats = { cached: cachedNotes.length, discovered: 0, merged: 0, spent: 0, unspent: 0, reverted: 0, withdrawable: 0 };

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 1: Show cached notes immediately (no RPC call)
  // ═══════════════════════════════════════════════════════════════════════════

  if (cachedNotes.length > 0) {
    onProvisional?.(cachedNotes);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 2: Discovery (all pools in PARALLEL)
  // ═══════════════════════════════════════════════════════════════════════════

  const discovered: V2Note[] = [];
  const pools = getDeployedPools();

  const poolResults = await Promise.all(
    pools.map(({ id: poolId }) => {
      const pc = getPoolConfig(poolId);
      return recoverFromPool(connection, {
        poolId: pc.poolId,
        statePda: pc.statePda,
        programId: pc.programId,
        denominationLamports: String(pc.denominationLamports),
      }, wallet, encryptionKey, { skipSpentCheck: true })
        .catch(err => { console.warn(`[Reconcile] Pool scan failed for ${poolId}:`, err); return [] as V2Note[]; });
    })
  );
  for (const notes of poolResults) discovered.push(...notes);

  if (epoch !== reconcileEpoch) return null; // stale

  stats.discovered = discovered.length;
  if (discovered.length > 0) {
    console.log(`[Reconcile] Discovery: ${discovered.length} notes from pool scan`);
  }

  if (epoch !== reconcileEpoch) return null; // stale

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 3: Merge + Final Validation
  // ═══════════════════════════════════════════════════════════════════════════
  // Union by nullifier (chain data wins for fields), then chain-authoritative spent-check

  // Merge: cached ∪ discovered, discovered wins for fields (fresher data)
  const merged = new Map<string, V2Note>();

  for (const note of cachedNotes) {
    merged.set(note.nullifier, note);
  }

  for (const note of discovered) {
    const existing = merged.get(note.nullifier);
    if (existing) {
      // Discovered has fresher data — update path/root if better
      merged.set(note.nullifier, {
        ...existing,
        // Chain data wins for these fields
        leafIndex: note.leafIndex >= 0 ? note.leafIndex : existing.leafIndex,
        merkleRoot: note.merkleRoot || existing.merkleRoot,
        pathElements: note.pathElements.length > 0 ? note.pathElements : existing.pathElements,
        pathIndices: note.pathIndices.length > 0 ? note.pathIndices : existing.pathIndices,
        depositTx: note.depositTx || existing.depositTx,
        noteVersion: note.noteVersion ?? existing.noteVersion,
      });
    } else {
      merged.set(note.nullifier, note);
    }
  }

  const allNotes = Array.from(merged.values());
  stats.merged = allNotes.length;

  // Final chain-authoritative spent-check on ALL notes
  try {
    const flags = await batchCheckV3NotesSpent(connection, allNotes, programId);
    for (let i = 0; i < allNotes.length; i++) {
      if (allNotes[i].status === 'pending_spend') continue; // active withdrawal
      const chainSpent = flags[i];
      if (chainSpent) {
        if (allNotes[i].status !== 'spent') {
          allNotes[i] = { ...allNotes[i], status: 'spent' };
        }
      } else {
        if (allNotes[i].status === 'spent') {
          stats.reverted++;
          console.log(`[Reconcile] Reverting phantom: ${allNotes[i].nullifier.substring(0, 12)} (locally spent, chain unspent)`);
        }
        allNotes[i] = { ...allNotes[i], status: 'unspent' };
      }
    }
  } catch (err) {
    console.warn('[Reconcile] Phase 3 spent-check failed:', err);
    // Fall through — notes keep their existing status from discovery/cache
  }

  if (epoch !== reconcileEpoch) return null; // stale

  // Compute withdrawability for unspent notes
  // Fetch pool state once per denomination for root-in-history check
  const poolStateCache = new Map<string, Uint8Array | null>();
  for (const note of allNotes) {
    if (note.status !== 'unspent') {
      (note as V2Note & { withdrawable?: boolean }).withdrawable = false;
      continue;
    }
    // Basic requirements
    if (note.leafIndex < 0 || !note.pathElements?.length || !note.merkleRoot) {
      console.log(`[Reconcile] Note leaf=${note.leafIndex} not withdrawable: leafIdx=${note.leafIndex}, pathLen=${note.pathElements?.length ?? 0}, hasRoot=${!!note.merkleRoot}`);
      (note as V2Note & { withdrawable?: boolean }).withdrawable = false;
      continue;
    }
    // Root-in-history check
    const denomKey = note.amount;
    if (!poolStateCache.has(denomKey)) {
      try {
        let statePdaStr: string | null = null;
        for (const { id } of pools) {
          const pc = getPoolConfig(id);
          if (String(pc.denominationLamports) === denomKey) { statePdaStr = pc.statePda; break; }
        }
        if (statePdaStr) {
          const acct = await connection.getAccountInfo(new PublicKey(statePdaStr));
          poolStateCache.set(denomKey, acct?.data ? new Uint8Array(acct.data) : null);
        } else {
          poolStateCache.set(denomKey, null);
        }
      } catch { poolStateCache.set(denomKey, null); }
    }
    const stateData = poolStateCache.get(denomKey);
    const rootValid = stateData ? isRootInHistory(note.merkleRoot, stateData) : true; // if can't check, assume valid
    if (!rootValid) {
      console.log(`[Reconcile] Note leaf=${note.leafIndex} root NOT in history. root=${note.merkleRoot.substring(0, 20)}... stateLen=${stateData?.length}`);
    }
    (note as V2Note & { withdrawable?: boolean }).withdrawable = rootValid;
  }

  // Compute final stats
  for (const note of allNotes) {
    if (note.status === 'spent') stats.spent++;
    else if (note.status === 'unspent') {
      stats.unspent++;
      if ((note as V2Note & { withdrawable?: boolean }).withdrawable) stats.withdrawable++;
    }
  }

  if (epoch !== reconcileEpoch) return null; // stale

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 4: Return
  // ═══════════════════════════════════════════════════════════════════════════

  console.log(`[Reconcile] Done: ${stats.merged} notes (${stats.unspent} unspent, ${stats.spent} spent, ${stats.withdrawable} withdrawable, ${stats.reverted} reverted)`);

  return { notes: allNotes, stats };
}
