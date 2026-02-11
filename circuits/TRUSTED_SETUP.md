# Trusted Setup

ZeroK uses the Groth16 proving system, which requires a structured reference string (SRS) generated through a trusted setup ceremony.

## Ceremony

The circuit uses a **Powers of Tau** ceremony contribution followed by a circuit-specific Phase 2.

## Verification

The on-chain verifying key can be read from the program's VK account data. Anyone can compile the circuit and compare the resulting verification key against what is stored on-chain.

## Keys

| Key | Location | Purpose |
|-----|----------|---------|
| Verification key | On-chain (VK account) | Public — used to verify proofs on-chain |
| Proving key | Not published | Used client-side to generate proofs |

The proving key is distributed to the frontend application and is used entirely client-side. It does not contain any secret information — it is a public parameter derived from the ceremony. It is omitted from this repository due to its size.
