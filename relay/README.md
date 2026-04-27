# ZeroK Relay

Stateless relay service for protocol-paid (gasless) withdrawals.

## What it does

When a user withdraws from a ZeroK pool, the relay:

1. Receives a Groth16 proof + public inputs from the browser (`POST /v3/withdraw`)
2. Signs and submits the on-chain `withdraw_v2_clean` instruction
3. Pays the network fee + nullifier-PDA rent (~0.0024 SOL) from the relay's own balance
4. Deducts the protocol fee (`max(0.3%, 0.002 SOL)`) before forwarding the remainder to the recipient
5. Returns the signature to the browser

The recipient address never needs SOL — the relay covers everything.

## Why stateless?

No database, no indexer, no catch-up logic. Every request carries enough on-chain-verifiable state (proof, root, nullifier, recipient) for the relay to validate and submit. If the relay restarts, no data is lost.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v3/withdraw` | Submit a V3 withdrawal (Groth16 proof + recipient) |
| `POST` | `/v2/withdraw` | Submit a V2 JoinSplit withdrawal (devnet) |
| `POST` | `/v2/redenominate` | Submit a V2 re-denomination (devnet) |
| `GET` | `/health` | Liveness probe |
| `GET` | `/pools` | List configured pools |

## Running

```bash
cp .env.example .env
# Fill in RELAYER_PRIVATE_KEY, RPC_URL, POOL_CONFIG_JSON
npm install
npm start
```

## Operational notes

- **Funding**: the fee-payer wallet must hold ~0.5 SOL for typical operation; it's topped up from accumulated protocol fees.
- **Concurrency**: `MAX_CONCURRENCY=4` is safe; raising it requires monitoring blockhash expiry and confirmation polling.
- **RPC**: use a paid provider. Public endpoints rate-limit relays during multi-note bursts (a single user withdrawing 9 notes triggers 9 confirmation polls).
- **Failover**: set `RPC_URLS` (comma-separated) for automatic round-robin on transient failures.

## Security

- The relay holds **no user secrets**. It cannot generate proofs, decrypt notes, or initiate withdrawals on a user's behalf.
- Each request is independently verifiable on-chain — the relay can be replaced or operated by anyone.
- Compromise of the relay key affects only the relay's own SOL balance and can de-anonymize submission timing for in-flight requests, but cannot steal user funds.
