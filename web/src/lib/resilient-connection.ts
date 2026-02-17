/**
 * Resilient RPC Connection Utility
 *
 * Ported from CLI: /zerok/cli/utils/resilient-rpc.js
 *
 * Features:
 * - Same endpoint priority (Helius -> Solana -> Ankr)
 * - Retry with exponential backoff + jitter on 429s
 * - Automatic endpoint rotation on failures
 * - Global endpoint health tracking with cooldown (429 penalty box)
 *
 * ANTI-DRIFT: Network detection from hostname, NOT generic env vars.
 * See: network-config.ts for endpoint configuration.
 */

import { Connection, Commitment } from '@solana/web3.js';
import { getGlobalRateLimiter, getGetTransactionSemaphore } from './rpc-limiter';
import { getRpcEndpoints, getCurrentNetwork, getPublicRpcEndpoint } from './network-config';

// =============================================================================
// GLOBAL ENDPOINT HEALTH TRACKING
// =============================================================================
// When an endpoint returns 429, it goes into "penalty box" for COOLDOWN_MS.
// Subsequent calls skip disabled endpoints instead of hammering them.
// This prevents the pattern: try Helius -> 429 -> rotate -> [next call] -> try Helius again -> 429

interface EndpointHealth {
  disabledUntil: number;  // Timestamp when endpoint becomes available again
  failCount: number;      // Consecutive 429 failures
}

const endpointHealth: Map<string, EndpointHealth> = new Map();
const COOLDOWN_MS = 2_000;  // 2 second cooldown after 429 (reduced for single-endpoint networks)

/**
 * Check if an endpoint is available (not in cooldown)
 */
function isEndpointAvailable(url: string): boolean {
  const health = endpointHealth.get(url);
  if (!health) return true;

  const now = Date.now();
  if (now >= health.disabledUntil) {
    // Cooldown expired, re-enable endpoint
    endpointHealth.delete(url);
    console.log(`[RPC] Endpoint ${url.substring(0, 40)}... cooldown expired, re-enabled`);
    return true;
  }

  return false;
}

/**
 * Mark an endpoint as disabled after 429 (put in penalty box)
 */
function markEndpointDisabled(url: string): void {
  const existing = endpointHealth.get(url) || { disabledUntil: 0, failCount: 0 };
  existing.failCount++;
  existing.disabledUntil = Date.now() + COOLDOWN_MS;
  endpointHealth.set(url, existing);

  const remainingSec = Math.round(COOLDOWN_MS / 1000);
  console.log(`[RPC] Endpoint ${url.substring(0, 40)}... disabled for ${remainingSec}s (fail #${existing.failCount})`);
}

/**
 * Mark an endpoint as healthy after successful call (reset fail count)
 */
function markEndpointHealthy(url: string): void {
  if (endpointHealth.has(url)) {
    endpointHealth.delete(url);
    console.log(`[RPC] Endpoint ${url.substring(0, 40)}... marked healthy`);
  }
}

/**
 * Get cooldown status for debugging
 */
export function getEndpointHealthStatus(): Record<string, { available: boolean; disabledFor?: number; failCount?: number }> {
  const result: Record<string, { available: boolean; disabledFor?: number; failCount?: number }> = {};
  const now = Date.now();
  const endpoints = getNetworkEndpoints();

  for (const url of endpoints) {
    const health = endpointHealth.get(url);
    if (!health || now >= health.disabledUntil) {
      result[url.substring(0, 40)] = { available: true };
    } else {
      result[url.substring(0, 40)] = {
        available: false,
        disabledFor: Math.round((health.disabledUntil - now) / 1000),
        failCount: health.failCount,
      };
    }
  }

  return result;
}

/**
 * Get the shortest remaining cooldown time across all endpoints.
 * Returns 0 if any endpoint is available.
 */
