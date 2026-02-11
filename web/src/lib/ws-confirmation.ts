/**
 * WebSocket-First Transaction Confirmation
 *
 * Ported from CLI: cli/utils/resilient-rpc.js confirmTransactionWithPool()
 *
 * This module implements the CLI's elegant confirmation pattern that achieved
 * 50+ concurrent operations without 429 errors:
 *
 * 1. WebSocket Subscriptions via `connection.onSignature()`
 *    - Push notifications (1 subscription) vs polling (10+ RPC calls)
 *    - 90% reduction in RPC call volume
 *
 * 2. Race Pattern with Grace Period
 *    - WS gets 2s head start (devnet) / 5s (mainnet)
 *    - HTTP polling starts after grace period
 *    - Whichever finishes first wins
 *
 * 3. Endpoint Rotation on Failure
 *    - Helius WS (549ms) → Solana WS (12900ms) → HTTP fallback
 */

import { Commitment, SignatureResult, Connection } from '@solana/web3.js';
import { executeWithRotation } from './resilient-connection';
// WS imports disabled (2026-01-10) - Helius WS is broken, using HTTP-only
// import { getWsConnection, rotateWsEndpoint, resetWsConnection } from './ws-connection';

/**
 * Confirmation result with metrics
 */
export interface WsConfirmationResult {
  confirmed: boolean;
  confirmMode: 'ws' | 'http_race' | 'http_fallback';
  durationMs: number;
  wsRotations: number;
  error?: string;
}

/**
 * Track confirmed signatures to prevent duplicate confirmations
 */
const confirmedSignatures = new Set<string>();

/**
 * Check if signature is already confirmed (short-circuit)
 */
export function isSignatureConfirmed(signature: string): boolean {
  return confirmedSignatures.has(signature);
}

/**
 * Mark signature as confirmed
 */
function markSignatureConfirmed(signature: string): void {
  confirmedSignatures.add(signature);
  // Clean up after 5 minutes to prevent memory leak
  setTimeout(() => confirmedSignatures.delete(signature), 5 * 60 * 1000);
}

/**
 * Detect 429 rate limit errors
 */
function is429Error(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.message.includes('429') ||
      error.message.includes('Too many requests') ||
      error.message.includes('Too Many Requests')
    );
  }
  return false;
}

/**
 * Confirm transaction via WebSocket subscription
 *
 * Uses `connection.onSignature()` for push notifications instead of polling.
 * This is the core of the CLI's efficient confirmation pattern.
 *
 * @param connection - Connection with WebSocket support
 * @param signature - Transaction signature to confirm
 * @param commitment - Commitment level
 * @param timeoutMs - Timeout in milliseconds
 */
