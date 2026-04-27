# ZeroK

**Privacy-preserving protocol for Solana — V3 Live on Mainnet**

`GPL-3.0` | `Solana` | `Groth16` | `Poseidon`

---

## Overview

ZeroK is a non-custodial privacy protocol built natively on Solana. It enables users to deposit SOL into shielded pools and withdraw to any wallet without creating a traceable link between the two transactions. Privacy is achieved through zero-knowledge proofs — the on-chain program verifies that a withdrawal is legitimate without ever revealing which deposit it corresponds to.

**Program:** [`HVcTokFF4rwvcU7sC7GjS317CSf7QDgfCvW7edijKS2v`](https://solscan.io/account/HVcTokFF4rwvcU7sC7GjS317CSf7QDgfCvW7edijKS2v)

**Pools:** 0.1 SOL, 1 SOL, 10 SOL, 100 SOL, 1000 SOL

**Application:** [app.zerok.app](https://app.zerok.app)

**Documentation:** [docs.zerok.app](https://docs.zerok.app)

> V3 is the current mainnet version. V1 (`JCim8dPqwM16pfwQxFJHCzVA9HrG5Phdjen7PTC3dffx`) and V2 are retired.

## How It Works

### 1. Deposit

Connect your Solana wallet and select a denomination pool (0.1, 1, 10, 100, or 1000 SOL). Each deposit creates a cryptographic commitment — your wallet-derived encryption key automatically backs up the note secrets on-chain via encrypted memos.

### 2. Privacy

Your deposit joins an anonymity set alongside other deposits of the same denomination. The longer you wait and the more deposits that accumulate, the stronger your privacy guarantee becomes.

### 3. Send Privately

Enter an amount to send. The app auto-selects the best combination of notes and generates a zero-knowledge proof locally on your device. The protocol relay submits the transaction on your behalf — the recipient wallet never needs to hold SOL for gas fees. A 0.3% protocol fee (minimum 0.002 SOL) is deducted automatically.

## V3 Architecture

V3 uses a **fixed-denomination** model with a sharded root ring:

- **Fixed-denomination commitments:** `Poseidon(2)(nullifier, secret)` — simple, proven, auditable
- **Sharded root ring:** 20 shards x 128 entries = 2,560-entry root history for withdrawal eligibility
- **5 denomination pools:** 0.1, 1, 10, 100, 1000 SOL — each with independent Merkle trees
- **Protocol-paid withdrawals:** Relay pays all network fees; user receives funds minus 0.3% protocol fee (min 0.002 SOL)
- **Wallet-derived recovery:** Notes are encrypted with your wallet's signature and stored as on-chain memos — recoverable on any device
- **20-level Merkle tree:** Up to 1M deposits per pool with frontier-based instant withdrawability

## Architecture

ZeroK combines several well-established cryptographic primitives:

- **Groth16 zero-knowledge proofs** — compact, constant-size proofs that verify in milliseconds on-chain
- **Poseidon hash function** — a ZK-friendly hash designed for efficient use inside arithmetic circuits
- **Incremental Merkle tree** — 20-level tree with frontier-based path computation for instant withdrawability
- **Solana program** — on-chain verifier that enforces deposit rules, verifies proofs, and releases funds

All proof generation happens client-side in the browser. The program never has access to your private note or any information that could link your deposit to your withdrawal.

## Repository Structure

```
zerok-app/
├── circuits/          — ZK circuit source (Circom)
│   ├── withdraw.circom       — V3 withdrawal circuit (fixed denomination)
│   └── v2/
│       ├── withdraw.circom   — V2 JoinSplit circuit (historical)
│       └── re_denominate.circom — V2 re-denomination circuit (historical)
├── programs/
│   ├── zerok/         — V1 program interface (IDL, retired)
│   ├── zerok_v2/      — V2 program interface (IDL, retired)
│   └── zerok_v3/      — V3 program interface (IDL, current mainnet)
├── relay/             — Protocol-paid withdrawal relay (gasless for recipient)
├── sdk/v2-core/       — Shared protocol math (browser + CLI)
├── web/               — Frontend application (Next.js)
├── docs-site/         — Documentation site (Nextra)
├── ARCHITECTURE.md    — Technical architecture details
├── SECURITY.md        — Security policy and responsible disclosure
└── LICENSE            — GPL-3.0
```

## Open Source Components

| Directory | Description | Status |
|-----------|-------------|--------|
| `circuits/` | Zero-knowledge circuits (V1/V3 + V2) written in Circom | Open source |
| `circuits/v2/` | V2 JoinSplit and re-denomination circuits (historical) | Open source |
| `programs/zerok/idl/` | V1 program interface (Anchor IDL, retired) | Open source |
| `programs/zerok_v2/idl/` | V2 program interface (Anchor IDL, retired) | Open source |
| `programs/zerok_v3/idl/` | V3 program interface (Anchor IDL, current mainnet) | Open source |
| `relay/` | Protocol-paid withdrawal relay — stateless, no DB, no indexer | Open source |
| `sdk/v2-core/` | Shared protocol math (greedy split, planner, witness, fee, Merkle) | Open source |
| `web/` | Frontend application built with Next.js | Open source |
| `docs-site/` | Documentation site powered by Nextra | Open source |

Program source code is not published. The on-chain binary is verifiable via Solana Explorer.

## Links

- **Application:** [app.zerok.app](https://app.zerok.app)
- **Devnet:** [devnet.zerok.app](https://devnet.zerok.app)
- **Documentation:** [docs.zerok.app](https://docs.zerok.app)
- **Twitter:** [@zerokprotocol](https://twitter.com/zerokprotocol)

## License

GPL-3.0 — see [LICENSE](LICENSE)
