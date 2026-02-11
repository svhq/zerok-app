# ZeroK Circuits

Zero-knowledge circuits for the ZeroK privacy protocol on Solana.

## Overview

The main circuit (`withdraw.circom`) proves that a user knows a valid deposit commitment within a Merkle tree, without revealing which deposit is theirs. This enables private withdrawals from the protocol's deposit pools.

## Circuit: `withdraw.circom`

### What It Does

The withdrawal circuit proves:
1. The prover knows a `nullifier` and `secret` that hash to a valid commitment
2. That commitment exists in the on-chain Merkle tree (via a valid Merkle path to the root)
3. The `nullifierHash` is correctly derived from the `nullifier` (prevents double-spending)
4. The proof is bound to a specific recipient and fee (prevents front-running)

### Public Inputs

| Input | Description |
|-------|-------------|
| `root` | Current Merkle tree root (verified on-chain) |
| `nullifierHash` | Hash of the nullifier (used for double-spend prevention) |
| `recipientHigh` | Bytes 0-15 of recipient Solana pubkey |
| `recipientLow` | Bytes 16-31 of recipient Solana pubkey |
| `feePayerHigh` | Bytes 0-15 of fee payer pubkey |
| `feePayerLow` | Bytes 16-31 of fee payer pubkey |
| `fee` | Protocol fee amount |
| `refund` | Refund amount |
| `owner_hash` | Light Protocol owner hash |
| `tree_hash` | Light Protocol tree hash |
| `leaf_index` | Leaf index in the Merkle tree |
| `discriminator` | 8-byte account discriminator |

### Private Inputs

| Input | Description |
|-------|-------------|
| `nullifier` | Random secret used for double-spend prevention |
| `secret` | Random secret used for commitment generation |
| `pathElements` | Merkle proof sibling hashes (20 levels) |
| `pathIndices` | Merkle proof path directions (0 = left, 1 = right) |

## Light Protocol Integration

The circuit integrates with [Light Protocol](https://www.lightprotocol.com/) for ZK-compressed state on Solana. The `light_protocol/` subdirectory contains:

- `light_leaf_hash.circom` - Computes Light Protocol leaf hashes using Poseidon
- `data_hash.circom` - Wraps commitment with Light Protocol's data hash format
- `discriminator_field.circom` - Converts 8-byte discriminator to a BN254 field element

## How to Compile

```bash
# Install dependencies
npm install

# Compile the circuit
circom withdraw.circom --r1cs --wasm --sym
```

## Dependencies

- **circomlib** - Provides Poseidon hash and bitfield utilities
  - `poseidon.circom` - Poseidon hash function (BN254-friendly)
  - `bitify.circom` - Num2Bits for path index conversion

## Merkle Tree

The circuit uses a 20-level binary Merkle tree with Poseidon hashing, supporting up to 2^20 (1,048,576) deposits per pool.

## Proof System

- **Proof system**: Groth16 (zkSNARK)
- **Curve**: BN254
- **Hash function**: Poseidon (arithmetic-friendly, efficient in-circuit)

This is the same circuit used in production. Verification keys are generated during trusted setup.
