# ZeroK Program

On-chain privacy protocol that verifies zero-knowledge proofs and manages deposit pools on Solana.

## Program Details

| Field | Value |
|-------|-------|
| **Program Name** | ZeroK |
| **Network** | Solana |
| **Program ID** | `JCim8dPqwM16pfwQxFJHCzVA9HrG5Phdjen7PTC3dffx` |
| **Framework** | Anchor |
| **Proof System** | Groth16 (BN254) |

[View on Solana Explorer](https://explorer.solana.com/address/JCim8dPqwM16pfwQxFJHCzVA9HrG5Phdjen7PTC3dffx)

## Description

The ZeroK program is the on-chain component of the ZeroK privacy protocol. It manages deposit pools, verifies zero-knowledge proofs during withdrawals, and maintains Merkle trees of commitments. Users deposit SOL into denomination-specific pools, receiving a cryptographic note. Later, they can withdraw by proving knowledge of a valid commitment without revealing which deposit is theirs.

## Instructions Overview

### Pool Lifecycle

| Instruction | Description |
|-------------|-------------|
| `initialize` / `initialize_v2` / `initialize_state_v2_clean` | Initialize a new deposit pool with a given denomination |
| `initialize_vault_v2_clean` | Create the SOL vault PDA for a pool |
| `set_authority` | Transfer pool authority to a new pubkey |
| `pause_v2_clean` / `unpause_v2_clean` | Emergency pause/unpause |
| `update_security_config` | Update max fee bps, daily limits, emergency pause |
| `view_state` | Read-only view of pool state |

### Deposits & Withdrawals

| Instruction | Description |
|-------------|-------------|
| `deposit` / `deposit_v2` / `deposit_v2_clean` | Deposit SOL and record a commitment on-chain |
| `withdraw` / `withdraw_v2` / `withdraw_v2_clean` | Withdraw SOL by providing a valid ZK proof |
| `withdraw_light` | Withdraw using Light Protocol compressed accounts |

### Verifying Key Management

| Instruction | Description |
|-------------|-------------|
| `init_vk_account` | Initialize a VK account for chunked upload |
| `append_vk_chunk` / `upload_vk_chunk_v2_clean` | Upload verifying key data in chunks |
| `finalize_vk` / `finalize_vk_v2_clean` | Finalize VK after all chunks uploaded |
| `bind_vk` | Bind a finalized VK to a pool |
| `initialize_vk_pda_v2_clean` | Initialize the VK PDA for a pool |

### Root Ring Buffer

| Instruction | Description |
|-------------|-------------|
| `init_root_ring` | Initialize root ring buffer |
| `init_root_ring_v2_sharded` | Initialize sharded root ring with metadata |
| `init_shard` | Initialize an individual root ring shard |
| `advance_active_shard` | Advance to next shard when current is full |

### Utilities

| Instruction | Description |
|-------------|-------------|
| `get_merkle_path` | Retrieve Merkle proof for a given leaf index |
| `initialize_cooldown_config` | Set up deposit cooldown |
| `update_cooldown_config` | Update cooldown parameters |
| `migrate_to_vault` | Migrate pool funds to vault PDA |
| `repair_state` | Admin-only state recovery |

## IDL

The program IDL is available at [`idl/zerok.json`](./idl/zerok.json). It contains instruction definitions, account structures, events, and error codes.

## Source Code

The program IDL and interface are provided for reference and integration. On-chain program verification is available via [Solana Explorer](https://explorer.solana.com/address/JCim8dPqwM16pfwQxFJHCzVA9HrG5Phdjen7PTC3dffx).
