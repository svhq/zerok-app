/**
 * V3 SDK — Canonical Constants & PDA Derivation
 *
 * V3 = V1 backend (sharded state, small accounts) + V2 UX (memos, batching)
 * Uses V2's program ID (upgrade path) with V1's PDA seeds.
 *
 * CRITICAL INVARIANT: Every deposit MUST save note secrets for withdrawal.
 * See CRITICAL_INVARIANTS.md Invariant #1. NO EXCEPTIONS.
 */

'use strict';

const { PublicKey } = require("@solana/web3.js");
const crypto = require("crypto");

// =============================================================================
// PROGRAM ID — Reusing V2's program ID (upgrade, not new deployment)
// =============================================================================

// Mainnet default. Set ZEROK_PROGRAM_ID env var to override for devnet/testing.
const PROGRAM_ID = new PublicKey(process.env.ZEROK_PROGRAM_ID || "HVcTokFF4rwvcU7sC7GjS317CSf7QDgfCvW7edijKS2v");

// =============================================================================
// PDA SEEDS — V1-style (different from V2's "zerok_v2" seeds)
// =============================================================================

const SEEDS = {
  STATE: Buffer.from("zerok_v1"),
  VAULT: Buffer.from("vault"),
  VK: Buffer.from("vk"),
  NULLIFIER: Buffer.from("nullifier"),
  ROOT_RING: Buffer.from("roots"),
  RING_METADATA: Buffer.from("root_ring_metadata"),
  RING_SHARD: Buffer.from("root_ring_shard"),
};

// =============================================================================
// STATE ACCOUNT LAYOUT (V1 — ZerokStateV2Clean, 8,992 bytes)
// Source: programs/zerok_v3/src/state_v2_clean.rs
// =============================================================================

const STATE_OFFSETS = {
  DISCRIMINATOR: 0,
  DENOMINATION: 8,
  AUTHORITY: 16,
  FRONTIER: 48,
  ROOT: 688,
  ROOT_HISTORY: 720,
  VK_ACCOUNT: 8912,
  VK_HASH: 8944,
  ROOT_INDEX: 8976,
  LEAF_COUNT: 8980,
  MAX_FEE_BPS: 8984,
  VK_UPLOADED_BYTES: 8986,
  VERSION: 8988,
  VK_FINALIZED: 8989,
  PAUSED: 8990,
};

const TREE_DEPTH = 20;
const ROOT_HISTORY_SIZE = 256;   // In-state ring (for fast lookups)
const RING_CAPACITY = 2560;      // 20 shards × 128 entries (total root history)
const SHARD_CAPACITY = 128;
const NUM_SHARDS = 20;

// =============================================================================
// ACCOUNT SIZES
// =============================================================================

const ACCOUNT_SIZES = {
  STATE: 8992,
  VK: 1077,
  VK_HEADER: 49,
  VK_DATA: 1028,
  RING_METADATA: 680,
  SHARD: 5144,
  SHARD_HEADER: 24,
  SHARD_ENTRY: 40,
};

// =============================================================================
// DENOMINATIONS (same as V2)
// =============================================================================

const DENOMINATIONS = [
  1_000_000_000_000n,  // 1000 SOL
  100_000_000_000n,    // 100 SOL
  10_000_000_000n,     // 10 SOL
  1_000_000_000n,      // 1 SOL
  100_000_000n,        // 0.1 SOL
];

// =============================================================================
// CRYPTOGRAPHIC CONSTANTS
// =============================================================================

const BN254_P = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Zero chain values (big-endian hex, same as V1)
const ZERO_CHAIN_BE = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864",
  "1069673dcdb12263df301a6ff584a7ec261a44cb9dc68df067a4774460b1f1e1",
  "18f43331537ee2af2e3d758d50f72106467c6eea50371dd528d57eb2b856d238",
  "07f9d837cb17b0d36320ffe93ba52345f1b728571a568265caac97559dbc952a",
  "2b94cf5e8746b3f5c9631f4c5df32907a699c58c94b2ad4d7b5cec1639183f55",
  "2dee93c5a666459646ea7d22cca9e1bcfed71e6951b953611d11dda32ea09d78",
  "078295e5a22b84e982cf601eb639597b8b0515a88cb5ac7fa8a4aabe3c87349d",
  "2fa5e5f18f6027a6501bec864564472a616b2e274a41211a444cbe3a99f3cc61",
  "0e884376d0d8fd21ecb780389e941f66e45e7acce3e228ab3e2156a614fcd747",
  "1b7201da72494f1e28717ad1a52eb469f95892f957713533de6175e5da190af2",
  "1f8d8822725e36385200c0b201249819a6e6e1e4650808b5bebc6bface7d7636",
  "2c5d82f66c914bafb9701589ba8cfcfb6162b0a12acf88a8d0879a0471b5f85a",
  "14c54148a0940bb820957f5adf3fa1134ef5c4aaa113f4646458f270e0bfbfd0",
  "190d33b12f986f961e10c0ee44d8b9af11be25588cad89d416118e4bf4ebe80c",
  "22f98aa9ce704152ac17354914ad73ed1167ae6596af510aa5b3649325e06c92",
  "2a7c7c9b6ce5880b9f6f228d72bf6a575a526f29c66ecceef8b753d38bba7323",
  "2e8186e558698ec1c67af9c14d463ffc470043c9c2988b954d75dd643f36b992",
  "0f57c5571e9a4eab49e2c8cf050dae948aef6ead647392273546249d1c1ff10f",
  "1830ee67b5fb554ad5f63d4388800e1cfe78e310697d46e43c9ce36134f72cca",
];

