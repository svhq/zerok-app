/**
 * Relayer Client for ZeroK Protocol
 *
 * CRITICAL PRIVACY INVARIANT:
 * User wallets MUST NEVER sign withdrawal transactions.
 * All withdrawals go through the relayer, which signs and submits on-chain.
 * This preserves anonymity by not linking the user's wallet to the withdrawal.
 *
 * API Format (v2 - JSON instruction):
 * POST /v1/relay/withdraw
 * {
 *   poolId: string,
 *   instruction: {
 *     programId: string (base58),
 *     keys: [{ pubkey: string, isSigner: boolean, isWritable: boolean }, ...],
 *     data: string (base64)
 *   }
 * }
 */

import { TransactionInstruction, PublicKey } from '@solana/web3.js';
import { detectNetworkFromHostname } from './network-config';

// =============================================================================
// RELAY ENDPOINT CONFIGURATION
// =============================================================================

/**
 * Relay endpoints per network.
 * IMPORTANT: Do NOT use generic env vars like NEXT_PUBLIC_RELAY_URL
 * in multi-subdomain deployments - they override hostname detection!
 *
 * Network detection is centralized in network-config.ts (single source of truth).
 */
const RELAY_ENDPOINTS: Record<string, string> = {
  'devnet': 'https://zerok-relay-v2-production.up.railway.app',
  'testnet': 'https://relay-testnet.up.railway.app',
  'mainnet-beta': 'https://zerok-relay-mainnet-production.up.railway.app',
  'localnet': 'http://localhost:8789',
};

/**
 * Get the relay endpoint URL for the current network.
 * Uses network-specific env vars if available, otherwise falls back to hardcoded map.
 */
export function getRelayEndpoint(): string {
  const network = detectNetworkFromHostname();

  // Check network-specific env var first (safe for multi-subdomain)
  if (network === 'devnet' && process.env.NEXT_PUBLIC_RELAY_URL_DEVNET) {
    return process.env.NEXT_PUBLIC_RELAY_URL_DEVNET;
  }
  if (network === 'testnet' && process.env.NEXT_PUBLIC_RELAY_URL_TESTNET) {
    return process.env.NEXT_PUBLIC_RELAY_URL_TESTNET;
  }
  if (network === 'mainnet-beta' && process.env.NEXT_PUBLIC_RELAY_URL_MAINNET) {
    return process.env.NEXT_PUBLIC_RELAY_URL_MAINNET;
  }

  // Fallback to hardcoded map
  const endpoint = RELAY_ENDPOINTS[network];
  if (!endpoint) {
    throw new Error(`No relay endpoint configured for network: ${network}`);
  }

  return endpoint;
}

// =============================================================================
// TYPES
// =============================================================================

export interface RelayerWithdrawRequest {
  poolId: string;
  instruction: {
    programId: string;
    keys: Array<{
      pubkey: string;
      isSigner: boolean;
      isWritable: boolean;
    }>;
    data: string; // base64
  };
}

export interface RelayerWithdrawResponse {
  signature: string;
  slot?: number;
  confirmed: boolean;
  status: 'success' | 'failed' | 'duplicate';
  explorerUrl?: string;
  error?: string;
  message?: string;
}

export interface RelayerHealthResponse {
  status: 'ok' | 'error';
  network: string;
  relayer: string;
  mode: string;
  pools: string[];
}

export interface RelayerError {
  error: string;
  message: string;
  code?: string;
  details?: unknown;
}

// =============================================================================
// INSTRUCTION SERIALIZATION
// =============================================================================

/**
 * Convert a TransactionInstruction to the JSON format expected by the relay API.
 *
 * @param instruction - The withdraw instruction (from buildWithdrawTransaction)
 * @returns JSON-serializable object for relay API
 */
