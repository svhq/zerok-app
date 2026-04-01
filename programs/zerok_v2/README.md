# ZeroK V2 Program

**Program ID:** `HVcTokFF4rwvcU7sC7GjS317CSf7QDgfCvW7edijKS2v`

**Network:** Solana Mainnet

**Framework:** Anchor

---

## Architecture

V2 uses a JoinSplit model where commitments encode the deposit amount:

```
commitment = Poseidon(3)(amount, nullifier, secret)
```

This enables partial withdrawals with change notes — deposit 10 SOL, withdraw 3 SOL, receive a 7 SOL change note automatically.

## Key Differences from V1

| Feature | V1 | V2 |
|---------|----|----|  
| Commitment | `Poseidon(2)(nullifier, secret)` | `Poseidon(3)(amount, nullifier, secret)` |
| Withdrawal | Full denomination only | Partial (JoinSplit with change note) |
| Merkle Tree | Light Protocol compressed | Custom on-chain incremental |
| Root History | 30 entries | 4,096 entries (~20-82 day window) |
| Denominations | 1, 10, 100, 1000 SOL | 0.1, 1, 10, 100, 1000 SOL |
| Fees | Protocol-paid | Protocol-paid (0.3%, min 0.002 SOL) |
| Re-denomination | Not available | 1 note -> 10 smaller notes (private) |

## Denominations

| Pool | Denomination |
|------|--------------|
| 0.1 SOL | 100,000,000 lamports |
| 1 SOL | 1,000,000,000 lamports |
| 10 SOL | 10,000,000,000 lamports |
| 100 SOL | 100,000,000,000 lamports |
| 1000 SOL | 1,000,000,000,000 lamports |

## Instructions

| Instruction | Description |
|-------------|-------------|
| `deposit_v2` | Deposit SOL + Poseidon commitment into pool |
| `withdraw_v2` | JoinSplit withdrawal with ZK proof |
| `re_denominate_v2` | Break 1 note into 10 smaller notes across pools |
| `initialize_pool_v2` | Create a new denomination pool |
| `grow_pool_state_v2` | Expand pool state account (realloc pattern) |
| `upload_vk_chunk_v2` | Upload verification key in chunks |
| `finalize_vk_v2` | Lock VK with SHA-256 integrity check |
| `set_paused_v2` | Emergency pause/unpause deposits |

## Program Interface

The complete Anchor IDL is available at [`idl/zerok_v2.json`](idl/zerok_v2.json).

The program source code is not published. The on-chain binary is verifiable via [Solana Explorer](https://solscan.io/account/HVcTokFF4rwvcU7sC7GjS317CSf7QDgfCvW7edijKS2v).

## Circuit Source

The ZK circuits are fully open source:
- [`circuits/v2/withdraw.circom`](../../circuits/v2/withdraw.circom) — JoinSplit withdrawal (9 public inputs)
- [`circuits/v2/re_denominate.circom`](../../circuits/v2/re_denominate.circom) — Re-denomination (12 public inputs)
