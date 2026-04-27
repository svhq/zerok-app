# ZeroK Architecture

High-level overview of the ZeroK protocol design.

---

## Protocol Overview

ZeroK provides deposit-withdrawal unlinkability through zero-knowledge proofs. Users deposit SOL into a shared pool governed by a Solana smart contract. When withdrawing, they generate a cryptographic proof demonstrating they previously made a valid deposit — without revealing which one. The result is a complete break in the on-chain transaction graph between sender and recipient.

## Deposit Flow

1. **Wallet connection** — The user connects a Solana wallet to the ZeroK application.
2. **Pool selection** — The user selects a pool denomination to deposit into.
3. **Commitment generation** — The application generates a random secret and computes a cryptographic commitment (a Poseidon hash of the secret values).
4. **On-chain deposit** — SOL is transferred to the shared pool smart contract, and the commitment is recorded in the on-chain Merkle tree.
5. **Note delivery** — The application produces a private note containing the secret values needed for withdrawal. This note is the user's sole proof of deposit ownership and must be stored securely.

The smart contract holds all deposited funds. Withdrawals require a valid zero-knowledge proof that only the note holder can generate.

## Withdrawal Flow

1. **Note loading** — The user loads their private note into the ZeroK application.
2. **Proof generation** — The browser constructs a zero-knowledge proof entirely on the user's device. This proof demonstrates that (a) the user knows the secret behind a valid commitment in the Merkle tree, and (b) the associated nullifier has not been used before — all without revealing which commitment is theirs.
3. **On-chain verification** — The smart contract verifies the Groth16 proof, checks the nullifier against its registry to prevent double-spending, and confirms the Merkle root is valid.
4. **Fund release** — Upon successful verification, the smart contract releases the denomination amount (minus a small protocol fee) to the recipient address specified by the user.

The entire process reveals nothing about the original depositor. From the perspective of on-chain observers, the withdrawal could correspond to any deposit in the pool.

## Privacy Model

### Anonymity Sets

Privacy strength is determined by the size of the anonymity set — the number of deposits in a given pool. Each withdrawal could plausibly correspond to any unspent deposit in the pool. Larger anonymity sets provide stronger privacy guarantees.

### Collective Privacy

Every new deposit strengthens the privacy of all participants in that pool. Privacy is a shared resource: the more users participate, the better the guarantee for everyone.

### Timing Considerations

Users should be mindful that depositing and withdrawing in rapid succession with matching amounts can reduce effective privacy. Waiting for additional deposits to accumulate between your deposit and withdrawal improves your anonymity.

## Cryptographic Building Blocks

### Groth16 Zero-Knowledge Proofs

ZeroK uses the Groth16 proving system for its zero-knowledge proofs. Groth16 produces constant-size proofs (just three group elements) regardless of circuit complexity, enabling fast and inexpensive on-chain verification. The proving system requires a trusted setup ceremony, which is performed once per circuit.

### Poseidon Hash Function

Poseidon is an arithmetic-friendly hash function specifically designed for use in zero-knowledge circuits. It operates natively over prime fields, making it significantly more efficient inside ZK circuits compared to traditional hash functions like SHA-256 or Keccak. ZeroK uses Poseidon for commitment generation and Merkle tree construction.

### Merkle Trees

Deposits are tracked using a Merkle tree, where each leaf is a commitment. This structure allows the prover to demonstrate membership (that their commitment exists in the tree) by providing a Merkle path — a logarithmic-size witness — without revealing which leaf is theirs.

## V2 → V3: Solving Phantom Lighthouse

### The Problem

V2 stored all root history in a single on-chain state account of **131,920 bytes**. Phantom wallet's security scanner (Lighthouse/Blowfish) blocks transactions that write to large program-owned accounts from unverified dApps. At 131KB, ZeroK deposits were flagged as "potentially malicious" on mainnet — a showstopper for any production privacy tool.

### The Solution: Sharded State Architecture

V3 breaks the monolithic state into a compact core + 20 separate shard accounts:

| Account | V2 Size | V3 Size |
|---------|---------|---------|
| State (core) | 131,920 bytes | **8,992 bytes** |
| Root history (total) | In state | 256 in-state + 20 shards |
| Each shard | N/A | 5,144 bytes |
| **Largest single account** | **131,920 bytes** | **8,992 bytes** |

No single V3 account exceeds 9KB. Phantom Lighthouse does not trigger.

### Sharded Root Ring

The root history is distributed across 20 shard accounts:

- **20 shards**, each holding 128 root entries = **2,560 total root history**
- Roots rotate through shards in order, providing a large withdrawal window
- Each shard is a separate on-chain account, enabling parallel access
- Commitments use `Poseidon(2)(nullifier, secret)` — fixed-denomination, simple and auditable

### Batch Deposits (Blowfish Fix)

V2 used `signAllTransactions` + `sendRawTransaction` for multi-note deposits — a pattern flagged by Blowfish as a potential drainer attack. V3 introduces `deposit_batch_v2_clean`, packing up to 15 commitments into a single on-chain instruction. The browser uses `sendTransaction` (1 tx) or Phantom's `signAndSendAllTransactions` (2 txs max) — never the banned signing pattern.