async function confirmViaWebSocket(
  connection: Connection,
  signature: string,
  commitment: Commitment = 'confirmed',
  timeoutMs: number = 30000
): Promise<{ result: SignatureResult; durationMs: number }> {
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    let subscriptionId: number | null = null;
    let timeoutId: NodeJS.Timeout | null = null;
    let resolved = false;

    // Cleanup function
    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (subscriptionId !== null) {
        try {
          connection.removeSignatureListener(subscriptionId);
        } catch (e) {
          // Ignore cleanup errors
        }
        subscriptionId = null;
      }
    };

    // Set up WebSocket subscription
    try {
      subscriptionId = connection.onSignature(
        signature,
        (result: SignatureResult) => {
          if (resolved) return;
          resolved = true;
          cleanup();

          const durationMs = Date.now() - startTime;

          if (result.err) {
            reject(new Error(`Transaction failed: ${JSON.stringify(result.err)}`));
          } else {
            resolve({ result, durationMs });
          }
        },
        commitment
      );

      console.log(`[WS] Subscribed to ${signature.slice(0, 16)}... (timeout: ${timeoutMs}ms)`);

    } catch (subscribeError) {
      cleanup();
      reject(subscribeError);
      return;
    }

    // Set up timeout
    timeoutId = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(new Error(`WebSocket confirmation timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

/**
 * Confirm transaction via HTTP polling (fallback)
 *
 * Used when WebSocket confirmation fails or times out.
 * Polls getSignatureStatus every 2 seconds.
 */
async function confirmViaHttpPolling(
  signature: string,
  commitment: Commitment = 'confirmed',
  timeoutMs: number = 60000
): Promise<{ durationMs: number }> {
  const startTime = Date.now();
  const pollInterval = 1000; // 1 second (faster confirmation while still rate-limited)

  console.log(`[HTTP] Polling for ${signature.slice(0, 16)}... (timeout: ${timeoutMs}ms)`);

  while (Date.now() - startTime < timeoutMs) {
    // Short-circuit if already confirmed via WS
    if (isSignatureConfirmed(signature)) {
      return { durationMs: Date.now() - startTime };
    }

    try {
      // Use Helius first (better rate limits than Solana Public)
      const status = await executeWithRotation(
        (conn) => conn.getSignatureStatus(signature)
      );

      if (status.value !== null) {
        if (status.value.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
        }

        const confirmationStatus = status.value.confirmationStatus;
        if (
          confirmationStatus === commitment ||
          confirmationStatus === 'finalized' ||
          (commitment === 'confirmed' && confirmationStatus === 'confirmed')
        ) {
          return { durationMs: Date.now() - startTime };
        }
      }
    } catch (pollError) {
      if (is429Error(pollError)) {
        // Rate limited - wait longer
        console.warn(`[HTTP] Rate limited, waiting ${pollInterval * 2}ms...`);
        await new Promise(resolve => setTimeout(resolve, pollInterval * 2));
        continue;
      }
      // Other errors - continue polling
      console.warn(`[HTTP] Poll error:`, pollError);
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  throw new Error(`HTTP confirmation timeout after ${timeoutMs}ms`);
}

/**
 * Confirm transaction with HTTP polling
 *
 * WebSocket confirmations are DISABLED (2026-01-10):
 * - Helius WS is 100% broken (every connection attempt fails immediately)
 * - web3.js Connection has auto-reconnect, causing orphaned connections to spam errors
 * - HTTP polling works well (280-420ms confirmation times)
 *
 * When WS starts working again, this can be re-enabled by restoring the
 * WS+HTTP race pattern that was here previously.
 *
 * @param signature - Transaction signature to confirm
 * @param commitment - Commitment level
 * @param options - Optional configuration
 */
export async function confirmTransactionWsFirst(
  signature: string,
  commitment: Commitment = 'confirmed',
  options: {
    wsTimeoutMs?: number;
    httpTimeoutMs?: number;
    gracePeriodMs?: number;
  } = {}
): Promise<WsConfirmationResult> {
  const startTime = Date.now();
  const { httpTimeoutMs = 60000 } = options;

  // Short-circuit if already confirmed
  if (isSignatureConfirmed(signature)) {
    console.log(`[Confirm] ${signature.slice(0, 16)}... already confirmed (short-circuit)`);
    return {
      confirmed: true,
      confirmMode: 'ws',
      durationMs: 0,
      wsRotations: 0,
    };
  }

  // Use HTTP-only polling (WS disabled due to Helius WS being broken)
  console.log(`[Confirm] Using HTTP polling for ${signature.slice(0, 16)}...`);

  try {
    const httpResult = await confirmViaHttpPolling(signature, commitment, httpTimeoutMs);
    markSignatureConfirmed(signature);

    console.log(`[Confirm] ${signature.slice(0, 16)}... confirmed via HTTP in ${httpResult.durationMs}ms`);

    return {
      confirmed: true,
      confirmMode: 'http_fallback',
      durationMs: httpResult.durationMs,
      wsRotations: 0,
    };
  } catch (httpError) {
    const errorMsg = httpError instanceof Error ? httpError.message : String(httpError);
    console.error(`[Confirm] HTTP confirmation failed: ${errorMsg}`);

    return {
      confirmed: false,
      confirmMode: 'http_fallback',
      durationMs: Date.now() - startTime,
      wsRotations: 0,
      error: errorMsg,
    };
  }
}

/**
 * Simple wrapper for backward compatibility
 *
 * Matches the signature of the old confirmWithFallback function.
 */
export async function confirmWithWsFirst(
  _connection: Connection,  // Unused - uses internal WS connection
  signature: string,
  _blockhash: string,       // Unused - not needed for onSignature
  _lastValidBlockHeight: number,  // Unused
  commitment: Commitment = 'confirmed'
): Promise<void> {
  const result = await confirmTransactionWsFirst(signature, commitment);

  if (!result.confirmed) {
    throw new Error(result.error || 'Transaction confirmation failed');
  }
}
