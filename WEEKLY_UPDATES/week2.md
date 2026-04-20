# Week 2: UX Optimization — Any-Amount Deposits & Wallet-as-Recovery-Key

## Theme

Users should feel safe and never hit friction. That means two things:

1. **Deposit any amount.** Enter `2.3 SOL` — not "pick 1 or 10." We handle the privacy math.
2. **Never lose access.** Your wallet is your recovery key. No files, no backups, no anxiety.

Under the hood, privacy pools require fixed denominations (every deposit must look identical). Week 2 is about hiding that complexity behind a seamless UI.

---

## Part 1: Any-Amount Deposits via Greedy Splitting

### The Problem

Traditional privacy pools force users into a decision tree:

> "Do I want to deposit 1 SOL or 10 SOL? What if I want to deposit 2.3 SOL? Do I make a 1-SOL deposit and then two 0.1 SOL deposits separately? What if I forget one?"

This is a showstopper. It bleeds users who don't want to think about denominations, note bookkeeping, or multi-step flows.

### The Solution — `greedySplit()`

Enter any amount. The app automatically decomposes it into denomination-sized pieces, then packs everything into a single batch deposit instruction (Week 1's Blowfish fix).

```javascript
function greedySplit(lamports, availableDenoms) {
  const denoms = availableDenoms || DENOMINATIONS;
  const steps = [];
  let remaining = BigInt(lamports);
  for (const d of denoms) {
    while (remaining >= d) {
      steps.push(d);
      remaining -= d;
    }
  }
  return steps;
}
```

Twelve lines, pure math. Given `2.3 SOL` and pool denominations `[1000, 100, 10, 1, 0.1]` SOL, it returns `[2×1 SOL, 3×0.1 SOL]`. The deposit flow then batches those 5 commitments into one on-chain instruction — **one wallet popup, no manual splitting**.

**Code**: [`sdk/v2-core/planner.js`](../sdk/v2-core/planner.js)

### Withdrawal Planning — Dual-Strategy Optimizer

Withdrawing is harder: you can only spend notes you actually own. `planWithdrawal()` in the same file runs two strategies and picks whichever minimizes total transactions:

- **Strategy A (greedy split)**: decompose the target amount, then break larger notes if needed
- **Strategy B (inventory-aware)**: use existing small notes first, fill the rest greedy

Example: withdrawing 50 SOL with inventory `{100 SOL: 1, 0.1 SOL: 3}`:
- Strategy A: `greedySplit(50) = 5×10` → 1 redenom (100→10) + 5 withdrawals = **6 txs**
- Strategy B: use `3×0.1` first → need 49.7 → cascade redenoms → 26 txs
- Winner: A

This runs automatically when the user types an amount. They see a single "Send" button, not a transaction count.

**Code**: [`sdk/v2-core/planner.js`](../sdk/v2-core/planner.js) — `planWithdrawal()`

### Shared Math Between Browser & CLI

`sdk/v2-core/` is the single source of truth for:

| File | Purpose |
|---|---|
| `planner.js` | Greedy splitter + withdrawal planner |
| `constants.js` | Denominations, tree depth, zero chain |
| `field.js` | BN254 field helpers (BE encoding) |
| `fee.js` | 0.3% / 0.002 SOL min protocol fee |
| `merkle.js` | Incremental Merkle tree simulator |
| `note.js` | Note commitment structure |
| `witness.js` | JoinSplit witness builder |
| `v3-witness.js` | V3 withdrawal witness builder |
| `proof-serialize.js` | Groth16 → on-chain byte layout |
| `relay.js` | Relay message format |

Pure JavaScript, no environment dependencies — same code runs in the browser (webpack alias `v2-core → sdk/v2-core/`) and in CLI scripts. Judges can read all 11 files and see every line of protocol math.

---

## Part 2: Three-Layer Note Recovery — Your Wallet is Your Key

In most privacy protocols, if you lose the file containing your private note, your funds are gone forever. We needed to solve this without compromising privacy.

### Layer 1: Local Cache (Instant)

Every note is saved to browser localStorage the moment it's created, scoped by chain ID and wallet address. Survives page refreshes, tab closures, browser restarts. Schema-versioned (`CACHE_SCHEMA_VERSION = 4`) to auto-clear on breaking changes.

**Code**: [`web/src/lib/note-cache.ts`](../web/src/lib/note-cache.ts)

### Layer 2: On-Chain Encrypted Memos (Cross-Device)

This is the breakthrough. When you deposit, ZeroK encrypts your note using a key derived from your wallet's signature:

```
wallet.signMessage("zerok-note-recovery-v1") → SHA-256 → AES-256-GCM key
```

The encrypted note is embedded directly in the deposit transaction as a Solana Memo instruction — stored **on-chain forever**.

To recover: reconnect the same wallet on any browser, any device. ZeroK scans the pool's transaction history, finds memos encrypted with your wallet's key, decrypts them locally, restores your private balance.

**Key innovations**:
- **V5 Seed Memos**: one 157-byte seed recovers 6+ notes — an 80% reduction in memo overhead vs. one-memo-per-note.
- **Pool-based scanning**: we scan the pool's state PDA (bounded, ZeroK-only transactions), not your wallet's full history.
- **Checkpoint system**: recovery resumes from where it left off — reconnecting after the first scan is near-instant.

**Code**: [`web/src/lib/note-encryption.ts`](../web/src/lib/note-encryption.ts), [`web/src/lib/note-recovery.ts`](../web/src/lib/note-recovery.ts)

### Layer 3: Downloadable Note Files (Offline Backup)

For belt-and-suspenders users: each file contains the cryptographic secrets needed for withdrawal (nullifier, secret, leaf index, Merkle path, root). Even if you lose your wallet AND clear your browser, a saved note file can still withdraw.

**Code**: [`web/src/lib/note-export.ts`](../web/src/lib/note-export.ts)

### How They Stack

| Scenario | Layer 1 | Layer 2 | Layer 3 |
|---|:---:|:---:|:---:|
| Refresh page | ✅ | — | — |
| Clear browser data | ❌ | ✅ | ✅ |
| Switch to new device | ❌ | ✅ | ✅ |
| Lose wallet seed | ❌ | ❌ | ✅ |

For most users, their wallet **is** their recovery key — no file management needed.

---

## Part 3: JoinSplit — The Path to Arbitrary-Amount Withdrawals

The greedy splitter solves any-amount **deposits**. Withdrawing arbitrary amounts (not just clean denomination multiples) requires one more primitive: **JoinSplit with private change notes**.

### The Design

A JoinSplit withdrawal proves, in zero-knowledge:
- Input commitment `C_in = Poseidon(amount_in, nullifier_in, secret_in)` exists in the Merkle tree
- Output change commitment `C_out = Poseidon(amount_out, nullifier_out, secret_out)` is inserted
- `amount_in = amount_to_recipient + amount_out + fee`

The withdrawal releases `amount_to_recipient` to the user's chosen address and inserts the change note `C_out` back into the pool — privately. The change note is yours to spend later; observers see only a standard deposit/withdrawal, not a link.

### Public Circuit

The full JoinSplit circuit is published in this repo:

- [`circuits/v2/withdraw.circom`](../circuits/v2/withdraw.circom) — 9 public inputs, JoinSplit balance constraint
- [`circuits/v2/re_denominate.circom`](../circuits/v2/re_denominate.circom) — 12 public inputs, 1-to-10 splitter

The browser-side JoinSplit witness builder is also public:

- [`sdk/v2-core/witness.js`](../sdk/v2-core/witness.js) — `buildJoinSplitWitness()`, `buildReDenomWitness()`

### Current Status

V3 (the mainnet production program) uses the simpler fixed-denomination model — `Poseidon(2)(nullifier, secret)` — for auditability and lower on-chain verification cost. JoinSplit is production-tested on devnet and stays on the roadmap as the path to true arbitrary-amount withdrawals without redenom cascades.

**Program docs**: [`programs/zerok_v2/README.md`](../programs/zerok_v2/README.md)

---

## Verified on Mainnet

- Deposits: 0.3 / 0.9 / 1.9 / 19.9 / 29.9 SOL — all single wallet popup, zero Phantom warnings
- Cross-browser recovery: deposited in Edge, recovered in Chrome — 11 notes, all withdrawn
- Interrupted session: closed browser mid-deposit, reopened, all notes recovered
- V5 seed memo: one memo recovers 9 notes

## Files Shipped This Week

**New in this push** — `sdk/v2-core/` (11 files): the shared math layer enabling any-amount deposits in the browser.

**Already in repo** — Note recovery infrastructure (`web/src/lib/note-*.ts`), JoinSplit circuits (`circuits/v2/`), V2 program interface (`programs/zerok_v2/README.md` + IDL).

## Aggregate Narrative — Weeks 1+2

> "We took a protocol that Phantom was blocking and made it production-ready. Then we made fixed-denomination privacy feel like Uniswap — enter any amount, reconnect any wallet, it just works. Users never touch a note file. Their wallet is the key."
