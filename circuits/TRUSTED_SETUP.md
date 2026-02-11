# Trusted Setup

ZeroK uses the Groth16 proving system, which requires a structured reference string (SRS) generated through a trusted setup ceremony.

## Ceremony

The current circuit uses a **Powers of Tau** ceremony contribution followed by a circuit-specific Phase 2. The verification key published in this repository (`verification_key.json`) corresponds to the deployed withdrawal circuit.

## Verification

Anyone can verify that the on-chain verifying key matches the published verification key by comparing the key points against the deployed program's VK account data.

## Keys

| Key | Location | Purpose |
|-----|----------|---------|
| Verification key | `verification_key.json` | Public — used to verify proofs on-chain |
| Proving key | Not published | Used client-side to generate proofs |

The proving key is distributed to the frontend application and is used entirely client-side. It does not contain any secret information — it is a public parameter derived from the ceremony. It is omitted from this repository due to its size (~80 MB).
