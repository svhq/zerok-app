# Week 3: Reliability — Wallet Recovery, Gasless Withdrawals, Pipelined Proofs

## Theme

A privacy protocol is only as good as its worst-case experience. Week 3 is about
the boring-but-critical layer: **what happens when something interrupts you**,
and **how fast can you actually withdraw**.

Three improvements, all live on mainnet:

1. **Pool-PDA scan recovery** — your wallet is your key, regardless of what
   browser or device you reconnect from
2. **Gasless protocol-paid withdrawals** — recipient never needs SOL
3. **Pipelined proof + relay submission** — 37% faster multi-note withdrawals

---

## Part 1: Pool-PDA Scan Recovery

### The wrong way (what we tried first)

V1 recovery scanned `getSignaturesForAddress(userWallet)` — every transaction
the wallet had ever made. For an active Solana user this is a 122,000-transaction
firehose: DeFi, NFTs, airdrops, the lot. Recovery on a busy wallet was unusable.

### The fix — scan the pool, not the wallet

Every ZeroK deposit touches the pool's `state` PDA. So instead of scanning the
user's wallet, we scan the pool. The transaction set is bounded (only ZeroK
activity), well-typed (only deposit/withdraw shapes), and shared across all
users — meaning a single scan checkpoint serves every wallet that's ever
deposited to that pool.

Encrypted note seeds ride inside each deposit's Memo instruction. We try-decrypt
every memo we encounter using `SHA-256(wallet.signMessage("zerok-note-recovery-v1"))`
as the AES-256-GCM key. Wrong key = decrypt fails harmlessly. Right key = your
note material recovered.

```typescript
// Per-pool state PDA, not per-wallet history
const sigs = await conn.getSignaturesForAddress(pool.statePda, { until: checkpoint });
for (const sig of sigs) {
  const tx = await conn.getTransaction(sig.signature);
  for (const memo of extractMemos(tx)) {
    const decrypted = tryDecryptWithWalletKey(memo, walletKey);
    if (decrypted) recoveredNotes.push(decrypted);
  }
}
```

**Code**:
- [`web/src/lib/note-recovery.ts`](../web/src/lib/note-recovery.ts) — pool-scan + checkpoints + try-decrypt loop
- [`web/src/lib/note-encryption.ts`](../web/src/lib/note-encryption.ts) — wallet-derived AES-256-GCM
- [`web/src/lib/resilient-connection.ts`](../web/src/lib/resilient-connection.ts) — paid-RPC preference for scan endpoint

### Cross-session reliability

Recovery is **idempotent and resumable**. The checkpoint is the last scanned
slot per pool, persisted to localStorage and refreshed on every reconnect. The
first scan on a busy pool is slow (one-time cost). Every subsequent reconnect
— same wallet, different browser, weeks later — is near-instant: scan from
checkpoint forward, decrypt the new memos, done.

| Scenario | What happens |
|---|---|
| Refresh page | localStorage cache hit, zero RPC calls |
| Different browser, same wallet | Pool-PDA scan from genesis once, then checkpoint forward |
| Lose your Chrome profile | Reconnect wallet on phone — same recovery, same notes |
| Lose wallet seed | Layer 3 file backup (Week 2 covered this) |

---

## Part 2: Gasless Withdrawals via Protocol-Paid Relay

### The problem with self-paid withdrawals

A standard ZK withdrawal puts the recipient on the hook for transaction fees.
But the recipient is supposed to be a **fresh address with no history** — that's
the privacy story. Forcing them to first acquire SOL through some other channel
to pay gas is a deanonymization vector and a UX disaster.

### The fix — stateless protocol relay

The relay holds a fee-payer keypair, listens on `POST /v3/withdraw`, and:

1. Receives the user's Groth16 proof + public inputs (proof, nullifierHash,
   root, recipient, denomination)
2. Validates fee bounds against on-chain `max_fee_bps` (the pool itself is the
   single source of truth — no hardcoded constants to drift)
3. Builds the `withdraw_v2_clean` instruction, **signs as both fee receiver and
   nullifier-PDA rent payer**, simulates, submits, confirms
4. Returns the signature

The recipient gets `denomination − fee` lamports landing in a wallet that has
never touched ZeroK before. No SOL acquisition, no funding step, no link.

The relay deducts a fee from the withdrawal: `max(0.3%, 0.002 SOL)`. That fee
funds the relay's own gas reserves — the relay is self-sustaining.

### Stateless by design

The relay has **no database, no indexer, no catch-up state**. Every request
carries enough on-chain-verifiable state for the relay to validate
independently. If the relay restarts, no data is lost. If the relay operator
disappears, anyone can run their own.

### Replay protection

In-memory LRU cache for nullifier hashes (10-minute TTL, 1000 entries). A
duplicate `POST /v3/withdraw` with the same nullifier returns the prior
signature instead of re-submitting — clients can retry safely without burning
fees on duplicate transactions. Hostile replay attempts hit the on-chain
`already-used-nullifier` check during simulation and never make it to send.

