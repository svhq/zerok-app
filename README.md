# ZeroK

**A noncustodial privacy protocol on Solana. Live on mainnet across five fixed-denomination pools, with gasless withdrawals.**

`GPL-3.0` | `Solana` | `Groth16` | `Poseidon` | `Light Protocol`

---

## Overview

ZeroK is a noncustodial privacy protocol native to Solana. Users deposit SOL into fixed-denomination shielded pools and withdraw to any wallet, including freshly generated ones, with no traceable onchain link between the two transactions. Privacy is achieved through Groth16 zero-knowledge proofs: the onchain program verifies that a withdrawal is legitimate without ever revealing which deposit it corresponds to.

**Program:** [`HVcTokFF4rwvcU7sC7GjS317CSf7QDgfCvW7edijKS2v`](https://solscan.io/account/HVcTokFF4rwvcU7sC7GjS317CSf7QDgfCvW7edijKS2v)

**Pools:** 0.1 SOL, 1 SOL, 10 SOL, 100 SOL, 1000 SOL

**Application:** [app.zerok.app](https://app.zerok.app)

**Documentation:** [docs.zerok.app](https://docs.zerok.app)

> Earlier versions (V1 at `JCim8dPqwM16pfwQxFJHCzVA9HrG5Phdjen7PTC3dffx`, and V2) are retired.

## How It Works

### 1. Deposit

Connect your Solana wallet and select a denomination pool (0.1, 1, 10, 100, or 1000 SOL). Each deposit creates a cryptographic commitment, and your wallet-derived encryption key automatically backs up the note secrets onchain via encrypted memos.

### 2. Privacy

Your deposit joins an anonymity set alongside other deposits of the same denomination. The longer you wait and the more deposits that accumulate, the stronger your privacy guarantee becomes.

### 3. Send Privately

Enter any amount. The app automatically splits it into the optimal combination of fixed-denomination notes, generates a Groth16 proof locally in your browser, and submits via the protocol relay. The recipient wallet receives funds without ever needing SOL for gas. A 0.3% protocol fee (minimum 0.002 SOL) is deducted automatically.

## Architecture

ZeroK uses a fixed-denomination shielded pool model with a sharded root history ring.

- **Fixed-denomination commitments.** `Poseidon(2)(nullifier, secret)`. Simple, proven, auditable.
- **Sharded root ring.** 20 shards × 128 entries = 2,560 root history entries available for withdrawal eligibility.
- **Five denomination pools.** 0.1, 1, 10, 100, and 1000 SOL, each with an independent Merkle tree.
- **Protocol-paid withdrawals.** The relay pays all network fees; the recipient receives funds minus a 0.3% protocol fee (minimum 0.002 SOL).
- **Wallet-derived recovery.** Notes are encrypted with your wallet's signature and stored as onchain memos, recoverable on any device.
- **20-level Merkle tree.** Up to one million deposits per pool with frontier-based instant withdrawability.
- **Wallet-aware batching.** Deposits batch up to nine commitments per transaction to stay below the threshold that triggers wallet risk classifiers, so deposits of any amount complete with the minimum possible wallet popups.

All proof generation happens client-side in the browser. The program never has access to your private note or any information that could link your deposit to your withdrawal.

## Agent Compatible

ZeroK ships a JavaScript SDK (`zerok-agent` on [npm](https://www.npmjs.com/package/zerok-agent)) so AI agents and automated services can deposit, send, and withdraw privately on Solana with the same single-popup UX as the web app. The SDK is the public interface to the protocol; anything the web client can do, an agent can do programmatically.

See [`sdk/agent/`](sdk/agent) for usage and examples.

## Repository Structure

```
zerok-app/
├── circuits/                       ZK circuit source (Circom)
│   ├── withdraw.circom             current withdrawal circuit (fixed denomination)
│   └── v2/
│       ├── withdraw.circom         V2 JoinSplit circuit (historical)
│       └── re_denominate.circom    V2 re-denomination circuit (historical)
├── programs/
│   ├── zerok/                      V1 program interface (IDL, retired)
│   ├── zerok_v2/                   V2 program interface (IDL, retired)
│   └── zerok_v3/                   current program interface (IDL, live on mainnet)
├── relay/                          protocol-paid withdrawal relay (gasless for recipient)
├── sdk/v2-core/                    shared protocol math (browser + CLI)
├── sdk/agent/                      JavaScript SDK for agent integrations
├── web/                            frontend application (Next.js)
├── docs-site/                      documentation site (Nextra)
├── ARCHITECTURE.md                 technical architecture details
├── SECURITY.md                     security policy and responsible disclosure
└── LICENSE                         GPL-3.0
```

## Open Source Components

| Directory | Description | Status |
|-----------|-------------|--------|
| `circuits/` | Zero-knowledge circuits in Circom (current + historical V2) | Open source |
| `circuits/v2/` | V2 JoinSplit and re-denomination circuits (historical) | Open source |
| `programs/zerok/idl/` | V1 program interface (Anchor IDL, retired) | Open source |
| `programs/zerok_v2/idl/` | V2 program interface (Anchor IDL, retired) | Open source |
| `programs/zerok_v3/idl/` | Current program interface (Anchor IDL, live on mainnet) | Open source |
| `relay/` | Protocol-paid withdrawal relay. Stateless, no DB, no indexer. | Open source |
| `sdk/v2-core/` | Shared protocol math (greedy split, planner, witness, fee, Merkle) | Open source |
| `sdk/agent/` | JavaScript SDK published as `zerok-agent` on npm | Open source |
| `web/` | Frontend application built with Next.js | Open source |
| `docs-site/` | Documentation site powered by Nextra | Open source |

Program source code is not published. The onchain binary is verifiable via Solana Explorer.

## Links

- **Application:** [app.zerok.app](https://app.zerok.app)
- **Devnet:** [devnet.zerok.app](https://devnet.zerok.app)
- **Documentation:** [docs.zerok.app](https://docs.zerok.app)
- **Twitter:** [@zerokprotocol](https://twitter.com/zerokprotocol)

## License

GPL-3.0. See [LICENSE](LICENSE).
