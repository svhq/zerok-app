/**
 * ZeroK v2 — Browser Configuration (Browser Adapter)
 *
 * Browser-specific: Program ID resolution, PDA derivation, relay URL.
 * All pure math (denominations, greedySplit, fee calc, state offsets)
 * is imported from v2-core shared modules.
 */

import { PublicKey } from '@solana/web3.js';

// ─── Shared core imports ────────────────────────────────────────────────────
// These are the SAME functions used by the CLI SDK.

// @ts-ignore - CJS module resolved via webpack alias
import { DENOMINATIONS, STATE_OFFSETS_V2, SEEDS_V2 } from 'v2-core/constants';
// @ts-ignore
import { greedySplit, getInventory, planWithdrawal } from 'v2-core/planner';
// @ts-ignore
import { calculateRelayFee } from 'v2-core/fee';

// Re-export shared core for consumers
export { DENOMINATIONS, STATE_OFFSETS_V2, greedySplit, getInventory, planWithdrawal, calculateRelayFee };

// ─── Program ID (browser-specific: env var + hostname detection) ────────────

function resolveProgamId(): string {
  if (process.env.NEXT_PUBLIC_V2_PROGRAM_ID) return process.env.NEXT_PUBLIC_V2_PROGRAM_ID;
  if (typeof window !== 'undefined'
    && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
    return 'HVcTokFF4rwvcU7sC7GjS317CSf7QDgfCvW7edijKS2v';
  }
  return 'HVcTokFF4rwvcU7sC7GjS317CSf7QDgfCvW7edijKS2v';
}

export const V2_PROGRAM_ID = new PublicKey(resolveProgamId());

// ─── PDA Derivation (browser-specific: uses TextEncoder) ────────────────────

const _enc = new TextEncoder();

export function deriveV2PoolPDAs(denomination: bigint) {
  const denomBuf = new Uint8Array(8);
  new DataView(denomBuf.buffer).setBigUint64(0, denomination, true);

  const [statePda] = PublicKey.findProgramAddressSync(
    [_enc.encode(SEEDS_V2.STATE), denomBuf], V2_PROGRAM_ID,
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [_enc.encode(SEEDS_V2.VAULT), statePda.toBytes()], V2_PROGRAM_ID,
  );
  const [vkPda] = PublicKey.findProgramAddressSync(
    [_enc.encode(SEEDS_V2.VK), statePda.toBytes()], V2_PROGRAM_ID,
  );
  return { statePda, vaultPda, vkPda };
}

export function deriveV2NullifierPda(nullifierHashBytes: Uint8Array) {
  const [pda] = PublicKey.findProgramAddressSync(
    [_enc.encode(SEEDS_V2.NULLIFIER), nullifierHashBytes], V2_PROGRAM_ID,
  );
  return pda;
}

// ─── Relay URL (follows network detection, not hostname) ────────────────────

export function getRelayUrl(): string {
  // Import inline to avoid circular dependency at module init time
  const { getRelayEndpoint } = require('@/lib/network-config');
  return getRelayEndpoint();
}

// Legacy alias for backward compat
export const V2_STATE_OFFSETS = STATE_OFFSETS_V2;
