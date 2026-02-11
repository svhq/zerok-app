/**
 * Root Acceptance Check - Single Library for Root Validation
 *
 * Requirement B: One shared function/module used by web + CLI + daemon decision logic
 * so behavior can't diverge.
 *
 * CANONICAL RULE (from on-chain instructions_v2_clean.rs:1091-1209):
 *   ACCEPTED_ROOT_SET = STATE_ROOT_HISTORY ∪ SHARDED_ROOT_RING
 *
 * On-chain verifier checks in order:
 *   1. state.is_known_root(&root) - checks STATE_ROOT_HISTORY (256 entries)
 *   2. Search all allocated shards in SHARDED_ROOT_RING (20 × 128 = 2560 entries)
 *
 * If root ∉ ACCEPTED_ROOT_SET, withdrawal fails with ProtocolError::RootNotInRing
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { PoolConfig } from '@/types/note';
import { executeWithRotation } from './resilient-connection';
import {
  CURRENT_ROOT_OFFSET,
  ROOT_HISTORY_OFFSET,
  ROOT_SIZE,
  STATE_ROOT_HISTORY_SIZE,
  SHARD_ENTRIES_OFFSET,
  ROOT_ENTRY_SIZE,
  SHARD_CAPACITY,
  RootAcceptanceResult,
  RootSource,
} from './protocol-constants';

/**
 * Check if root is in on-chain ACCEPTED_ROOT_SET
 *
 * This is the SINGLE SOURCE OF TRUTH for root acceptance checking.
 * Use this function everywhere (web, CLI, daemon decision logic).
 *
 * @param _connection - Unused, kept for API compatibility (uses executeWithRotation internally)
 * @param poolConfig - Pool configuration with statePda and shardPdas
 * @param rootHex - Root to search for (hex string, with or without 0x prefix)
 * @returns RootAcceptanceResult with found status, source, and optional shardIndex
 */
export async function isAcceptedRoot(
  _connection: Connection,
  poolConfig: PoolConfig,
  rootHex: string
): Promise<RootAcceptanceResult> {
  try {
    // Normalize root to buffer
    const rootClean = rootHex.replace('0x', '');
    const rootBuffer = Buffer.from(rootClean, 'hex');

    if (rootBuffer.length !== 32) {
      console.log(`[root-acceptance] Invalid root length: ${rootBuffer.length} (expected 32)`);
      return { found: false, source: 'not_found' };
    }

    // Step 1: Check STATE_ROOT_HISTORY (on-chain checks this first)
    const historyResult = await checkStateRootHistory(poolConfig, rootBuffer);
    if (historyResult.found) {
      return historyResult;
    }

    // Step 2: Check SHARDED_ROOT_RING (20 shards × 128 entries = 2560)
    const shardedResult = await checkShardedRootRing(poolConfig, rootBuffer);
    if (shardedResult.found) {
      return shardedResult;
    }

    // Root not in ACCEPTED_ROOT_SET
    console.log('[root-acceptance] Root not found in ACCEPTED_ROOT_SET (need daemon for fresh path)');
    return { found: false, source: 'not_found' };
  } catch (err) {
    console.error('[root-acceptance] Error checking ACCEPTED_ROOT_SET:', err);
    return { found: false, source: 'not_found' };
  }
}

/**
 * Check if root exists in STATE_ROOT_HISTORY (256 entries in state account)
 */
