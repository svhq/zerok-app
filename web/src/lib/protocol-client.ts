/**
 * Protocol Client for ZeroK Protocol
 *
 * CRITICAL PRIVACY INVARIANT:
 * User wallets MUST NEVER sign withdrawal transactions.
 * All withdrawals go through the protocol service, which signs and submits on-chain.
 * This preserves anonymity by not linking the user's wallet to the withdrawal.
 *
 * API Format (v2 - JSON instruction):
 * POST /v1/protocol/withdraw
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
// PROTOCOL ENDPOINT CONFIGURATION
// =============================================================================

/**
 * Protocol service endpoints per network.
 * Configure your protocol service URLs here.
 *
 * Network detection is centralized in network-config.ts (single source of truth).
 */
const PROTOCOL_ENDPOINTS: Record<string, string> = {
  // Configure your protocol service endpoints here
  'devnet': '',
  'testnet': '',
  'mainnet-beta': '',
  'localnet': 'http://localhost:8789',
};

/**
 * Get the protocol service endpoint URL for the current network.
 * Uses network-specific env vars if available, otherwise falls back to hardcoded map.
 */
export function getProtocolEndpoint(): string {
  const network = detectNetworkFromHostname();

  // Check network-specific env var first (safe for multi-subdomain)
  if (network === 'devnet' && process.env.NEXT_PUBLIC_PROTOCOL_URL_DEVNET) {
    return process.env.NEXT_PUBLIC_PROTOCOL_URL_DEVNET;
  }
  if (network === 'testnet' && process.env.NEXT_PUBLIC_PROTOCOL_URL_TESTNET) {
    return process.env.NEXT_PUBLIC_PROTOCOL_URL_TESTNET;
  }
  if (network === 'mainnet-beta' && process.env.NEXT_PUBLIC_PROTOCOL_URL_MAINNET) {
    return process.env.NEXT_PUBLIC_PROTOCOL_URL_MAINNET;
  }

  // Fallback to hardcoded map
  const endpoint = PROTOCOL_ENDPOINTS[network];
  if (!endpoint) {
    throw new Error(`No protocol service endpoint configured for network: ${network}`);
  }

  return endpoint;
}

// =============================================================================
// TYPES
// =============================================================================

export interface ProtocolWithdrawRequest {
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

export interface ProtocolWithdrawResponse {
  signature: string;
  slot?: number;
  confirmed: boolean;
  status: 'success' | 'failed' | 'duplicate';
  explorerUrl?: string;
  error?: string;
  message?: string;
}

export interface ProtocolHealthResponse {
  status: 'ok' | 'error';
  network: string;
  protocol: string;
  mode: string;
  pools: string[];
}

export interface ProtocolError {
  error: string;
  message: string;
  code?: string;
  details?: unknown;
}

// =============================================================================
// INSTRUCTION SERIALIZATION
// =============================================================================

/**
 * Convert a TransactionInstruction to the JSON format expected by the protocol API.
 *
 * @param instruction - The withdraw instruction (from buildWithdrawTransaction)
 * @returns JSON-serializable object for protocol API
 */
export function instructionToProtocolFormat(
  instruction: TransactionInstruction
): ProtocolWithdrawRequest['instruction'] {
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
 * Check if the protocol service is healthy.
 *
 * @returns Health status including protocol wallet and supported pools
 * @throws Error if protocol service is unreachable
 */
export async function checkProtocolHealth(): Promise<ProtocolHealthResponse> {
  const endpoint = getProtocolEndpoint();

  const response = await fetch(`${endpoint}/health`, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Protocol health check failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Submit a withdrawal to the protocol service.
 *
 * CRITICAL: This is the ONLY way to submit withdrawals.
 * The protocol service signs and submits the transaction, preserving user privacy.
 *
 * @param poolId - Pool ID (e.g., "devnet-0p1sol-v2c-20shard")
 * @param instruction - The withdraw instruction (from buildWithdrawTransaction)
 * @returns Response with transaction signature or error
 * @throws Error if protocol service is unreachable or request is invalid
 */
export async function submitWithdrawalToProtocol(
  poolId: string,
  instruction: TransactionInstruction
): Promise<ProtocolWithdrawResponse> {
  const endpoint = getProtocolEndpoint();

  const request: ProtocolWithdrawRequest = {
    poolId,
    instruction: instructionToProtocolFormat(instruction),
  };

  console.log('[Protocol] Submitting withdrawal to:', endpoint);
  console.log('[Protocol] Pool:', poolId);
  console.log('[Protocol] Program:', request.instruction.programId);
  console.log('[Protocol] Accounts:', request.instruction.keys.length);

  const response = await fetch(`${endpoint}/v1/protocol/withdraw`, {
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
    const error = result as ProtocolError;
    console.error('[Protocol] Request failed:', error);

    // Map common error codes to user-friendly messages
    if (error.error === 'NULLIFIER_ALREADY_USED') {
      throw new Error('This note has already been withdrawn');
    }
    if (error.error === 'SIMULATION_FAILED') {
      throw new Error(`Transaction simulation failed: ${error.message || 'Unknown error'}`);
    }
    if (error.error === 'Invalid protocol') {
      throw new Error('Protocol service configuration mismatch. Please refresh the page.');
    }

    throw new Error(error.message || error.error || 'Protocol request failed');
  }

  const withdrawResponse = result as ProtocolWithdrawResponse;
  console.log('[Protocol] Response:', {
    signature: withdrawResponse.signature,
    status: withdrawResponse.status,
    confirmed: withdrawResponse.confirmed,
  });

  return withdrawResponse;
}

/**
 * Get list of pools supported by the protocol service.
 * Useful for verifying configuration consistency.
 */
export async function getProtocolPools(): Promise<{
  network: string;
  protocol: string;
  pools: Array<{ poolId: string; denomination: string }>;
}> {
  const endpoint = getProtocolEndpoint();

  const response = await fetch(`${endpoint}/v1/pools`, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get protocol pools: ${response.status} ${response.statusText}`);
  }

  return response.json();
}