export function instructionToRelayFormat(
  instruction: TransactionInstruction
): RelayerWithdrawRequest['instruction'] {
  return {
    programId: instruction.programId.toBase58(),
    keys: instruction.keys.map(key => ({
      pubkey: key.pubkey.toBase58(),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
    data: Buffer.from(instruction.data).toString('base64'),
  };
}

// =============================================================================
// API METHODS
// =============================================================================

/**
 * Check if the relay service is healthy.
 *
 * @returns Health status including relayer wallet and supported pools
 * @throws Error if relay is unreachable
 */
export async function checkRelayerHealth(): Promise<RelayerHealthResponse> {
  const endpoint = getRelayEndpoint();

  const response = await fetch(`${endpoint}/health`, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Relay health check failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Submit a withdrawal to the relay service.
 *
 * CRITICAL: This is the ONLY way to submit withdrawals.
 * The relay signs and submits the transaction, preserving user privacy.
 *
 * @param poolId - Pool ID (e.g., "devnet-0p1sol-v2c-20shard")
 * @param instruction - The withdraw instruction (from buildWithdrawTransaction)
 * @returns Response with transaction signature or error
 * @throws Error if relay is unreachable or request is invalid
 */
export async function submitWithdrawalToRelay(
  poolId: string,
  instruction: TransactionInstruction
): Promise<RelayerWithdrawResponse> {
  const endpoint = getRelayEndpoint();

  const request: RelayerWithdrawRequest = {
    poolId,
    instruction: instructionToRelayFormat(instruction),
  };

  console.log('[Relayer] Submitting withdrawal to:', endpoint);
  console.log('[Relayer] Pool:', poolId);
  console.log('[Relayer] Program:', request.instruction.programId);
  console.log('[Relayer] Accounts:', request.instruction.keys.length);

  const response = await fetch(`${endpoint}/v1/relay/withdraw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(request),
  });

  const result = await response.json();

  if (!response.ok) {
    // Parse error response
    const error = result as RelayerError;
    console.error('[Relayer] Request failed:', error);

    // Map common error codes to user-friendly messages
    if (error.error === 'NULLIFIER_ALREADY_USED') {
      throw new Error('This note has already been withdrawn');
    }
    if (error.error === 'SIMULATION_FAILED') {
      throw new Error(`Transaction simulation failed: ${error.message || 'Unknown error'}`);
    }
    if (error.error === 'Invalid relayer') {
      throw new Error('Relay service configuration mismatch. Please refresh the page.');
    }

    throw new Error(error.message || error.error || 'Relay request failed');
  }

  const withdrawResponse = result as RelayerWithdrawResponse;
  console.log('[Relayer] Response:', {
    signature: withdrawResponse.signature,
    status: withdrawResponse.status,
    confirmed: withdrawResponse.confirmed,
  });

  return withdrawResponse;
}

/**
 * Back up an encrypted note blob to the relay server.
 * The relay stores the opaque blob — it cannot decrypt it without the wallet key.
 * Fire-and-forget: localStorage is the primary store; relay is the cross-device fallback.
 */
export async function backupNoteToRelay(commitment: string, encrypted: string): Promise<void> {
  const endpoint = getRelayEndpoint();
  try {
    await fetch(`${endpoint}/v1/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commitment, encrypted }),
    });
    console.log('[Relayer] Note backed up:', commitment.slice(2, 10));
  } catch (err) {
    console.warn('[Relayer] Note backup failed (non-fatal):', err);
  }
}

/**
 * Fetch ALL encrypted note blobs from the relay.
 * Returns array of { commitment, encrypted } entries.
 * Used during cross-device recovery: try to decrypt each entry with wallet key.
 */
export async function fetchAllNotesFromRelay(): Promise<Array<{ commitment: string; encrypted: string }>> {
  const endpoint = getRelayEndpoint();
  try {
    const response = await fetch(`${endpoint}/v1/notes/all`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    if (!response.ok) return [];
    return response.json();
  } catch {
    return [];
  }
}

/**
 * Get list of pools supported by the relay.
 * Useful for verifying configuration consistency.
 */
export async function getRelayPools(): Promise<{
  network: string;
  relayer: string;
  pools: Array<{ poolId: string; denomination: string }>;
}> {
  const endpoint = getRelayEndpoint();

  const response = await fetch(`${endpoint}/v1/pools`, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get relay pools: ${response.status} ${response.statusText}`);
  }

  return response.json();
}
