/**
 * ZeroK v2-core — Fee Calculation
 *
 * Pure math — no environment dependencies.
 * Matches on-chain calculate_min_fee() in programs/zerok_v2/src/lib.rs.
 */

'use strict';

const RELAY_FEE_BPS = 30n;           // 0.3%
const MIN_RELAY_FEE = 2_000_000n;    // 0.002 SOL minimum

/**
 * Calculate relay fee for a v2 withdrawal.
 *
 * @param {bigint} amountLamports - Withdrawal amount in lamports
 * @returns {bigint} Fee in lamports
 */
function calculateRelayFee(amountLamports) {
  const pct = BigInt(amountLamports) * RELAY_FEE_BPS / 10_000n;
  return pct > MIN_RELAY_FEE ? pct : MIN_RELAY_FEE;
}

module.exports = {
  RELAY_FEE_BPS,
  MIN_RELAY_FEE,
  calculateRelayFee,
};