async function checkStateRootHistory(
  poolConfig: PoolConfig,
  rootBuffer: Buffer
): Promise<RootAcceptanceResult> {
  try {
    const statePda = new PublicKey(poolConfig.statePda);
    console.log(`[root-acceptance] Checking STATE_ROOT_HISTORY at ${statePda.toBase58()}`);

    const stateInfo = await executeWithRotation(
      (conn) => conn.getAccountInfo(statePda)
    );

    if (!stateInfo) {
      console.log('[root-acceptance] State account not found');
      return { found: false, source: 'not_found' };
    }

    const data = stateInfo.data;

    // Fast path: Check current_root first (most common case for fresh notes)
    const currentRoot = data.slice(CURRENT_ROOT_OFFSET, CURRENT_ROOT_OFFSET + ROOT_SIZE);
    if (currentRoot.equals(rootBuffer)) {
      console.log('[root-acceptance] Root matches current_root (fast path)');
      return { found: true, source: 'state_history' };
    }

    // Search root_history array (256 entries starting at ROOT_HISTORY_OFFSET)
    for (let i = 0; i < STATE_ROOT_HISTORY_SIZE; i++) {
      const rootOffset = ROOT_HISTORY_OFFSET + (i * ROOT_SIZE);
      const historyRoot = data.slice(rootOffset, rootOffset + ROOT_SIZE);

      // Skip zero/uninitialized roots
      if (historyRoot.every((b: number) => b === 0)) continue;

      if (historyRoot.equals(rootBuffer)) {
        console.log(`[root-acceptance] Root found in STATE_ROOT_HISTORY[${i}]`);
        return { found: true, source: 'state_history' };
      }
    }

    console.log('[root-acceptance] Root not in STATE_ROOT_HISTORY');
    return { found: false, source: 'not_found' };
  } catch (err) {
    console.error('[root-acceptance] Error checking STATE_ROOT_HISTORY:', err);
    return { found: false, source: 'not_found' };
  }
}

/**
 * Check if root exists in SHARDED_ROOT_RING (20 shards × 128 = 2560 entries)
 *
 * Shard account layout (from state_root_ring_shard.rs):
 * - version: u64 (8 bytes)
 * - shard_index: u32 (4 bytes)
 * - local_head: u32 (4 bytes)
 * - entries: [RootEntry; 128] where RootEntry = { root: [u8; 32], slot: u64 }
 */
async function checkShardedRootRing(
  poolConfig: PoolConfig,
  rootBuffer: Buffer
): Promise<RootAcceptanceResult> {
  const shardPdas = poolConfig.shardPdas;

  if (!shardPdas || shardPdas.length === 0) {
    console.log('[root-acceptance] No shard PDAs configured, skipping SHARDED_ROOT_RING check');
    return { found: false, source: 'not_found' };
  }

  console.log(`[root-acceptance] Checking SHARDED_ROOT_RING (${shardPdas.length} shards)`);

  // Fetch all shard accounts in parallel for efficiency
  const shardPubkeys = shardPdas.map(pda => new PublicKey(pda));

  const shardInfos = await executeWithRotation(
    (conn) => conn.getMultipleAccountsInfo(shardPubkeys)
  );

  for (let shardIndex = 0; shardIndex < shardInfos.length; shardIndex++) {
    const shardInfo = shardInfos[shardIndex];

    if (!shardInfo) {
      // Shard not allocated yet (lazy allocation)
      continue;
    }

    const data = shardInfo.data;

    // Search entries in this shard
    for (let entryIndex = 0; entryIndex < SHARD_CAPACITY; entryIndex++) {
      const entryOffset = SHARD_ENTRIES_OFFSET + (entryIndex * ROOT_ENTRY_SIZE);
      const entryRoot = data.slice(entryOffset, entryOffset + ROOT_SIZE);
      const slotBytes = data.slice(entryOffset + ROOT_SIZE, entryOffset + ROOT_ENTRY_SIZE);

      // Skip uninitialized entries (slot == 0 means unwritten)
      // Slot is u64 little-endian
      const slot = slotBytes.readBigUInt64LE(0);
      if (slot === 0n) continue;

      if (entryRoot.equals(rootBuffer)) {
        console.log(`[root-acceptance] Root found in SHARDED_ROOT_RING[shard=${shardIndex}, entry=${entryIndex}]`);
        return { found: true, source: 'sharded_ring', shardIndex };
      }
    }
  }

  console.log('[root-acceptance] Root not in SHARDED_ROOT_RING');
  return { found: false, source: 'not_found' };
}

// =============================================================================
// BACKWARD COMPATIBILITY EXPORTS
// =============================================================================

/**
 * @deprecated Use isAcceptedRoot instead. This is kept for backward compatibility.
 *
 * Check if root is in ring (STATE_ROOT_HISTORY ∪ SHARDED_ROOT_RING)
 */
export async function isRootInRing(
  connection: Connection,
  poolConfig: PoolConfig,
  rootHex: string
): Promise<boolean> {
  const result = await isAcceptedRoot(connection, poolConfig, rootHex);
  return result.found;
}
