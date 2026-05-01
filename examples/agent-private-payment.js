#!/usr/bin/env node
/**
 * ZeroK Agent SDK — Reference Autonomous-Agent Example
 *
 * Demonstrates the full agent lifecycle for making a private payment:
 *   1. Load wallet keypair (from disk or env)
 *   2. Instantiate ZeroK
 *   3. recover() — rebuild note state from on-chain (handles agent reboot)
 *   4. balance() — see what's already in private pools
 *   5. deposit() if needed — top up
 *   6. send() — pay recipient privately via the gasless relay
 *   7. Handle structured errors with .code + .actionable hints
 *
 * If you were an AI agent tasked with making a private payment, this is the
 * minimum viable script.
 *
 * Usage:
 *   AGENT_KEYPAIR=/path/to/agent.json \
 *   AGENT_RECIPIENT=<base58 pubkey>   \
 *   AGENT_AMOUNT_SOL=0.1              \
 *   AGENT_NETWORK=mainnet-beta        \   # V3 lives on mainnet; devnet/localnet require a V3 pool
 *   node examples/agent-private-payment.js
 */

'use strict';

const { Keypair } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const { ZeroK, ZeroKError } = require('../sdk/agent');

// =============================================================================
// CONFIG
// =============================================================================

const KEYPAIR_PATH = process.env.AGENT_KEYPAIR;
const RECIPIENT = process.env.AGENT_RECIPIENT;
const AMOUNT_SOL = parseFloat(process.env.AGENT_AMOUNT_SOL || '0.1');
const NETWORK = process.env.AGENT_NETWORK || 'mainnet-beta';
const NOTES_DIR = process.env.AGENT_NOTES_DIR || path.join(process.cwd(), 'agent-state');

if (!KEYPAIR_PATH || !RECIPIENT) {
  console.error('Missing required env vars: AGENT_KEYPAIR, AGENT_RECIPIENT');
  console.error('See header of this file for usage.');
  process.exit(2);
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  // 1. Load wallet
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf8'))),
  );
  console.log(`[agent] Wallet:      ${wallet.publicKey.toBase58()}`);
  console.log(`[agent] Network:     ${NETWORK}`);
  console.log(`[agent] Notes dir:   ${NOTES_DIR}`);
  console.log(`[agent] Goal:        send ${AMOUNT_SOL} SOL privately to ${RECIPIENT}`);

  // 2. Instantiate
  const zk = new ZeroK({ network: NETWORK, wallet, notesDir: NOTES_DIR });

  // 3. Recover from on-chain (idempotent — same wallet, same notes, any device).
  //    The first call on a fresh wallet finishes in seconds with 0 notes.
  //    Subsequent reboots resume from the per-pool checkpoint.
  console.log('\n[agent] Step 1/4: recover()');
  try {
    const rec = await zk.recover();
    console.log(`[agent]  recovered ${rec.recovered} notes`);
  } catch (e) {
    // Recovery failure is non-fatal — the agent might be brand-new with no prior notes.
    if (e instanceof ZeroKError) {
      console.warn(`[agent]  recover skipped: ${e.code} — ${e.actionable}`);
    } else {
      console.warn(`[agent]  recover error: ${e.message}`);
    }
  }

  // 4. Inspect private balance
  console.log('\n[agent] Step 2/4: balance()');
  let bal = zk.balance();
  console.log(`[agent]  ${bal.total} SOL across ${bal.notes} notes`, bal.breakdown);

  // 5. Top up if needed
  const need = AMOUNT_SOL - bal.total;
  if (need > 0) {
    const toDeposit = Math.max(0.1, Math.ceil(need * 10) / 10); // round up to nearest 0.1 SOL
    console.log(`\n[agent] Step 3/4: deposit(${toDeposit}) — need ${need.toFixed(3)} more SOL`);
    try {
      const dep = await zk.deposit(toDeposit, {
        // Idempotency key scoped to the task. A retry after a transient failure
        // will return the cached result rather than double-depositing.
        idempotencyKey: `task-${Date.now()}-deposit`,
      });
      console.log(`[agent]  deposited ${dep.notes} notes:`, dep.denominations);
      bal = zk.balance();
      console.log(`[agent]  new balance: ${bal.total} SOL`);
    } catch (e) {
      return handleZeroKError('deposit', e);
    }
  } else {
    console.log('\n[agent] Step 3/4: deposit() skipped (sufficient balance)');
  }

  // 6. Send privately
  console.log(`\n[agent] Step 4/4: send(${AMOUNT_SOL}, ${RECIPIENT.slice(0, 8)}...)`);
  try {
    const send = await zk.send(AMOUNT_SOL, RECIPIENT, {
      idempotencyKey: `task-${Date.now()}-send`,
    });
    console.log(`[agent]  sent ${send.sent} SOL (fee ${send.fee.toFixed(6)} SOL)`);
    for (const sig of send.signatures) {
      console.log(`[agent]    tx: ${sig}`);
    }
    console.log('\n[agent] DONE. Recipient sees only an inbound transfer from the relay; no link to this wallet.');
  } catch (e) {
    return handleZeroKError('send', e);
  }
}

// =============================================================================
// STRUCTURED ERROR HANDLER
// =============================================================================

function handleZeroKError(stage, e) {
  if (e instanceof ZeroKError) {
    console.error(`\n[agent] ${stage} failed (${e.code}): ${e.message}`);
    console.error(`[agent] hint: ${e.actionable}`);
    // An agent could route on e.code:
    //   INSUFFICIENT_BALANCE / INSUFFICIENT_WALLET_SOL → top up wallet, retry
    //   NULLIFIER_ALREADY_SPENT → mark note spent locally, retry with another
    //   NOTE_STALE             → call recover() to refresh, retry
    //   RELAY_UNAVAILABLE      → exponential backoff, retry
    //   FEE_REJECTED / RELAY_REJECTED → inspect on-chain max_fee_bps, recompute
    process.exit(1);
  }
  console.error(`\n[agent] ${stage} unexpected error: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
