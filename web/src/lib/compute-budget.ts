import { ComputeBudgetProgram, TransactionInstruction } from '@solana/web3.js';

/**
 * Create ComputeBudget instructions for ZeroK transactions.
 *
 * Why this matters for wallet signing speed:
 * 1. Wallets (Phantom, Solflare) do pre-sign work: simulation, fee estimation, security checks
 * 2. Without explicit compute budget, wallet has to "guess" → triggers slow iteration/estimation
 * 3. Explicit values tell wallet exactly what to expect → faster preview/simulation
 *
 * Per consultant analysis:
 * "Without explicit ComputeBudget instructions, the wallet has to guess.
 *  This can trigger an iterative simulation path where it tries different CU limits."
 *
 * Usage: Add these instructions FIRST in your transaction, before other instructions.
 */
export function createComputeBudgetInstructions(
  computeUnits: number,
  microLamportsPerCu: number = DEFAULT_PRIORITY_FEE
): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({
      units: computeUnits,
    }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: microLamportsPerCu,
    }),
  ];
}

/**
 * Compute unit estimates based on actual transaction profiling:
 *
 * Deposit transaction:
 * - Merkle tree hash operations: ~30k CU
 * - Account operations: ~20k CU
 * - Overhead: ~10k CU
 * - Total: ~60k CU, using 100k with buffer
 *
 * Withdrawal transaction (ZK verification):
 * - Groth16 verification with altbn254 syscalls: <200k CU (per Light Protocol)
 * - Merkle proof verification: ~50k CU
 * - Account operations: ~30k CU
 * - Protocol logic: ~20k CU
 * - Total: ~300k CU, using 400k with buffer
 */

// Deposit: Merkle tree insertion + hash operations (~60k actual, 100k with buffer)
export const DEPOSIT_COMPUTE_UNITS = 100_000;

// Withdrawal: ZK proof verification + Merkle proof (~300k actual, 400k with buffer)
export const WITHDRAW_COMPUTE_UNITS = 400_000;

/**
 * Priority fee in micro-lamports per compute unit.
 *
 * Fee calculation: total_fee = (compute_units * microLamports) / 1_000_000
 *
 * Examples (with DEPOSIT_COMPUTE_UNITS = 100k):
 * - 1,000 microLamports = 0.0001 SOL priority fee
 * - 10,000 microLamports = 0.001 SOL priority fee
 * - 50,000 microLamports = 0.005 SOL priority fee
 *
 * For devnet: Low fee is fine (1,000 microLamports)
 * For mainnet: Adjust based on network congestion (10k-100k typical)
 */
export const DEFAULT_PRIORITY_FEE = 1_000; // ~0.0001 SOL for 100k CU (devnet-friendly)

// Higher priority for withdrawals (more important to land quickly)
export const WITHDRAW_PRIORITY_FEE = 5_000; // ~0.002 SOL for 400k CU
