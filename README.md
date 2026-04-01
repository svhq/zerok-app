# ZeroK

**Privacy-preserving protocol for Solana — V2 Live on Mainnet**

`GPL-3.0` | `Solana` | `Groth16` | `Poseidon`

---

## Overview

ZeroK is a non-custodial privacy protocol built natively on Solana. It enables users to deposit SOL into shielded pools and withdraw to any wallet without creating a traceable link between the two transactions. Privacy is achieved through zero-knowledge proofs — the on-chain program verifies that a withdrawal is legitimate without ever revealing which deposit it corresponds to.

**V2 Program:** [`HVcTokFF4rwvcU7sC7GjS317CSf7QDgfCvW7edijKS2v`](https://solscan.io/account/HVcTokFF4rwvcU7sC7GjS317CSf7QDgfCvW7edijKS2v)

**Pools:** 0.1 SOL, 1 SOL, 10 SOL, 100 SOL, 1000 SOL

**Application:** [app.zerok.app](https://app.zerok.app)

**Documentation:** [docs.zerok.app](https://docs.zerok.app)

> V1 program `JCim8dPqwM16pfwQxFJHCzVA9HrG5Phdjen7PTC3dffx` has been retired. V2 is the current live version.

## How It Works

### 1. Deposit

Connect your Solana wallet and deposit any amount (multiples of 0.1 SOL). The protocol splits your deposit into denomination-sized notes using a greedy algorithm. Each note is a cryptographic commitment — your wallet-derived encryption key automatically backs up the note secrets on-chain via encrypted memos.

### 2. Privacy

Your deposit joins an anonymity set alongside other deposits of the same denomination. The longer you wait and the more deposits that accumulate, the stronger your privacy guarantee becomes.

### 3. Send Privately

Enter an amount to send. The app auto-selects the best combination of notes and generates a zero-knowledge proof locally on your device. The protocol relay submits the transaction on your behalf — the recipient wallet never needs to hold SOL for gas fees. A 0.3% protocol fee (minimum 0.002 SOL) is deducted automatically.

## V2 Architecture

V2 uses a **JoinSplit** model:

- **Amount-encoded commitments:** `Poseidon(3)(amount, nullifier, secret)` — enables partial withdrawals
- **Change notes:** Withdraw 3 SOL from a 10 SOL note, automatically receive a 7 SOL change note
- **Re-denomination:** Privately break 1 large note into 10 smaller notes across denomination pools
- **4,096-entry root history:** ~20-82 day withdrawal window (vs 30 entries in V1)
- **Protocol-paid withdrawals:** Relay pays all network fees; user receives funds minus protocol fee
- **Wallet-derived recovery:** Notes are encrypted with your wallet's signature and stored as on-chain memos — recoverable on any device

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
│   ├── withdraw.circom       — V1 withdrawal circuit
│   └── v2/
│       ├── withdraw.circom   — V2 JoinSplit withdrawal circuit
│       └── re_denominate.circom — V2 re-denomination circuit
├── programs/
│   ├── zerok/         — V1 program interface (IDL)
│   └── zerok_v2/      — V2 program interface (IDL)
├── web/               — Frontend application (Next.js)
├── docs-site/         — Documentation site (Nextra)
├── ARCHITECTURE.md    — Technical architecture details
├── SECURITY.md        — Security policy and responsible disclosure
└── LICENSE            — GPL-3.0
```

## Open Source Components

| Directory | Description | Status |
|-----------|-------------|--------|
| `circuits/` | Zero-knowledge circuits (V1 + V2) written in Circom | Open source |
| `circuits/v2/` | V2 JoinSplit and re-denomination circuits | Open source |
| `programs/zerok/idl/` | V1 program interface (Anchor IDL) | Open source |
| `programs/zerok_v2/idl/` | V2 program interface (Anchor IDL) | Open source |
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
