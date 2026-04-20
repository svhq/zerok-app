/**
 * ZeroK v2-core — Shared Constants
 *
 * Single source of truth for protocol constants used by both CLI and browser.
 * No environment-specific dependencies (no Buffer, no fs, no process).
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Tree parameters
// ─────────────────────────────────────────────────────────────────────────────

const TREE_DEPTH = 20;
const ROOT_HISTORY_SIZE = 256;

// ─────────────────────────────────────────────────────────────────────────────
// Cryptographic constants (BN254 curve)
// ─────────────────────────────────────────────────────────────────────────────

const BN254_P = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// ─────────────────────────────────────────────────────────────────────────────
// Zero chain — Poseidon zero-value hashes for each tree level (hex BE)
// zeroChain[0] = 0, zeroChain[i] = Poseidon(zeroChain[i-1], zeroChain[i-1])
// Must match constants.rs ZERO_CHAIN in the on-chain program.
// ─────────────────────────────────────────────────────────────────────────────

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
  "2134e79a37d8a3cf24d1a58d77e2d5a2fb7d9f8b64b6c21eab1ad2c56ae73421",
];

// ─────────────────────────────────────────────────────────────────────────────
// Pool state account layout (byte offsets)
// Matches programs/zerok_v2/src/state.rs with denomination field at offset 16
// ─────────────────────────────────────────────────────────────────────────────

const STATE_OFFSETS_V2 = {
  DISC:             0,    // 8 bytes — anchor discriminator
  VERSION:          8,    // u8
  PAUSED:           9,    // u8
  VK_FINALIZED:     10,   // u8
  PAD0:             11,   // [u8; 5]
  DENOMINATION:     16,   // u64 — pool denomination in lamports
  AUTHORITY:        24,   // Pubkey (32)
  PROTOCOL_WALLET:  56,   // Pubkey (32)
  VK_ACCOUNT:       88,   // Pubkey (32)
  VK_HASH:          120,  // [u8; 32]
  VK_UPLOADED_BYTES:152,  // u32
  PAD1:             156,  // [u8; 4]
  MAX_FEE_BPS:      160,  // u16
  PAD2:             162,  // [u8; 6]
  LEAF_COUNT:       168,  // u32
  ROOT_INDEX:       172,  // u32
  FRONTIER:         176,  // [[u8; 32]; 20] = 640 bytes
  CURRENT_ROOT:     816,  // [u8; 32]
  ROOT_HISTORY:     848,  // [[u8; 32]; 256] = 8192 bytes
};

const ACCOUNT_SIZES_V2 = {
  STATE: 9040, // 8 (disc) + 840 (base fields) + 256*32 (root history)
  VK: 1100,      // 8 (disc) + 1092 (VK bytes)
  NULLIFIER: 96, // 8 + 32 + 32 + 8 + 8 + 8
};

// ─────────────────────────────────────────────────────────────────────────────
// PDA seed strings (consumers wrap with Buffer.from() or TextEncoder.encode())
// ─────────────────────────────────────────────────────────────────────────────

const SEEDS_V2 = {
  STATE:     "zerok_v2",
  VAULT:     "vault_v2",
  VK:        "vk_v2",
  NULLIFIER: "nullifier_v2",
};

// ─────────────────────────────────────────────────────────────────────────────
// Denominations (descending order for greedy decomposition)
// ─────────────────────────────────────────────────────────────────────────────

const DENOMINATIONS = [
  1_000_000_000_000n,  // 1000 SOL
  100_000_000_000n,    // 100 SOL
  10_000_000_000n,     // 10 SOL
  1_000_000_000n,      // 1 SOL
  100_000_000n,        // 0.1 SOL
];

// ─────────────────────────────────────────────────────────────────────────────
// Memo prefixes
// ─────────────────────────────────────────────────────────────────────────────

const MEMO_PREFIX_V2 = "zerok:v2:";
const MEMO_PREFIX_BATCH = "zerok:v2:b:";

module.exports = {
  TREE_DEPTH,
  ROOT_HISTORY_SIZE,
  BN254_P,
  FIELD_MODULUS,
  ZERO_CHAIN_BE,
  STATE_OFFSETS_V2,
  ACCOUNT_SIZES_V2,
  SEEDS_V2,
  DENOMINATIONS,
  MEMO_PREFIX_V2,
  MEMO_PREFIX_BATCH,
};
