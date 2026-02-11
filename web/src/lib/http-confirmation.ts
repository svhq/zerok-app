/**
 * HTTP Confirmation Fallback
 *
 * Ported from CLI: /zerok/cli/utils/resilient-rpc.js
 *
 * Provides HTTP polling-based transaction confirmation as a fallback
 * when WebSocket confirmation fails (e.g., Ankr doesn't support DevNet WS).
 *
 * This is a battle-tested pattern from the CLI that handles 30-50 operations reliably.
 *
 * Key fixes (2026-01-10):
 * - Short-circuit after success (prevents confirmation retry storm)
 * - Graceful 429 handling (returns pending status instead of error)
 * - Confirmation tracking (prevents duplicate confirmations)
 */

import { Connection, Commitment } from '@solana/web3.js';
import { executeWithRotation } from './resilient-connection';

/**
 * Track confirmed signatures to prevent duplicate confirmation attempts
 * This prevents the self-DDOS pattern where confirmations continue after success
 */
const confirmedSignatures = new Set<string>();

/**
 * Check if a signature is already confirmed (short-circuit)
 */
export function isAlreadyConfirmed(signature: string): boolean {
  return confirmedSignatures.has(signature);
}

/**
 * Mark a signature as confirmed (prevents future confirmation attempts)
 */
function markConfirmed(signature: string): void {
  confirmedSignatures.add(signature);
  // Clean up old entries after 5 minutes to prevent memory leak
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
 * Confirmation result with status
 */
export interface ConfirmationResult {
  status: 'confirmed' | 'pending' | 'failed';
  message?: string;
}

/**
 * Confirm transaction using HTTP polling (fallback when WS fails)
 *
 * Ported from CLI: resilient-rpc.js lines 971-1000
 * Uses executeWithRotation internally for high rate limits via Helius.
 *
 * Key improvements (2026-01-10):
 * - Short-circuit if already confirmed
 * - Graceful 429 handling (returns pending instead of error)
 * - 3 second polling interval (reduced from aggressive retries)
 *
 * @param signature - Transaction signature to confirm
 * @param commitment - Commitment level (default: 'confirmed')
 * @param timeoutMs - Timeout in milliseconds (default: 60000)
 */
export async function confirmViaHttpPolling(
  signature: string,
  commitment: Commitment = 'confirmed',
  timeoutMs: number = 60000
): Promise<ConfirmationResult> {
  // Short-circuit if already confirmed
  if (isAlreadyConfirmed(signature)) {
    console.log(`[HTTP Confirm] ${signature.slice(0, 16)}... already confirmed (short-circuit)`);
    return { status: 'confirmed', message: 'Already confirmed' };
  }

  const startTime = Date.now();
  const pollInterval = 3000; // 3 seconds (slower to reduce RPC pressure)
  let consecutiveErrors = 0;
  const maxConsecutiveErrors = 3;

  console.log(`[HTTP Confirm] Polling for ${signature.slice(0, 16)}... (timeout: ${timeoutMs}ms)`);

  while (Date.now() - startTime < timeoutMs) {
    // Check short-circuit on each iteration
    if (isAlreadyConfirmed(signature)) {
      return { status: 'confirmed', message: 'Confirmed by another path' };
    }

    try {
      // Use executeWithRotation for Helius (high rate limits)
      const status = await executeWithRotation(
        (conn) => conn.getSignatureStatus(signature)
      );

      consecutiveErrors = 0; // Reset error counter on success

      if (status.value !== null) {
        if (status.value.err) {
          return { status: 'failed', message: `Transaction failed: ${JSON.stringify(status.value.err)}` };
        }

        const confirmationStatus = status.value.confirmationStatus;

        // Check if we've reached the desired confirmation level
        if (
          confirmationStatus === commitment ||
          confirmationStatus === 'finalized' ||
          (commitment === 'confirmed' && confirmationStatus === 'confirmed')
        ) {
          const elapsed = Date.now() - startTime;
          console.log(`[HTTP Confirm] ${signature.slice(0, 16)}... confirmed in ${elapsed}ms`);
          markConfirmed(signature); // Mark as confirmed to prevent future retries
          return { status: 'confirmed' };
        }

        console.log(`[HTTP Confirm] ${signature.slice(0, 16)}... status: ${confirmationStatus}`);
      }
    } catch (pollError) {
      consecutiveErrors++;

      // Handle 429 gracefully - don't fail, return pending status
      if (is429Error(pollError)) {
        console.warn(`[HTTP Confirm] Rate limited for ${signature.slice(0, 16)}...`);
        if (consecutiveErrors >= maxConsecutiveErrors) {
          console.warn(`[HTTP Confirm] Too many rate limits, returning pending status`);
          return {
            status: 'pending',
            message: 'Transaction sent. Confirmation delayed due to rate limiting. Check explorer.',
          };
        }
        // Wait longer on rate limit
        await new Promise((resolve) => setTimeout(resolve, pollInterval * 2));
        continue;
      }

      console.warn(`[HTTP Confirm] Poll error for ${signature.slice(0, 16)}...:`, pollError);
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  // Timeout - return pending instead of throwing
  return {
    status: 'pending',
    message: `Transaction confirmation timeout after ${timeoutMs}ms. Check explorer: ${signature}`,
  };
}

/**
 * Confirm transaction with automatic fallback from WS to HTTP
 *
 * Tries WebSocket confirmation first (faster), falls back to HTTP polling if WS fails.
 * Uses executeWithRotation internally for high rate limits via Helius.
 *
 * Key improvements (2026-01-10):
 * - Short-circuit if already confirmed
 * - Graceful 429 handling in fallback
 * - Returns ConfirmationResult instead of throwing
 *
 * @param _connection - Unused, kept for API compatibility (uses executeWithRotation internally)
 * @param signature - Transaction signature
 * @param blockhash - Recent blockhash used for the transaction
 * @param lastValidBlockHeight - Block height until which the transaction is valid
 * @param commitment - Commitment level
 */
export async function confirmWithFallback(
  _connection: Connection,
  signature: string,
  blockhash: string,
  lastValidBlockHeight: number,
  commitment: Commitment = 'confirmed'
): Promise<ConfirmationResult> {
  // Short-circuit if already confirmed
  if (isAlreadyConfirmed(signature)) {
    console.log(`[Confirm] ${signature.slice(0, 16)}... already confirmed (short-circuit)`);
    return { status: 'confirmed', message: 'Already confirmed' };
  }

  try {
    // Try WebSocket confirmation first (faster when it works)
    // Use executeWithRotation for Helius (high rate limits)
    await executeWithRotation(async (conn) => {
      const result = await conn.confirmTransaction(
        {
          signature,
          blockhash,
          lastValidBlockHeight,
        },
        commitment
      );
      if (result.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
      }
    });
    console.log(`[Confirm] ${signature.slice(0, 16)}... confirmed via WebSocket`);
    markConfirmed(signature); // Mark as confirmed to prevent future retries
    return { status: 'confirmed' };
  } catch (wsError) {
    // Check if already confirmed before falling back (another path may have confirmed)
    if (isAlreadyConfirmed(signature)) {
      return { status: 'confirmed', message: 'Confirmed by another path' };
    }

    // Handle 429 gracefully
    if (is429Error(wsError)) {
      console.warn(`[Confirm] Rate limited on WS for ${signature.slice(0, 16)}...`);
    }

    // WebSocket failed, fall back to HTTP polling
    console.log(
      `[Confirm] WebSocket failed for ${signature.slice(0, 16)}..., falling back to HTTP polling`
    );
    return await confirmViaHttpPolling(signature, commitment, 60000);
  }
}
