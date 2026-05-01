# Week 4: Privacy, Optimized for AI Agents

> **Update (2026-05-01):** the SDK is now published to npm as [`zerok-agent`](https://www.npmjs.com/package/zerok-agent). Install in any agent project with `npm install zerok-agent` — same install pattern as Solana Agent Kit, Coinbase AgentKit, and every other agent SDK. The package bundles the ZK circuit artifacts (~7 MB) so there's no separate build step.

## Theme

A privacy primitive that's only callable from a wallet popup is barely a primitive at all. Week 4 makes ZeroK directly usable by autonomous AI agents — the same protocol a human uses on app.zerok.app, exposed as a four-method JavaScript SDK with the ergonomics agents actually need: structured errors, idempotency keys, two-layer persistence, and on-chain recovery from any device.

If you were an AI agent tasked with making a private payment, this is what you'd want.

Three improvements, all live and validated on mainnet:

1. **V3 alignment** — the SDK now talks to the live V3 program (sharded ring buffer, gasless `/v3/withdraw` relay)
2. **Agent-shaped ergonomics** — structured errors, idempotency, two-layer persistence
3. **Live mainnet validation** — full deposit + reboot + recover + send round-trip, twice, with on-chain proof

---

## Part 1: V3 Alignment

### What was broken

The agent SDK we shipped earlier in the hackathon (commit `cb225cf`, April 1) targeted the V2 program. After we rolled V3 to mainnet to fix the Phantom Lighthouse blocker, the SDK was silently broken: V2 instruction discriminators (`global:deposit_v2` instead of `global:deposit_v2_clean`), V2 relay endpoint (`/v2/withdraw` instead of `/v3/withdraw`), no awareness of the sharded root ring buffer that V3 uses for state, no V3 memo prefix (`zerok:v3:`), no batch-deposit instruction, and an in-memory-only note store that lost everything on agent restart.

An autonomous agent calling `zk.deposit(0.1)` against the live mainnet program would have failed at the instruction-decode step — the chain would reject the tx because the discriminator wouldn't match any live entry point.

### What was fixed

Full SDK rewrite in [`sdk/agent/index.js`](../sdk/agent/index.js). Calls the correct V3 path end to end:

- **Deposit**: `global:deposit_v2_clean` discriminator, 9-account layout including `activeShardPda` derived from each pool's ring metadata (offset 32, u32 LE), V0 transaction with the pool's ALT, encrypted `zerok:v3:` memo embedded so the deposit is recoverable from on-chain alone.
- **Withdraw**: Groth16 proof generated locally with the V1-style `withdraw_fixed.wasm` + `withdraw_final.zkey` artifacts, POSTed to `/v3/withdraw`. The protocol relay validates fee bounds against on-chain `max_fee_bps`, builds the 30-account `withdraw_v2_clean` instruction (ALT-required), and broadcasts. Recipient gets `denomination − fee` from the relay's pubkey with no on-chain link to the depositor.
- **Recovery**: pool-PDA scan via `getSignaturesForAddress(statePda)` — bounded, ZeroK-only history, *not* the user wallet's history. Filters by `zerok:v3:` memo prefix, AES-GCM-decrypts each candidate with a wallet-derived key (`SHA-256(Ed25519-sign("zerok-note-recovery-v1"))`), parses `DepositProofData` events for the Merkle path, checks each nullifier PDA for spent status. Per-pool checkpoints persist for incremental rescans.

Same four methods a human user gets — just programmatic:

```javascript
await zk.deposit(2.3);                  // → 2×1 SOL + 3×0.1 SOL = 5 notes, auto-split
await zk.send(1.0, recipient);          // → recipient gets 0.997 SOL via gasless relay
zk.balance();                           // → { total, notes, breakdown }, synchronous
await zk.recover();                     // → rebuild note state from on-chain memos
```

---

## Part 2: Agent-Shaped Ergonomics

The protocol is the same. What's new is the *shape* of the surface — designed for code, not human eyes.

### Two-layer persistence — same UX a Phantom user gets

| Layer | What | When loaded |
|---|---|---|
| **Disk cache** | Note JSON files in `notesDir` | Auto-loaded on `new ZeroK({...})` — synchronous, no network |
| **On-chain** | Encrypted `zerok:v3:` memo in every deposit tx | `await zk.recover()` |

Agent restart on the same volume: zero network calls, balance instantly visible (~30ms in our smoke). Agent restart on a fresh container: one `recover()` call, 8s on mainnet, 19 prior notes recovered.

This mirrors exactly what the website does — localStorage cache for instant page load, pool-PDA scan recovery for any-device. The agent gets the same model, same wallet-derived key, same on-chain memos — fully cross-compatible. A note created on the website can be recovered by the agent SDK and vice versa.

Fund safety during deposit: a `pending_NNNNN_<timestamp>.json` file is written to disk **before** the tx is submitted, then upgraded to `note_NNNNN.json` after confirmation. The encrypted memo is also embedded on-chain. If anything fails between, both layers independently hold enough state to reconstruct the note. We've never lost a note.

### Structured errors that agents can route on

Every thrown error is a `ZeroKError` with `.code` and `.actionable`:

```javascript
catch (e) {
  if (e.code === 'INSUFFICIENT_BALANCE')        return zk.deposit(...).then(() => zk.send(...));
  if (e.code === 'NULLIFIER_ALREADY_SPENT')     /* mark spent locally, retry */;
  if (e.code === 'NOTE_STALE')                  return zk.recover().then(() => zk.send(...));
  if (e.code === 'RELAY_UNAVAILABLE')           /* exponential backoff */;
  if (e.code === 'INSUFFICIENT_WALLET_SOL')     /* top up, retry */;
}
```

Twelve codes total. Each has a one-line `e.actionable` hint stating exactly what the agent should do next. No string-parsing, no guessing.

### Retry-safe idempotency

```javascript
await zk.deposit(0.1, { idempotencyKey: 'task-7-deposit' });
// crash, restart, retry…
await zk.deposit(0.1, { idempotencyKey: 'task-7-deposit' }); // cached, no new tx
```

Cache writes only on full success. The relay independently dedupes withdrawals by nullifier hash, so even without an idempotency key a duplicate `send()` returns the original signature instead of double-spending.

### Privacy timing — surfaced honestly, not enforced

Privacy is statistical. A withdrawal moments after a deposit is technically valid but timing-trivially-linkable. Humans get implicit timing entropy by walking away from the app. Agents are programs and can fire `deposit` then `send` in milliseconds.

The SDK does not enforce timing — it's a permissionless protocol, not our place to moralize. Instead the docs explicitly explain the trade-off and recommend the strong-privacy pattern: *deposit early, do other work, send later*. Agents that don't care can fire away. Agents that care can compose deliberately. No API surface for "anonymity strength" — agents already have RPC and can query the pool directly if they need to.

---

## Part 3: Live Mainnet Validation

The SDK isn't just unit-tested. It's been exercised end-to-end against the live V3 program with real SOL, twice, today.

### Smoke test 1 — single-note round-trip

Deposit 0.1 SOL, simulate agent restart, recover from on-chain alone, withdraw to a fresh keypair.

| Step | Tx |
|---|---|
| Deposit 0.1 SOL → leaf 32 in 0.1 SOL pool | [`2QfDsxjE…etoT5`](https://solscan.io/tx/2QfDsxjED1kQe3r14QcN68cuRDpXBFY8dRqfdPd7vcNVoBEwr7g3KDsyNz3BwpSh97RLFnPePZuzecyr8KgetoT5) |
| Reboot: fresh `ZeroK` instance, empty cache, `recover()` → found the note from the encrypted on-chain memo | — |
| Withdraw 0.1 SOL via gasless relay | [`chM865yX…yuuM`](https://solscan.io/tx/chM865yXyfkeRVpv9tp5q4bQbu8WEJL8zr22kKgknPfVASTWoJiEQ1q2qsBi9bUyPd7WWC7Yi2vtP1wFXgxjuuM) |

Recipient [`3VtiF3mk…RUJh`](https://solscan.io/account/3VtiF3mk17CbXRGca51DjByyT113rgUuUxvWBF3ARUJh) (fresh keypair) confirmed at exactly **0.098 SOL** (= 0.1 − 0.002 fee). Zero on-chain link to the depositor's wallet.

### Smoke test 2 — multi-note auto-split

Same flow with `zk.deposit(0.2)`, exercising the auto-split + multi-tx + multi-proof path:

| Step | Tx |
|---|---|
| `greedySplit(0.2)` → `[0.1, 0.1]` | (deterministic) |
| Deposit 1 → leaf 33 | [`25xJ7TuU…JwcQ`](https://solscan.io/tx/25xJ7TuUUv3j2Vxg8aBKagBdd5ZW2oR6fi48Txbg87UnfrgKzFi7W2YKycbbXQthKFQJpi85rMu6sbWgcZwQJwcq) |
| Deposit 2 → leaf 34 | [`2gKiJWkK…BZQw`](https://solscan.io/tx/2gKiJWkKUFTUmfCph9UUjLzJMiiduW52jX4HKheBuoynXVRKutgjgds7jmyucXk1ZYR2XoaZgzz2wztqkHPNBZQw) |
| Reboot + recover (8.8s, 19 notes total found, 2 from this test) | — |
| Withdraw 1 (greedy-selected, leaf 34) | [`4aKUvpzK…W6Wu`](https://solscan.io/tx/4aKUvpzKhBgSDtxKSsNc94QUqHQprYzVFoveaRKz63KxPYjAGGofc2Cx6dy9eCXCYFquLe3UyR34SxGoc9G3W6Wu) |
| Withdraw 2 (leaf 33) | [`2L7qfnYe…ux2i`](https://solscan.io/tx/2L7qfnYeedQqeBmtj7AjFU8NJxMp9DWK87JpAo5ahyAzjaksKQ8PuFHfPWbd1bSULhvGkdLTwG4bjoM9SPEkux2i) |

Recipient [`2nEFZvTk…WSRRf`](https://solscan.io/account/2nEFZvTkmF5JY9FKJWm2XrfcxdP9tSz4hXHtmv6WSRRf) (fresh) confirmed at exactly **0.196 SOL**. Two inbound txs, both from the relay — no on-chain link to the depositor.

### Test harness

[`scripts/test-agent-sdk-v3.js`](../scripts/test-agent-sdk-v3.js) — three modes:

- `--unit` (default, free, no network): 17 tests covering constructor errors, deposit/send validation, idempotency cache, encryption round-trip, memo wrapper handling, event parser, all 5 mainnet pool PDAs cross-checked against the manifest, `greedySplit`, fee model, disk hydration with network filtering.
- `--readonly`: live mainnet `recover()` against the agent wallet — read-only, costs nothing.
- `--smoke --confirm`: real on-chain round-trip (the smoke test 1 above).

22 of 22 passing. Numbers held; the system did what it said.

---

## Positioning

We're not competing with general agent kits like [Solana Agent Kit](https://github.com/sendaifun/solana-agent-kit), [Coinbase AgentKit](https://docs.cdp.coinbase.com/agent-kit/welcome), or [GOAT SDK](https://github.com/goat-sdk/goat). They expose dozens of DeFi tools — token swaps, NFT mints, lending. None of them expose privacy as a primitive. ZeroK is *complementary*: bring it in when an agent needs to obscure a payment, then return to the everyday tool kit. Same API model — composable, structured, retry-safe.

Reference implementation: [`examples/agent-private-payment.js`](../examples/agent-private-payment.js). Full reference: [`sdk/agent/README.md`](../sdk/agent/README.md). User-facing docs: [docs.zerok.app/agents](https://docs.zerok.app/agents).

---

## What's next

- **Week 5**: an MCP server wrapper. Claude Desktop, Claude Code, and any MCP-aware agent framework will be able to call ZeroK as native tool calls without integrating the SDK directly.
- **Week 6+**: Python port for LangChain / OpenAI Agents / AutoGPT compatibility.
- **Beyond**: x402 relay payment integration so agents can pay relay fees per call as HTTP 402 responses, removing the funding step entirely.

---

**Files this week** (delta against Week 3): [`sdk/agent/index.js`](../sdk/agent/index.js) (rewrite), [`sdk/agent/recover.js`](../sdk/agent/recover.js) (new), [`sdk/agent/README.md`](../sdk/agent/README.md) (new), [`examples/agent-private-payment.js`](../examples/agent-private-payment.js) (new), [`scripts/test-agent-sdk-v3.js`](../scripts/test-agent-sdk-v3.js) (new), [`docs-site/pages/agents.mdx`](../docs-site/pages/agents.mdx) (rewrite).
