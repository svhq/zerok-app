# ZeroK Agent SDK

Privacy primitives for AI agents on Solana.

Four methods. The same primitives a human gets in the web app.

```js
const { ZeroK } = require('zerok-agent');
const zk = new ZeroK({ network: 'mainnet-beta', wallet: keypair });

await zk.recover();                  // reattach to your notes (any device)
await zk.deposit(2.3);               // 2.3 SOL → private pools (auto-split)
await zk.send(1.0, recipient);       // send 1.0 SOL privately via gasless relay
zk.balance();                        // { total, notes, breakdown }
```

Targets the live V3 mainnet program (`HVcTokFF4rwvcU7sC7GjS317CSf7QDgfCvW7edijKS2v`) — sharded root ring, gasless `/v3/withdraw` relay, V3 memo prefix `zerok:v3:`.

---

## Install

```bash
npm install zerok-agent
```

The package bundles the proving key + WASM circuit artifacts (~7 MB), so no separate circuit build step is required. Node 18+.

[![npm version](https://img.shields.io/npm/v/zerok-agent.svg)](https://www.npmjs.com/package/zerok-agent) · [npmjs.com/package/zerok-agent](https://www.npmjs.com/package/zerok-agent)

---

## Constructor

```js
new ZeroK({
  network,        // 'mainnet-beta' | 'devnet'
  wallet,         // Solana Keypair (Keypair.fromSecretKey(...))
  rpc,            // optional — custom RPC URL (use a paid provider for serious workloads)
  relay,          // optional — custom relay URL
  relayer,        // optional — relayer pubkey (must match the relay's actual signer)
  notesDir,       // optional — directory for note + checkpoint persistence (default: ./notes)
})
```

**Use a paid RPC.** Public `api.mainnet-beta.solana.com` rate-limits aggressively. Pass a Helius/Alchemy URL via `rpc:` for anything beyond the smallest test.

---

## API

### `await zk.deposit(solAmount, opts?)`

Deposit SOL into private pools. Greedy-splits across deployed denominations (0.1, 1, 10, 100, 1000 SOL). Each note is saved to disk before the tx is sent — fund-safety invariant.

```js
const { notes, denominations, signatures } = await zk.deposit(2.3);
// → { notes: 5, denominations: ['1 SOL','1 SOL','0.1 SOL','0.1 SOL','0.1 SOL'], signatures: [...] }
```

Options: `{ idempotencyKey?: string }` — see [Idempotency](#idempotency).

### `await zk.send(solAmount, recipient, opts?)`

Send SOL privately to `recipient` via the gasless protocol relay. The recipient receives `denomination − fee`; no SOL link to your wallet.

```js
const { sent, fee, signatures } = await zk.send(1.0, 'RecipientPubkey...');
// → { sent: 1, fee: 0.003, signatures: [...] }
```

Fee = `max(30 bps, 2_000_000 lamports)` per note (e.g. 0.003 SOL on a 1 SOL note, 0.002 SOL minimum on a 0.1 SOL note). The relay pays gas + nullifier rent and retains the fee.

Options: `{ idempotencyKey?: string }`.

### `zk.balance()`

Local-cache balance. Synchronous, no network. Reflects:
1. Notes deposited or recovered in the current session, **plus**
2. Notes auto-loaded from disk on construction (see *Two-layer persistence* below).

```js
zk.balance(); // → { total: 2.3, notes: 5, breakdown: { '1 SOL': 2, '0.1 SOL': 3 } }
```

If you're on a fresh container with no prior `notesDir`, also call `recover()` to scan on-chain.

### `await zk.recover()`

Rebuild note state from on-chain memos. Same wallet → same notes, on any device.

```js
const { recovered, notes } = await zk.recover();
```

How it works: scans each pool's state-PDA signature history (bounded, ZeroK-only), filters by `zerok:v3:` memo prefix, AES-GCM-decrypts each candidate with your wallet-derived key, parses the `DepositProofData` event for the Merkle path, and checks each nullifier PDA for spent status. Per-pool checkpoints are persisted under `notesDir/.checkpoints/`, so subsequent recoveries are incremental.

Privacy: identical to reading the public chain. Try-decrypt is local-only; wrong-key attempts (other people's notes) silently fail.

### `zk.address()`

Returns the agent wallet's public key (base58).

---

## Idempotency

Pass `opts.idempotencyKey: string` to `deposit()` or `send()`. If a prior call with the same key fully succeeded, the cached result is returned without re-submitting.

```js
await zk.deposit(0.1, { idempotencyKey: 'task-7-deposit' });
// crash, restart, retry…
await zk.deposit(0.1, { idempotencyKey: 'task-7-deposit' }); // returns cached result, no new tx
```

Cache is written **only on full success**. A crash mid-deposit followed by a retry with the same key will replay the whole split (each note is atomic on-chain; the wallet can end up with extra notes). For per-note precision, split the call yourself.

The relay independently dedupes withdrawals by nullifier hash, so even without an idempotency key a duplicate `send()` returns the original signature instead of double-spending.

---

## Errors

Every thrown error is a `ZeroKError` with `.code` and `.actionable`:

```js
try { await zk.send(1.0, recipient); }
catch (e) {
  if (e instanceof ZeroKError) {
    console.log(e.code, e.message, e.actionable);
    // route on e.code…
  }
}
```

| `code` | What happened | What the agent should do |
|---|---|---|
| `BAD_SIGNER` | Missing or malformed wallet | Reconstruct with `Keypair.fromSecretKey(...)` |
| `BAD_NETWORK` | Unknown network | Pass `rpc` and `relay` manually for custom networks |
| `BAD_AMOUNT` | Amount < 0.1 SOL or non-numeric | Pass a positive number ≥ 0.1 |
| `BAD_RECIPIENT` | Invalid base58 / pubkey | Validate the address before calling |
| `INSUFFICIENT_BALANCE` | Not enough private notes for the send | Call `deposit()` first, or `recover()` if reattaching |
| `INSUFFICIENT_WALLET_SOL` | Wallet can't afford deposit + fee | Top up the agent wallet |
| `DEPOSIT_FAILED` | Tx failed on-chain | Inspect `notes/<denom>/pending_*.json` for stuck deposits |
| `NULLIFIER_ALREADY_SPENT` | Note was already withdrawn | Mark note spent locally, pick another |
| `NOTE_STALE` | Note's stored root is no longer in pool history | `recover()` to refresh, or wait for shard rotation |
| `FEE_REJECTED` | Fee outside `max_fee_bps` | Inspect on-chain pool state |
| `RELAY_UNAVAILABLE` | Network/relay outage | Exponential backoff and retry; the proof is reusable on the same root |
| `RELAY_REJECTED` | Relay returned an error | Read `e.message` for relay's reason |
| `CIRCUIT_MISSING` | Proving key/WASM not on disk | Build circuits or download production zkey |

---

## Privacy timing (one paragraph)

Privacy in ZeroK is statistical, not binary — it comes from the anonymity set (the pool of all deposits a withdrawal could plausibly have originated from). A withdrawal moments after a deposit is technically valid but *weakly* private: an observer linking by timing has high success odds. A withdrawal hours after a deposit, by which time many other deposits and withdrawals have happened, is *strongly* private. Humans get this for free because they walk away from the app between actions. Agents are programs and can fire `deposit()` and `send()` in the same loop iteration — getting technically-correct but timing-linked transactions. The SDK does not enforce timing (the protocol is permissionless). **If your agent cares about strong privacy, deposit early, do other work, and call `send()` later.** If timing isn't your concern, fire away.

---

## Comparison with other Solana agent SDKs

| | ZeroK Agent SDK | [Solana Agent Kit](https://github.com/sendaifun/solana-agent-kit) | [Coinbase AgentKit](https://docs.cdp.coinbase.com/agent-kit/welcome) | [GOAT SDK](https://github.com/goat-sdk/goat) |
|---|---|---|---|---|
| Focus | Privacy primitives (mixer) | DeFi, NFTs, swaps (~60 tools) | Multi-chain wallet ops | DeFi composability (~200 integrations) |
| Methods | 4 (deposit/send/balance/recover) | 60+ tools | varies | varies |
| ZK proofs | yes (Groth16 in-process) | no | no | no |
| Gasless to recipient | yes (relay) | no | no | no |
| Wallet recovery | yes (`recover()` from on-chain) | n/a | varies | n/a |

ZeroK is the only one of these that hides the link between sender and recipient. It is *complementary* to general agent kits — bring ZeroK in when an agent needs to obscure a payment, then return to your everyday tools.

---

## Two-layer persistence

The SDK mirrors the website's persistence model:

| Layer | What | When loaded | Equivalent on app.zerok.app |
|---|---|---|---|
| 1. **Disk cache** | Note JSON files in `notesDir` | Auto-loaded on `new ZeroK({...})` — synchronous, no network | `localStorage` |
| 2. **On-chain** | Encrypted `zerok:v3:` memo embedded in every deposit tx | `await zk.recover()` — scans pool state PDAs | Pool-PDA scan recovery |

**Layer 1** gives you instant balance on agent restart, as long as `notesDir` is the same path. Same wallet + same disk = same notes immediately, with no RPC call.

**Layer 2** is the canonical source. The encrypted memo is in the deposit tx itself — only your wallet's signature can decrypt it. If your container starts on a fresh disk, `recover()` rebuilds the cache from on-chain. Same wallet, any device, same notes.

Fund safety during deposit: see `sdk/v3/deposit.js`. The flow is:
1. Generate nullifier + secret + commitment locally
2. Save `pending_<leafIndex>_<timestamp>.json` to disk **before** the tx is sent
3. Submit deposit tx with encrypted memo embedded
4. On confirmation, parse `DepositProofData` event for the authoritative Merkle path
5. Save `note_<leafIndex>.json` with status `verified`
6. Remove the pending file

If anything fails between steps 2 and 5, the pending file holds all the secrets needed to reconstruct the note. The on-chain memo is also independently sufficient for recovery.

## Footprint on disk

`notesDir/` contains:

```
notes/
├─ 0p1/note_NNNNN.json          # one file per deposit, immutable after confirmation
├─ 1/note_NNNNN.json
├─ .checkpoints/                # per-pool, per-wallet recovery checkpoints
│   └─ <wallet>__<pool>.json
└─ .idempotency/                # cached results for idempotencyKey'd ops
    └─ <scope>__<sanitized-key>.json
```

To migrate to a new container, copy `notesDir/` — or just bring your wallet and call `recover()`.

---

## Status

- ✅ V3 mainnet correct (live program: `HVcTokFF4rwvcU7sC7GjS317CSf7QDgfCvW7edijKS2v`)
- ✅ Pool-PDA scan recovery, AES-GCM memo decryption
- ✅ Structured `ZeroKError` codes
- ✅ Idempotency keys on `deposit()` and `send()`
- ⏳ MCP server wrapper (Week 5)
- ⏳ Python port (Week 6+)
