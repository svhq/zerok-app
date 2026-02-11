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

## Protocol-Powered Withdrawals

ZeroK uses a protocol-powered withdrawal mechanism to preserve recipient privacy. Here is how it works:

- The user generates a proof and submits a withdrawal request through the application.
- The protocol constructs and submits the Solana transaction on the user's behalf.
- The protocol wallet pays all network fees (transaction fees and account rent).
- A small protocol fee is deducted from the withdrawal amount before the remainder is sent to the recipient.

This design means the recipient wallet never needs to hold SOL to pay for gas. A completely fresh, empty wallet can receive a withdrawal — eliminating a common privacy leak where users must fund recipient wallets from identifiable sources before withdrawing.

## Non-Custodial Design

ZeroK is fully non-custodial:

- **All funds are held by the smart contract**, not by any server, team wallet, or intermediary.
- **Only the note holder can withdraw.** The zero-knowledge proof requires knowledge of the secret values contained in the note. Without the note, no one — including the ZeroK team — can claim the funds.
- **No account registration.** The protocol does not require usernames, emails, or any form of identity. Interaction is purely wallet-based.
- **Client-side proof generation.** Proofs are generated entirely in the user's browser. Secret values never leave the user's device.

Administrative controls are limited to operational functions and do not grant access to user funds — only the note holder can initiate a withdrawal.