function getShortestCooldownMs(): number {
  const now = Date.now();
  const endpoints = getNetworkEndpoints();

  let shortestWait = Infinity;

  for (const url of endpoints) {
    const health = endpointHealth.get(url);
    if (!health || now >= health.disabledUntil) {
      return 0; // At least one endpoint is available
    }
    const remaining = health.disabledUntil - now;
    if (remaining < shortestWait) {
      shortestWait = remaining;
    }
  }

  return shortestWait === Infinity ? 0 : shortestWait;
}

/**
 * Get RPC endpoints for current network (from hostname detection)
 *
 * Uses centralized network-config.ts (single source of truth).
 * NO hardcoded devnet URLs - network is determined by hostname.
 *
 * Priority order: Helius (if env var set) -> Solana Public -> Ankr
 * IMPORTANT: Helius key must be separate from daemon key to avoid rate limit competition
 */
function getNetworkEndpoints(): string[] {
  const endpoints = getRpcEndpoints();
  console.log(`[RPC] Network: ${getCurrentNetwork()}, endpoints: ${endpoints.length}`);
  return endpoints;
}

/**
 * Detect 429 rate limit errors (same logic as CLI)
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
 * Try an RPC operation with a specific endpoint, handling 429s gracefully
 * Ported from CLI: tryEndpointWithRetry() (lines 433-475)
 *
 * @param url - RPC endpoint URL
 * @param operation - Async function to execute with the connection
 * @param commitment - Commitment level
 * @param maxRetries - Max retries per endpoint
 * @returns Operation result
 */
