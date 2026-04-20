/**
 * ZeroK v2-core — Merkle Tree Operations
 *
 * Cross-environment Merkle path computation and pool state reading.
 * Uses Uint8Array + DataView instead of Buffer.
 * Takes poseidon as a parameter (dependency injection).
 */

'use strict';

const { TREE_DEPTH, ROOT_HISTORY_SIZE, STATE_OFFSETS_V2, ZERO_CHAIN_BE } = require('./constants.js');
const { hexToFr, bytesToHex } = require('./field.js');

// ─────────────────────────────────────────────────────────────────────────────
// State reading utilities
// All accept Uint8Array (Buffer is a Uint8Array subclass, so CLI works too)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read leaf count from pool state.
 * @param {Uint8Array} data - Pool state account data
 * @returns {number}
 */
function readLeafCount(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return dv.getUint32(STATE_OFFSETS_V2.LEAF_COUNT, true); // little-endian
}

/**
 * Read current Merkle root from pool state (32 bytes as hex string).
 * @param {Uint8Array} data
 * @returns {string} hex string (no 0x prefix)
 */
function readCurrentRoot(data) {
  let hex = '';
  for (let i = 0; i < 32; i++) {
    hex += data[STATE_OFFSETS_V2.CURRENT_ROOT + i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Read Merkle frontier from pool state (20 × 32-byte hex strings).
 * @param {Uint8Array} data
 * @returns {string[]}
 */
function readFrontier(data) {
  const frontier = [];
  for (let i = 0; i < TREE_DEPTH; i++) {
    const off = STATE_OFFSETS_V2.FRONTIER + i * 32;
    let hex = '';
    for (let j = 0; j < 32; j++) hex += data[off + j].toString(16).padStart(2, '0');
    frontier.push(hex);
  }
  return frontier;
}

/**
 * Read VK finalized flag.
 * @param {Uint8Array} data
 * @returns {boolean}
 */
function readVkFinalized(data) {
  return data[STATE_OFFSETS_V2.VK_FINALIZED] === 1;
}

/**
 * Read all 256 Merkle roots from root_history ring buffer.
 * @param {Uint8Array} data
 * @returns {string[]} Array of 256 hex strings
 */
function readRootHistory(data) {
  const roots = [];
  for (let i = 0; i < ROOT_HISTORY_SIZE; i++) {
    const off = STATE_OFFSETS_V2.ROOT_HISTORY + i * 32;
    let hex = '';
    for (let j = 0; j < 32; j++) hex += data[off + j].toString(16).padStart(2, '0');
    roots.push(hex);
  }
  return roots;
}

/**
 * Check if a given Merkle root is still valid (present in the pool's in-state root history).
 * Auto-detects V3 vs V2 based on account size:
 *   V3 (8,992 bytes): root history at offset 720, 256 entries
 *   V2 (131,920 bytes): root history at offset 848, 256 entries
 *
 * @param {string} noteRootHex - hex string of the note's Merkle root (with or without 0x)
 * @param {Uint8Array} poolData - raw bytes of the pool state account
 * @returns {boolean}
 */
function isRootInHistory(noteRootHex, poolData) {
  // V3 state = 8,992 bytes; V2 state = ~9,040+ bytes (but monolithic V2 pool = 131,920)
  const isV3 = poolData.length <= 9000;
  const historyOffset = isV3 ? 720 : STATE_OFFSETS_V2.ROOT_HISTORY;
  const clean = noteRootHex.replace('0x', '').toLowerCase().padStart(64, '0');
  for (let i = 0; i < ROOT_HISTORY_SIZE; i++) {
    const off = historyOffset + i * 32;
    let slot = '';
    for (let j = 0; j < 32; j++) {
      slot += poolData[off + j].toString(16).padStart(2, '0');
    }
    if (slot === clean) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Merkle path computation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute Merkle path elements and indices for a given leaf index.
 * The frontier is the state captured at deposit time (before this leaf was inserted).
 *
 * @param {number} leafIndex
 * @param {string[]} frontier - 20-element array of hex strings (from readFrontier())
 * @returns {{ pathElements: bigint[], pathIndices: number[] }}
 */
function computeMerklePath(leafIndex, frontier) {
  const pathElements = [];
  const pathIndices = [];
  let idx = leafIndex;

  for (let level = 0; level < TREE_DEPTH; level++) {
    if ((idx & 1) === 0) {
      // Left child: sibling is the zero chain value (right placeholder)
      pathElements.push(hexToFr(ZERO_CHAIN_BE[level]));
      pathIndices.push(0);
    } else {
      // Right child: sibling is the frontier (saved left sibling)
      pathElements.push(hexToFr(frontier[level]));
      pathIndices.push(1);
    }
    idx = Math.floor(idx / 2);
  }

  return { pathElements, pathIndices };
}

/**
 * Compute Merkle paths for a batch of leaves, given the frontier BEFORE insertion.
 *
 * computeMerklePath(frontier) only works for the most recently inserted leaf.
 * This function simulates the incremental insertions one at a time, computing
 * a correct path for each leaf using the progressively updated frontier.
 *
 * @param {Object} poseidon - circomlibjs poseidon instance
 * @param {bigint[]} commitments - Array of commitments (in insertion order)
 * @param {number} firstLeafIndex - Index of the first leaf in the batch
 * @param {string[]} preFrontier - Frontier state BEFORE the batch was inserted
 * @returns {{ pathElements: bigint[], pathIndices: number[], root: string }[]}
 */
function computeBatchMerklePaths(poseidon, commitments, firstLeafIndex, preFrontier) {
  // Copy frontier so we can mutate it during simulation
  const frontier = [...preFrontier];
  const results = [];

  for (let i = 0; i < commitments.length; i++) {
    const leafIndex = firstLeafIndex + i;

    // 1. Compute path for this leaf using CURRENT frontier (before this insertion)
    const { pathElements, pathIndices } = computeMerklePath(leafIndex, frontier);

    // 2. Compute root = what the tree root will be after inserting this leaf
    const root = computeRoot(poseidon, commitments[i], pathElements, pathIndices)
      .toString(16).padStart(64, '0');

    results.push({ pathElements, pathIndices, root });

    // 3. Simulate this insertion: update frontier for the next leaf
    // MUST match on-chain logic (instructions_v2_clean.rs:682-707):
    //   node = hash(left, right);
    //   state.merkle_frontier[level] = node;  // ALWAYS updates with hash output
    let cur = commitments[i];
    let idx = leafIndex;
    for (let level = 0; level < TREE_DEPTH; level++) {
      if ((idx & 1) === 0) {
        cur = poseidon.F.toObject(poseidon([cur, hexToFr(ZERO_CHAIN_BE[level])]));
      } else {
        cur = poseidon.F.toObject(poseidon([hexToFr(frontier[level]), cur]));
      }
      // Match on-chain: ALWAYS update frontier with the computed hash at every level
      frontier[level] = cur.toString(16).padStart(64, '0');
      idx = Math.floor(idx / 2);
    }
  }

  return results;
}

/**
 * Compute Merkle root from leaf + path (for proof verification before submission).
 *
 * @param {Object} poseidon - circomlibjs poseidon instance
 * @param {bigint} leaf - leaf value (commitment)
 * @param {bigint[]} pathElements
 * @param {number[]} pathIndices
 * @returns {bigint}
 */
function computeRoot(poseidon, leaf, pathElements, pathIndices) {
  let cur = leaf;
  for (let i = 0; i < TREE_DEPTH; i++) {
    const left  = pathIndices[i] === 0 ? cur : pathElements[i];
    const right = pathIndices[i] === 0 ? pathElements[i] : cur;
    cur = poseidon.F.toObject(poseidon([left, right]));
  }
  return cur;
}

module.exports = {
  // State readers
  readLeafCount,
  readCurrentRoot,
  readFrontier,
  readVkFinalized,
  readRootHistory,
  isRootInHistory,

  // Merkle operations
  computeMerklePath,
  computeBatchMerklePaths,
  computeRoot,
};