// =============================================================================
// MEMO CONSTANTS
// =============================================================================

const MEMO_PREFIX_V3 = "zerok:v3:";
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

// =============================================================================
// INSTRUCTION DISCRIMINATORS
// =============================================================================

function discriminator(name) {
  return crypto.createHash("sha256").update("global:" + name).digest().slice(0, 8);
}

const DISCRIMINATORS = {
  DEPOSIT: discriminator("deposit_v2_clean"),
  WITHDRAW: discriminator("withdraw_v2_clean"),
  INIT_STATE: discriminator("initialize_with_vk_ref"),
  INIT_VK: discriminator("init_vk_account"),
  APPEND_VK: discriminator("append_vk_chunk"),
  FINALIZE_VK: discriminator("finalize_vk"),
  INIT_RING_META: discriminator("init_root_ring_v2_sharded"),
  INIT_SHARD: discriminator("init_shard"),
};

// =============================================================================
// STATE READING FUNCTIONS
// =============================================================================

function readFrontier(stateData) {
  const frontier = [];
  for (let i = 0; i < TREE_DEPTH; i++) {
    const offset = STATE_OFFSETS.FRONTIER + i * 32;
    frontier.push(stateData.slice(offset, offset + 32).toString("hex"));
  }
  return frontier;
}

function readRoot(stateData) {
  return stateData.slice(STATE_OFFSETS.ROOT, STATE_OFFSETS.ROOT + 32).toString("hex");
}

function readLeafCount(stateData) {
  return stateData.readUInt32LE(STATE_OFFSETS.LEAF_COUNT);
}

function readRootIndex(stateData) {
  return stateData.readUInt32LE(STATE_OFFSETS.ROOT_INDEX);
}

function readDenomination(stateData) {
  return stateData.readBigUInt64LE(STATE_OFFSETS.DENOMINATION);
}

// =============================================================================
// FIELD ELEMENT UTILITIES
// =============================================================================

function hexToFr(hex) {
  return BigInt("0x" + hex.replace("0x", "").padStart(64, '0')) % FIELD_MODULUS;
}

function fieldToBytesBE(bn) {
  return Buffer.from(bn.toString(16).padStart(64, '0'), 'hex');
}

function splitAddress(address) {
  const bytes = Buffer.from(address.toBytes());
  return {
    high: BigInt("0x" + bytes.slice(0, 16).toString("hex")),
    low: BigInt("0x" + bytes.slice(16, 32).toString("hex")),
  };
}

// =============================================================================
// PROOF SERIALIZATION
// =============================================================================

function g2ToBE(coords) {
  const x_c1 = fieldToBytesBE(BigInt(coords[0][1]));
  const x_c0 = fieldToBytesBE(BigInt(coords[0][0]));
  const y_c1 = fieldToBytesBE(BigInt(coords[1][1]));
  const y_c0 = fieldToBytesBE(BigInt(coords[1][0]));
  return Buffer.concat([x_c1, x_c0, y_c1, y_c0]);
}

function serializeProof(proof) {
  const buffer = Buffer.alloc(256);
  let offset = 0;

  // A: negated
  const pi_a_x = BigInt(proof.pi_a[0]);
  const pi_a_y_neg = BN254_P - BigInt(proof.pi_a[1]);
  fieldToBytesBE(pi_a_x).copy(buffer, offset); offset += 32;
  fieldToBytesBE(pi_a_y_neg).copy(buffer, offset); offset += 32;

  // B: G2 with (c1, c0) order
  g2ToBE(proof.pi_b).copy(buffer, offset); offset += 128;

  // C: normal G1
  fieldToBytesBE(BigInt(proof.pi_c[0])).copy(buffer, offset); offset += 32;
  fieldToBytesBE(BigInt(proof.pi_c[1])).copy(buffer, offset); offset += 32;

  return buffer;
}

// =============================================================================
// PDA DERIVATION
// =============================================================================