async function tryEndpointWithRetry<T>(
  url: string,
  operation: (connection: Connection) => Promise<T>,
  commitment: Commitment = 'confirmed',
  maxRetries = 3
): Promise<{ success: true; result: T; endpoint: string }> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Disable web3.js internal 429 retry so our rate limiter controls everything
      // Without this, web3.js retries 4-5 times internally on 429, multiplying RPC calls by 5x
      const connection = new Connection(url, {
        commitment,
        disableRetryOnRateLimit: true,
      });
      const result = await operation(connection);
      return { success: true, result, endpoint: url };
    } catch (error) {
      if (is429Error(error)) {
        // CHANGED: On 429, immediately rotate to next endpoint instead of retrying same one
        // Don't hammer a rate-limited endpoint - rotate immediately and try another
        console.log(`[RPC] 429 on ${url.substring(0, 40)}..., rotating immediately`);
        throw error;
      }
      // Other errors: retry with backoff on same endpoint
      if (attempt < maxRetries) {
        const baseDelay = Math.pow(2, attempt) * 500; // 1s, 2s, 4s
        const jitter = Math.random() * 500; // 0-500ms random
        const delay = baseDelay + jitter;
        console.log(
          `[RPC] Error on ${url.substring(0, 40)}..., retry ${attempt}/${maxRetries} in ${Math.round(delay)}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Failed after ${maxRetries} attempts at ${url}`);
}

/**
 * Execute an operation with full endpoint rotation
 * Ported from CLI: createResilientConnectionWithRotation() (lines 485-554)
 *
 * Tries each endpoint with retries before moving to next.
 * Skips endpoints that are in cooldown (recently returned 429).
 *
 * @param operation - Async function to execute with a Connection
 * @param commitment - Commitment level (default: 'confirmed')
 * @param preferNonPrimary - If true, try non-primary endpoints first (useful for getTransaction, which
 *                           can stress Helius rate limits). Default: false
 * @returns Operation result
 */
export async function executeWithRotation<T>(
  operation: (connection: Connection) => Promise<T>,
  commitment: Commitment = 'confirmed',
  preferNonPrimary: boolean = false
): Promise<T> {
  // Dual-layer rate limiting applied to ALL RPC calls (ported from CLI)
  // Layer 1: QPS control (2 req/sec leaky bucket)
  // Layer 2: Semaphore (max 3 concurrent)
  // This prevents 429 errors structurally by limiting request rate at the source.
  await getGlobalRateLimiter().acquire();
  const semaphore = getGetTransactionSemaphore();
  await semaphore.acquire();

  try {
    const errors: { endpoint: string; error: string }[] = [];
    let triedAny = false;

    // Get endpoints for current network
    const networkEndpoints = getNetworkEndpoints();
    // If preferNonPrimary, reverse the endpoint order (fallbacks first)
    // This helps avoid primary rate limits for heavy operations like getTransaction
    const endpoints = preferNonPrimary
      ? [...networkEndpoints].reverse()
      : networkEndpoints;

    for (let i = 0; i < endpoints.length; i++) {
      const endpoint = endpoints[i];

      // Skip endpoints that are in cooldown (penalty box)
      if (!isEndpointAvailable(endpoint)) {
        console.log(`[RPC] Skipping ${endpoint.substring(0, 40)}... (in cooldown)`);
        continue;
      }

      triedAny = true;

      try {
        const result = await tryEndpointWithRetry(endpoint, operation, commitment, 2);
        if (i > 0) {
          console.log(`[RPC] Rotated to endpoint ${i + 1}: ${endpoint.substring(0, 40)}...`);
        }
        // Success - mark endpoint as healthy (reset fail count)
        markEndpointHealthy(endpoint);
        return result.result;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        errors.push({ endpoint, error: errMsg });
        console.log(`[RPC] Endpoint failed: ${endpoint.substring(0, 40)}... (${errMsg})`);

        // On 429, put endpoint in penalty box
        if (is429Error(error)) {
          markEndpointDisabled(endpoint);
        }
      }
    }

    // If all endpoints are in cooldown and we didn't try any, wait and retry once
    // This is especially important for single-endpoint networks (testnet) where
    // there's no rotation fallback.
    if (!triedAny) {
      const waitMs = getShortestCooldownMs();
      if (waitMs > 0 && waitMs <= COOLDOWN_MS) {
        console.log(`[RPC] All endpoints in cooldown, waiting ${waitMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, waitMs + 100)); // +100ms buffer

        // Retry once after waiting
        const retryEndpoints = getNetworkEndpoints();
        for (const endpoint of retryEndpoints) {
          if (isEndpointAvailable(endpoint)) {
            try {
              const result = await tryEndpointWithRetry(endpoint, operation, commitment, 2);
              markEndpointHealthy(endpoint);
              return result.result;
            } catch (error) {
              const errMsg = error instanceof Error ? error.message : 'Unknown error';
              if (is429Error(error)) {
                markEndpointDisabled(endpoint);
              }
              throw new Error(`RPC failed after cooldown wait: ${errMsg}`);
            }
          }
        }
      }

      throw new Error(
        `All RPC endpoints are in cooldown (rate limited). Wait for cooldown to expire.\n` +
        `Status: ${JSON.stringify(getEndpointHealthStatus(), null, 2)}`
      );
    }

    throw new Error(
      `All RPC endpoints failed:\n${errors.map((e) => `  - ${e.endpoint}: ${e.error}`).join('\n')}`
    );
  } finally {
    semaphore.release();
  }
}

/**
 * Get the endpoint for wallet adapter ConnectionProvider.
 *
 * IMPORTANT: Returns the FREE public endpoint, NOT the paid primary.
 *
 * WHY: Phantom and other wallets make ~40+ background RPC calls/min per connected
 * user (balance checks, tx history, etc.) through ConnectionProvider's endpoint.
 * On mainnet with 100 users, that's 4,000+ req/min of wallet background noise.
 * Using a paid endpoint here would burn credits on non-critical wallet polling.
 *
 * ARCHITECTURE (two-layer RPC):
 * - ConnectionProvider (this function) → Free public endpoint (wallet background noise)
 * - executeWithRotation() → Paid endpoints (deposit/withdrawal critical operations)
 *
 * Our deposit/withdrawal code uses executeWithRotation() which creates its own
 * Connection instances with paid endpoints — it never uses ConnectionProvider.
 */
export function getPrimaryEndpoint(): string {
  return getPublicRpcEndpoint();
}

/**
 * Get all configured endpoints (for advanced use cases)
 */
export function getEndpoints(): readonly string[] {
  return getNetworkEndpoints();
}
