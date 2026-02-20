# ZeroK

**Privacy-preserving protocol for Solana — Live on Mainnet**

`GPL-3.0` | `Solana` | `Groth16` | `Poseidon`

---

## Overview

ZeroK is a non-custodial privacy protocol built natively on Solana. It enables users to deposit SOL into shielded vaults and later withdraw to any wallet without creating a traceable link between the two transactions. Privacy is achieved through zero-knowledge proofs — the on-chain smart contract verifies that a withdrawal is legitimate without ever revealing which deposit it corresponds to.

**Mainnet Program:** `JCim8dPqwM16pfwQxFJHCzVA9HrG5Phdjen7PTC3dffx`

**Shielded Vaults:** 1 SOL, 10 SOL, 100 SOL, 1000 SOL

## How It Works

### 1. Deposit

Connect your Solana wallet and deposit SOL into a shielded vault. The protocol generates a unique cryptographic commitment for your deposit and provides you with a private note — this note is your sole proof of ownership.

### 2. Wait

Your deposit joins an anonymity set alongside other deposits of the same denomination. The longer you wait and the more deposits that accumulate, the stronger your privacy guarantee becomes.

### 3. Withdraw

Load your private note in the browser. The application generates a zero-knowledge proof locally on your device, proving you are entitled to withdraw without revealing which deposit is yours. Funds are sent to any wallet you specify. The protocol submits the transaction on your behalf, so the recipient wallet never needs to hold SOL for gas fees.

## Architecture

ZeroK combines several well-established cryptographic primitives:

- **Groth16 zero-knowledge proofs** — compact, constant-size proofs that verify in milliseconds on-chain
- **Poseidon hash function** — a ZK-friendly hash designed for efficient use inside arithmetic circuits
- **Merkle trees** — space-efficient data structure for tracking the set of all deposits
- **Solana smart contract** — on-chain program that enforces deposit rules, verifies proofs, and releases funds

All proof generation happens client-side in the browser. The smart contract never has access to your private note or any information that could link your deposit to your withdrawal.

## Repository Structure

```
zerok-app/
├── circuits/        — ZK circuit source (Circom)
├── programs/        — Program interface (IDL)
├── web/             — Frontend application (Next.js)
├── docs-site/       — Documentation site (Nextra)
├── SECURITY.md      — Security policy and responsible disclosure
└── LICENSE          — GPL-3.0
```

## Open Source Components

| Directory | Description | Status |
|-----------|-------------|--------|
| `circuits/` | Zero-knowledge circuit source written in Circom | Open source |
| `web/` | Frontend application built with Next.js | Open source |
| `docs-site/` | Documentation site powered by Nextra | Open source |
| `programs/` | Program interface definition (IDL) | Interface and deployed program ID available |

## Documentation

Complete protocol documentation, guides, and technical references are available at:

**[docs.zerok.app](https://docs.zerok.app)**

## Security

We take security seriously. If you discover a vulnerability, please review our [Security Policy](SECURITY.md) for responsible disclosure guidelines.

## License

ZeroK is released under the [GNU General Public License v3.0](LICENSE).

## Links

- **Application** — [app.zerok.app](https://app.zerok.app)
- **Documentation** — [docs.zerok.app](https://docs.zerok.app)
- **Twitter/X** — [@zerokprotocol](https://x.com/zerokprotocol)
