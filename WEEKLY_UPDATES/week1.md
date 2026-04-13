# Week 1: Solving Phantom Lighthouse & Blowfish Warnings

## The Problem

When we deployed ZeroK to Solana mainnet with Phantom wallet, users encountered two critical blocking issues:

### 1. Phantom Lighthouse — "Request blocked"

Phantom's security scanner (Lighthouse/Blowfish) flagged ZeroK deposits as potentially malicious. Users saw a red "Request blocked" warning with "This dApp could be malicious. Do not proceed unless you are certain it is safe."

**Root cause**: The V2 state account was **131,920 bytes**. Phantom's Lighthouse guard blocks transactions that write to large program-owned accounts from unverified dApps. At 131KB, our state account was well above the threshold that triggers Blowfish's risk heuristics.

### 2. Batch-Signing Warning — "Are you sure?"

Even if users clicked "Proceed anyway (unsafe)", they faced a second warning: the `signAllTransactions` + `sendRawTransaction` pattern (used for multi-note deposits) triggered Blowfish's batch-signing risk alert. Users had to check "I understand that I could lose all of my funds" — an unacceptable UX for a privacy tool.

## The Solution

### V3 Sharded Architecture (Lighthouse fix)

We redesigned the on-chain state from a single monolithic account to a sharded architecture:

| | V2 | V3 |
|---|---|---|
| **State account** | 131,920 bytes | **8,992 bytes** |
| **Root history** | 4,096 roots in one account | 256 in-state + 2,560 across 20 shards |
| **Shard accounts** | N/A | 20 × 5,144 bytes each |
| **Largest single account** | 131,920 bytes | **8,992 bytes** |

The key insight: Phantom's Lighthouse only checks **individual account sizes**. By splitting the root history across 20 separate shard accounts (each under 6KB), no single account exceeds the threshold that triggers the security scanner. The state account itself dropped from 131KB to under 9KB.

This is implemented in `programs/zerok_v3/src/state_v2_clean.rs`:
```rust
const _SIZE_CHECK: () = assert!(Self::SIZE == 8984, "ZerokStateV2Clean size must be 8984 bytes");
```

### Batch Deposit Instruction (Blowfish fix)

We replaced the problematic transaction pattern:

**Before (V2)**: `signAllTransactions([tx1, tx2, ...])` → `sendRawTransaction(tx1)` → `sendRawTransaction(tx2)` → ...

This pattern is flagged by Blowfish because it asks the wallet to sign multiple transactions upfront, then submits them raw — a pattern commonly used in drainer attacks.

**After (V3)**: A new on-chain instruction `deposit_batch_v2_clean` packs up to 15 commitments into a **single instruction** within a **single transaction**. The browser uses `sendTransaction` (one tx) or Phantom's `signAndSendAllTransactions` (for 2 txs), never the banned `signAllTransactions + sendRawTransaction` combination.

The batch instruction is in `programs/zerok_v3/src/instructions_v2_clean.rs` and accepts:
```
disc(8) + vec_len(4 LE) + N × commitment_be(32)
```

The browser-side KISS routing (in `web/src/components/PrivateCard.tsx`):
- 1 note per pool → `deposit_v2_clean` (proven single instruction)
- 2+ notes per pool → `deposit_batch_v2_clean` (efficient batching)

## Result

- **Zero Phantom warnings** — tested on mainnet with 0.1, 0.3, 0.9, 1.9, 19.9, 29.9 SOL deposits
- **Single wallet popup** for deposits up to ~25 notes
- **No Blowfish "Are you sure?" dialogs**
- **Production live** at [app.zerok.app](https://app.zerok.app)

## Verification

- Mainnet program: [`HVcTokFF4rwvcU7sC7GjS317CSf7QDgfCvW7edijKS2v`](https://solscan.io/account/HVcTokFF4rwvcU7sC7GjS317CSf7QDgfCvW7edijKS2v)
- State account size: 8,992 bytes (verifiable on Solscan by checking any pool state PDA)
- V3 source code: `programs/zerok_v3/src/` in this repository