function derivePDAs(denomination) {
  const denominationBytes = Buffer.alloc(8);
  denominationBytes.writeBigUInt64LE(BigInt(denomination));

  const [statePda] = PublicKey.findProgramAddressSync(
    [SEEDS.STATE, denominationBytes], PROGRAM_ID
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [SEEDS.VAULT, denominationBytes], PROGRAM_ID
  );
  const [vkPda] = PublicKey.findProgramAddressSync(
    [SEEDS.VK, denominationBytes], PROGRAM_ID
  );
  const [rootRingPda] = PublicKey.findProgramAddressSync(
    [SEEDS.ROOT_RING, statePda.toBuffer()], PROGRAM_ID
  );
  const [ringMetaPda] = PublicKey.findProgramAddressSync(
    [SEEDS.RING_METADATA, statePda.toBuffer()], PROGRAM_ID
  );

  return { statePda, vaultPda, vkPda, rootRingPda, ringMetaPda, denominationBytes };
}

function deriveShardPda(statePda, shardIndex) {
  const shardIdxBuf = Buffer.alloc(4);
  shardIdxBuf.writeUInt32LE(shardIndex, 0);
  const [shardPda] = PublicKey.findProgramAddressSync(
    [SEEDS.RING_SHARD, statePda.toBuffer(), shardIdxBuf], PROGRAM_ID
  );
  return shardPda;
}

function deriveAllShardPdas(statePda) {
  const shards = [];
  for (let i = 0; i < NUM_SHARDS; i++) {
    shards.push(deriveShardPda(statePda, i));
  }
  return shards;
}

function deriveNullifierPda(statePda, nullifierHashBE) {
  const [nullifierPda] = PublicKey.findProgramAddressSync(
    [SEEDS.NULLIFIER, statePda.toBuffer(), nullifierHashBE], PROGRAM_ID
  );
  return nullifierPda;
}

// =============================================================================
// MERKLE PATH COMPUTATION
// =============================================================================

function computeMerklePath(leafIndex, frontier) {
  const pathElements = [];
  const pathIndices = [];
  let idx = leafIndex;

  for (let level = 0; level < TREE_DEPTH; level++) {
    if ((idx & 1) === 0) {
      pathElements.push(hexToFr(ZERO_CHAIN_BE[level]));
      pathIndices.push(0);
    } else {
      pathElements.push(hexToFr(frontier[level]));
      pathIndices.push(1);
    }
    idx = Math.floor(idx / 2);
  }

  return { pathElements, pathIndices };
}

function computeRoot(poseidon, commitment, pathElements, pathIndices) {
  let current = commitment;
  for (let i = 0; i < TREE_DEPTH; i++) {
    const left = pathIndices[i] === 0 ? current : pathElements[i];
    const right = pathIndices[i] === 0 ? pathElements[i] : current;
    current = poseidon.F.toObject(poseidon([left, right]));
  }
  return current;
}

// =============================================================================
// ROOT VALIDATION (checks all 20 shards)
// =============================================================================

/**
 * Check if a root exists in any of the 20 shards.
 * @param {Connection} connection
 * @param {PublicKey} statePda
 * @param {Buffer} rootBytes - 32-byte root to check
 * @returns {Promise<{found: boolean, shardIndex: number}>}
 */
async function isRootInShardRing(connection, statePda, rootBytes) {
  // First check in-state 256-entry history (fast)
  const stateInfo = await connection.getAccountInfo(statePda);
  if (!stateInfo) return { found: false, shardIndex: -1 };

  for (let i = 0; i < ROOT_HISTORY_SIZE; i++) {
    const offset = STATE_OFFSETS.ROOT_HISTORY + i * 32;
    if (stateInfo.data.slice(offset, offset + 32).equals(rootBytes)) {
      return { found: true, shardIndex: -1 }; // Found in state history
    }
  }

  // Check all 20 shards
  const shardPdas = deriveAllShardPdas(statePda);
  const shardInfos = await connection.getMultipleAccountsInfo(shardPdas);

  for (let s = 0; s < NUM_SHARDS; s++) {
    const info = shardInfos[s];
    if (!info) continue;

    for (let e = 0; e < SHARD_CAPACITY; e++) {
      const offset = ACCOUNT_SIZES.SHARD_HEADER + e * ACCOUNT_SIZES.SHARD_ENTRY;
      const entryRoot = info.data.slice(offset, offset + 32);
      if (entryRoot.equals(rootBytes)) {
        return { found: true, shardIndex: s };
      }
    }
  }

  return { found: false, shardIndex: -1 };
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  PROGRAM_ID,
  SEEDS,
  STATE_OFFSETS,
  ACCOUNT_SIZES,
  TREE_DEPTH,
  ROOT_HISTORY_SIZE,
  RING_CAPACITY,
  SHARD_CAPACITY,
  NUM_SHARDS,
  DENOMINATIONS,
  BN254_P,
  FIELD_MODULUS,
  ZERO_CHAIN_BE,
  MEMO_PREFIX_V3,
  MEMO_PROGRAM_ID,
  DISCRIMINATORS,

  readFrontier,
  readRoot,
  readLeafCount,
  readRootIndex,
  readDenomination,

  hexToFr,
  fieldToBytesBE,
  splitAddress,

  serializeProof,
  discriminator,

  derivePDAs,
  deriveShardPda,
  deriveAllShardPdas,
  deriveNullifierPda,

  computeMerklePath,
  computeRoot,

  isRootInShardRing,
};