Result: zero Phantom warnings on mainnet. A 20 SOL deposit fits in a single wallet popup.

## Any-Amount Deposits via Greedy Splitting

Privacy pools require fixed denominations — every deposit in a pool must look identical on-chain, otherwise an observer could match withdrawals to deposits by amount. This creates a UX problem: users should not have to manually pick "1 SOL or 10 SOL?"

ZeroK solves this with a greedy decomposition. The user enters any amount; the client computes the optimal set of denomination pieces and packs them into a single batch deposit instruction:

```javascript
// sdk/v2-core/planner.js
function greedySplit(lamports, availableDenoms) {
  const denoms = availableDenoms || DENOMINATIONS;  // [1000, 100, 10, 1, 0.1] SOL
  const steps = [];
  let remaining = BigInt(lamports);
  for (const d of denoms) {
    while (remaining >= d) { steps.push(d); remaining -= d; }
  }
  return steps;
}
```

`2.3 SOL → [2×1 SOL, 3×0.1 SOL]` → batched into one on-chain instruction → one wallet popup. The fixed-denomination privacy guarantee is preserved — each commitment is indistinguishable from any other in its pool — while the UX collapses to a single number input.

Withdrawals use `planWithdrawal()` in the same file, which runs two decomposition strategies (greedy vs inventory-aware) and picks whichever minimizes total transactions. This is critical when users hold a mix of denominations and need to break larger notes into smaller ones via the re-denomination circuit.

The entire `sdk/v2-core/` module is pure math with no environment dependencies — the same 11 files run in the browser (via webpack alias `v2-core → sdk/v2-core/`) and in CLI scripts.

## JoinSplit — 1-in-1-out with Private Change Notes

The V2 design extends the deposit primitive to support arbitrary-amount withdrawals without redenom cascades.

**V3 (production, fixed-denomination)**:
```
commitment = Poseidon(2)(nullifier, secret)
```
Every commitment in a pool is the same denomination. Withdrawals consume a whole note.

**V2 (JoinSplit, on the roadmap)**:
```
commitment = Poseidon(3)(amount, nullifier, secret)
```
A withdrawal can consume a commitment of amount `N` and insert a change commitment of amount `N - withdrawn - fee` back into the pool. The change note is privately owned by the user; observers see a normal deposit/withdrawal, not a link.

The JoinSplit circuit (`circuits/v2/withdraw.circom`) enforces the balance constraint:
```
amount_in = amount_to_recipient + amount_change + fee
```

V3 is the active mainnet program because the simpler fixed-denomination model has lower on-chain verification cost and is easier to audit. JoinSplit is production-tested on devnet (see [`programs/zerok_v2/README.md`](programs/zerok_v2/README.md)) and remains the path to true arbitrary-amount withdrawals.

## Protocol-Powered Withdrawals

ZeroK uses a protocol-powered withdrawal mechanism to preserve recipient privacy. Here is how it works:

- The user generates a proof and submits a withdrawal request through the application.
- The protocol constructs and submits the Solana transaction on the user's behalf.
- The protocol wallet pays all network fees (transaction fees and account rent).
- A small protocol fee is deducted from the withdrawal amount before the remainder is sent to the recipient.

This design means the recipient wallet never needs to hold SOL to pay for gas. A completely fresh, empty wallet can receive a withdrawal — eliminating a common privacy leak where users must fund recipient wallets from identifiable sources before withdrawing.

The relay implementation is published in [`relay/server.js`](relay/server.js) — stateless, replay-protected, and no database. Anyone can run it; the on-chain program treats every relay-submitted transaction identically to one a user would self-submit.

## Reliability Layer

Three concerns make a privacy protocol survivable in production:

- **Recovery on any device.** Encrypted note seeds ride inside each deposit's Memo instruction (AES-256-GCM keyed by the user's wallet signature). Reconnecting the same wallet on any browser, any device, scans the pool's state PDA, decrypts the memos addressable by that wallet, and rebuilds the user's private balance. Recovery is checkpointed and idempotent — the second reconnect on the same machine is near-instant.
- **Gasless to the recipient.** The protocol relay pays all network fees and nullifier-PDA rent, so a fresh-no-history recipient address remains exactly that.
- **Pipelined multi-note withdrawals.** Proof generation (CPU-bound) and relay submission (network-bound) run on overlapping timelines, with a 2-wide relay queue. Measured 37% faster end-to-end on a 9-note mainnet withdrawal.

## Non-Custodial Design

ZeroK is fully non-custodial:

- **All funds are held by the smart contract**, not by any server, team wallet, or intermediary.
- **Only the note holder can withdraw.** The zero-knowledge proof requires knowledge of the secret values contained in the note. Without the note, no one — including the ZeroK team — can claim the funds.
- **No account registration.** The protocol does not require usernames, emails, or any form of identity. Interaction is purely wallet-based.
- **Client-side proof generation.** Proofs are generated entirely in the user's browser. Secret values never leave the user's device.

Administrative controls are limited to operational functions and do not grant access to user funds — only the note holder can initiate a withdrawal.
