/**
 * ZeroK v2-core — Withdrawal Planner
 *
 * Pure math — zero environment dependencies.
 * Exact copy of the CLI's proven planner logic from sdk/v2/send.js.
 *
 * greedySplit:      Decompose SOL amount into denomination pieces
 * getInventory:     Group notes by denomination
 * planWithdrawal:   Bottom-up cascade with dual-strategy optimizer
 */

'use strict';

const { DENOMINATIONS } = require('./constants.js');

/**
 * Greedy decomposition of an amount into denomination-sized pieces.
 * Example: 10.3 SOL → [10B, 100M, 100M, 100M]
 *
 * @param {bigint|number} lamports
 * @param {bigint[]} [availableDenoms] - Optional list of available denominations (descending).
 *   If provided, only these denominations are used. Defaults to the full hardcoded DENOMINATIONS.
 *   This allows the web app to pass only the denominations that have deployed pools.
 * @returns {bigint[]}
 */
function greedySplit(lamports, availableDenoms) {
  const denoms = availableDenoms || DENOMINATIONS;
  const steps = [];
  let remaining = BigInt(lamports);
  for (const d of denoms) {
    while (remaining >= d) {
      steps.push(d);
      remaining -= d;
    }
  }
  return steps;
}

/**
 * Group notes by denomination.
 * Returns: { "1000000000": [note1, note2], "100000000": [note3, ...] }
 *
 * @param {Object[]} notes - Array of note objects with `amount` and `spent` fields
 * @returns {Object}
 */
function getInventory(notes) {
  const inv = {};
  for (const note of notes) {
    // Support both legacy `spent: boolean` and new `status: V2NoteStatus`
    const isSpent = note.status ? note.status !== 'unspent' : note.spent;
    if (isSpent) continue;
    const d = note.amount.toString();
    (inv[d] = inv[d] || []).push(note);
  }
  return inv;
}

/**
 * Plan a withdrawal: determine which notes to use and which re-denominations are needed.
 *
 * Uses a bottom-up "make change" algorithm:
 *   1. Greedy-split the amount into ideal denominations
 *   2. Process smallest denomination first — if we don't have enough, break a larger note
 *   3. Breaking may create a deficit one level up, which cascades naturally
 *   4. Execute redenoms largest-first so broken notes exist when lower levels need them
 *
 * Two decomposition strategies are tried (greedy vs inventory-aware), and the one
 * with fewer total transactions is chosen.
 *
 * @param {bigint} amountLamports - Total amount to send
 * @param {Object} inventory - From getInventory()
 * @returns {{ directSteps: bigint[], redenomSteps: { sourceDenom: bigint, targetDenom: bigint }[], error: string | null }}
 */
function planWithdrawal(amountLamports, inventory) {
  // Count what we have
  const have = {};
  for (const denom of DENOMINATIONS) {
    have[denom.toString()] = (inventory[denom.toString()] || []).length;
  }

  // Early check: do we have enough total funds?
  let totalHave = 0n;
  for (const denom of DENOMINATIONS) {
    totalHave += denom * BigInt(have[denom.toString()] || 0);
  }
  if (totalHave < BigInt(amountLamports)) {
    return {
      directSteps: [], redenomSteps: [],
      error: `Insufficient balance: have ${Number(totalHave)/1e9} SOL, need ${Number(amountLamports)/1e9} SOL`,
    };
  }

  // Try two decomposition strategies, pick the one with fewer total transactions.
  //
  // Strategy A: Standard greedy split (may need redenoms but uses large denominations efficiently)
  // Strategy B: Inventory-aware (uses available small notes first, avoids some redenoms but may
  //             force unnecessary cascading by fragmenting the withdrawal amount)
  //
  // Example: 50 SOL from {100:1, 0.1:3}
  //   A: greedySplit(50) = 5×10 → 1 redenom (100→10) + 5 withdrawals = 6 txs
  //   B: use 3×0.1 first → need 49.7 → 4×10+9×1+7×0.1 → 3 redenoms + 23 withdrawals = 26 txs
  //   Winner: A

  function tryPlan(needed) {
    const need = {};
    for (const d of needed) need[d.toString()] = (need[d.toString()] || 0) + 1;
    const simHave = {};
    for (const denom of DENOMINATIONS) simHave[denom.toString()] = have[denom.toString()] || 0;
    const steps = [];
    for (let i = DENOMINATIONS.length - 1; i >= 0; i--) {
      const denom = DENOMINATIONS[i];
      const key = denom.toString();
      const deficit = (need[key] || 0) - (simHave[key] || 0);
      if (deficit <= 0) continue;
      if (i === 0) return null; // Can't fill from top denomination
      const breaks = Math.ceil(deficit / 10);
      const largerKey = DENOMINATIONS[i - 1].toString();
      for (let b = 0; b < breaks; b++) steps.push({ sourceDenom: DENOMINATIONS[i - 1], targetDenom: denom });
      simHave[largerKey] = (simHave[largerKey] || 0) - breaks;
      simHave[key] = (simHave[key] || 0) + breaks * 10;
    }
    return { needed, steps, cost: steps.length + needed.length };
  }

  // Strategy A: standard greedy split
  const planA = tryPlan(greedySplit(amountLamports));

  // Strategy B: inventory-aware (use available notes first)
  const invNeeded = [];
  let invRemaining = BigInt(amountLamports);
  for (const denom of DENOMINATIONS) {
    const avail = have[denom.toString()] || 0;
    const use = Math.min(Number(invRemaining / denom), avail);
    for (let j = 0; j < use; j++) { invNeeded.push(denom); invRemaining -= denom; }
  }
  if (invRemaining > 0n) invNeeded.push(...greedySplit(invRemaining));
  const planB = tryPlan(invNeeded);

  // Pick the cheaper plan (fewer total transactions)
  const best = (planA && planB) ? (planA.cost <= planB.cost ? planA : planB)
    : (planA || planB);

  if (!best) {
    return { directSteps: [], redenomSteps: [], error: 'Cannot satisfy withdrawal with available notes' };
  }

  const needed = best.needed;
  const need = {};
  for (const d of needed) need[d.toString()] = (need[d.toString()] || 0) + 1;

  // Bottom-up cascade: process smallest denomination first
  const redenomSteps = [];

  for (let i = DENOMINATIONS.length - 1; i >= 0; i--) {
    const denom = DENOMINATIONS[i];
    const key = denom.toString();
    const deficit = (need[key] || 0) - (have[key] || 0);

    if (deficit <= 0) continue;

    if (i === 0) {
      return {
        directSteps: [], redenomSteps: [],
        error: `Cannot fill ${deficit}×${Number(denom)/1e9} SOL — no larger denomination available`,
      };
    }

    const breaksNeeded = Math.ceil(deficit / 10);
    const largerDenom = DENOMINATIONS[i - 1];
    const largerKey = largerDenom.toString();

    for (let b = 0; b < breaksNeeded; b++) {
      redenomSteps.push({ sourceDenom: largerDenom, targetDenom: denom });
    }

    have[largerKey] = (have[largerKey] || 0) - breaksNeeded;
    have[key] = (have[key] || 0) + breaksNeeded * 10;
  }

  redenomSteps.sort((a, b) => Number(b.sourceDenom - a.sourceDenom));

  return { directSteps: needed, redenomSteps, error: null };
}

module.exports = { greedySplit, getInventory, planWithdrawal };