### Privacy in the logs

Pino is configured to log only `{ method, url, hostname, statusCode }`. Request
bodies (proof bytes, recipient pubkey, memo blob) are **never** persisted to
logs. Even if log storage is compromised, no withdrawal can be linked from log
data alone.

**Code**: [`relay/server.js`](../relay/server.js) — full V3 withdrawal handler,
~500 lines, no dependencies on external state.

**Live**: `https://zerok-relay-mainnet-production.up.railway.app/health`

---

## Part 3: Pipelined Proof + Relay Submission

### The problem — multi-note withdrawals

A user withdrawing `9.5 SOL` from `[10 SOL × 1, 0.1 SOL × 5]` triggers 6
withdrawals (1 redenom + 5 single-denom). Naive serial flow:

```
Note 1: build witness → prove → submit → confirm → ...
Note 2: build witness → prove → submit → confirm → ...
```

Each note costs ~5 seconds (proof) + ~2 seconds (relay+confirmation). Nine
notes = ~63 seconds of staring at a spinner.

### Tier 1 — drop the artificial delay (`e4f3fe2`)

We had a 500ms `setTimeout` between notes, originally a defensive throttle.
Dropped to 100ms. Negligible win on its own, but cleared the way for the real
work.

### Tier 2 — pipeline proof N+1 with relay N (`abb58ef`)

Split `executeV3Withdrawal` into two functions: `generateV3Proof()` (CPU-bound,
~1.2–3.7s) and `submitV3ToRelay()` (network-bound, ~1.5–2.5s). Then start the
**next** proof while the **previous** relay submission is in flight.

```
Note 1:  prove ━━━━━━━━━━━━ → submit ━━━━━━ → confirm
Note 2:                       prove ━━━━━━━━━━━━ → submit ━━━━━━ → confirm
Note 3:                                            prove ━━━━━━━━━━━━ → submit ...
```

**Measured** on a 9-note mainnet withdrawal: **44s → 27.5s. 37% faster.**

### Tier 3 — 2-wide relay queue (`9787ac0`)

Allow two relay submissions in-flight at once. On a slow CPU (proof generation
is the bottleneck), this is neutral. On a fast CPU (network is the bottleneck),
**24% faster**. Adaptive — the bottleneck just is whatever it is, and the
pipeline absorbs it.

### Per-note timing (mainnet, instrumented)

| Phase | Time |
|---|---|
| Witness build | ~10ms |
| Groth16 proof generation | 1.2–3.7s (CPU-bound, varies by device) |
| Relay submission + confirmation | 1.5–2.5s (network-bound) |

**Code**:
- [`web/src/lib/v3-withdraw.ts`](../web/src/lib/v3-withdraw.ts) — split into
  `generateV3Proof` + `submitV3ToRelay`
- [`web/src/components/V3WithdrawPage.tsx`](../web/src/components/V3WithdrawPage.tsx)
  — 2-wide pipeline loop

### Bonus — Helius preference fix (`fb4c351`)

Recovery scans were silently falling back to free-tier Alchemy and getting
429-rate-limited. Fixed `getScanEndpoint()` to prefer the paid Helius endpoint
on mainnet. Recovery time on busy wallets dropped substantially.

---

## Verified on Mainnet

- 9-note withdrawal: **27.5s end-to-end** (was ~44s pre-pipeline)
- Cross-browser recovery: 11 deposits, recovered in under 2 seconds from
  checkpoint
- Cross-device recovery: deposited in Edge desktop, recovered on iOS Safari
- Hostile replay test: same nullifier submitted to relay 5× — first succeeds,
  rest return cached signature, no double-spend, no extra gas burned
- Recipient with 0 SOL: receives `denomination − fee` and the address remains
  unfunded by anyone but the protocol

---

## Files Shipped This Week

**New in this push** — `relay/` directory: trimmed V3 withdrawal handler
(~500 lines, single endpoint), `package.json`, `.env.example`, README. Boots
locally in <1 second; live on Railway as
`zerok-relay-mainnet-production.up.railway.app`.

**Already in repo, now contextualized by Week 3** —
`web/src/lib/note-recovery.ts`, `note-encryption.ts`, `resilient-connection.ts`,
`v3-withdraw.ts`, `V3WithdrawPage.tsx`. The reliability story is the
*combination* of these files, not any one of them in isolation.

---

## Aggregate Narrative — Weeks 1+2+3

> "Week 1, we made it work on mainnet. Week 2, we made it feel like Uniswap.
> Week 3, we made it survive the things that break privacy tools in
> production: lost browsers, fresh recipient addresses, slow networks, hostile
> retries. Three layers — recovery, gasless, pipeline — and every one of them
> is live, measured, and verifiable on-chain."
