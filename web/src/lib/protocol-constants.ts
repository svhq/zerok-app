/**
 * Protocol Constants - Single Source of Truth
 *
 * All values derived from on-chain program definitions.
 * No magic numbers allowed elsewhere in codebase.
 *
 * ============================================================================
 * ACCEPTED ROOT SET ARCHITECTURE (Requirement A: Canonical Rule)
 * ============================================================================
 *
 * The on-chain withdraw verifier checks roots in this order (from instructions_v2_clean.rs:1091-1209):
 *
 * Step 1: state.is_known_root(&root)
 *         └── Checks STATE_ROOT_HISTORY (256 entries in PoolStateV2Clean)
 *
 * Step 2: (devnet/mainnet) Search SHARDED_ROOT_RING
 *         └── 20 shard PDAs × 128 entries each = 2560 total capacity
 *
 * Step 3: (localnet only) Search LEGACY_ROOT_RING
 *         └── Single PDA with 128 entries (backward compatibility)
 *
 * CONSENSUS-CRITICAL INVARIANT:
 *   ACCEPTED_ROOT_SET = STATE_ROOT_HISTORY ∪ SHARDED_ROOT_RING (∪ LEGACY_ROOT_RING on localnet)
 *
 * DAEMON TRIGGER RULE:
 *   Daemon required when: root ∉ ACCEPTED_ROOT_SET
 *   (NOT expressed as "~N deposits" - deposits ≠ roots due to batching/failed txs)
 *
 * ============================================================================
 */

// =============================================================================
// STATE ACCOUNT LAYOUT (PoolStateV2Clean)
// =============================================================================

/** Offset to current_root in state account */
export const CURRENT_ROOT_OFFSET = 688;

/** Offset to root_history array in state account */
export const ROOT_HISTORY_OFFSET = 720;

/** Size of each root in bytes */
export const ROOT_SIZE = 32;

/** Number of roots in state.root_history (checked first by on-chain verifier) */
export const STATE_ROOT_HISTORY_SIZE = 256;

// =============================================================================
// SHARDED ROOT RING (devnet/mainnet)
// =============================================================================

/** Number of shard PDAs in sharded ring (devnet/mainnet configuration) */
export const NUM_SHARDS = 20;

/** Entries per shard */
export const SHARD_CAPACITY = 128;

/** Total sharded ring capacity (NUM_SHARDS × SHARD_CAPACITY) */
export const SHARDED_RING_CAPACITY = NUM_SHARDS * SHARD_CAPACITY; // 2560

// Shard account layout (from state_root_ring_shard.rs)
// - version: u64 (8 bytes)
// - shard_index: u32 (4 bytes)
// - local_head: u32 (4 bytes)
// - entries: [RootEntry; 128] where RootEntry = { root: [u8; 32], slot: u64 }

/** Offset to entries array in shard account */
export const SHARD_ENTRIES_OFFSET = 16; // 8 + 4 + 4

/** Size of each RootEntry (32 bytes root + 8 bytes slot) */
export const ROOT_ENTRY_SIZE = 40;

// =============================================================================
// LEGACY ROOT RING (localnet only - backward compatibility)
// =============================================================================

/** Legacy ring capacity (localnet only, separate PDA) */
export const LEGACY_RING_CAPACITY = 128;

// =============================================================================
// MERKLE TREE
// =============================================================================

/** Merkle tree height */
export const TREE_HEIGHT = 20;

/** Maximum number of leaves in Merkle tree */
export const MAX_LEAVES = 2 ** TREE_HEIGHT; // 1,048,576

// =============================================================================
// ACCEPTED ROOT SET SOURCES
// =============================================================================

/** Enum for tracking where a root was found */
export type RootSource = 'state_history' | 'sharded_ring' | 'legacy_ring' | 'not_found';

/** Result of root acceptance check */
export interface RootAcceptanceResult {
  /** Whether root is in ACCEPTED_ROOT_SET */
  found: boolean;
  /** Which structure the root was found in */
  source: RootSource;
  /** If found in sharded ring, which shard index */
  shardIndex?: number;
}
