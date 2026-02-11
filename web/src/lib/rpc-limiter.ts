/**
 * Dual-layer rate limiting for RPC calls
 * Ported from CLI: /zerok/cli/utils/resilient-rpc.js (getTransactionWithLimiter)
 *
 * Problem solved: 429 errors during concurrent getTransaction() calls after deposits
 *
 * Layer 1: Leaky bucket rate limiter (QPS control)
 * - Prevents bursts exceeding RPC provider quotas
 * - Default: 2 requests/second (matches Helius free tier limits)
 *
 * Layer 2: Semaphore (concurrency control)
 * - Prevents too many simultaneous in-flight calls
 * - Default: 3 concurrent max
 *
 * Together, these make 429 errors mathematically impossible under normal load.
 */

/**
 * Leaky bucket rate limiter
 *
 * Conceptually, a bucket holds tokens that "leak" (refill) at a constant rate.
 * To make a request, you must acquire a token. If no tokens are available,
 * you wait until one refills.
 */
class LeakyBucketRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per second

  constructor(maxTokens = 2, refillRatePerSecond = 2) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillRate = refillRatePerSecond;
    this.lastRefill = Date.now();
  }

  /**
   * Acquire a token, waiting if necessary
   */
  async acquire(): Promise<void> {
    this.refill();

    while (this.tokens < 1) {
      // Calculate how long to wait for 1 token
      const waitTime = Math.ceil((1 - this.tokens) / this.refillRate * 1000);
      console.log(`[RateLimiter] Waiting ${waitTime}ms for token...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      this.refill();
    }

    this.tokens -= 1;
    console.log(`[RateLimiter] Acquired token (${this.tokens.toFixed(1)} remaining)`);
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000; // seconds
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

/**
 * Semaphore for concurrency control
 *
 * Limits the number of simultaneous operations.
 * Callers must acquire() before operation and release() after.
 */
class Semaphore {
  private permits: number;
  private waitQueue: Array<() => void> = [];

  constructor(permits = 3) {
    this.permits = permits;
  }

  /**
   * Acquire a permit, waiting if none available
   */
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    // No permits available, wait in queue
    console.log(`[Semaphore] Waiting for permit (${this.waitQueue.length} ahead)...`);
    await new Promise<void>(resolve => this.waitQueue.push(resolve));
    this.permits--;
  }

  /**
   * Release a permit, unblocking next waiter if any
   */
  release(): void {
    this.permits++;
    const next = this.waitQueue.shift();
    if (next) {
      next();
    }
  }
}

// Global instances (singleton pattern for app-wide rate limiting)
let globalRateLimiter: LeakyBucketRateLimiter | null = null;
let getTransactionSemaphore: Semaphore | null = null;

/**
 * Get the global rate limiter instance
 *
 * Settings: 2 tokens max, 2/sec refill rate
 * This means: burst of 2, then sustained 2 req/sec
 */
export function getGlobalRateLimiter(): LeakyBucketRateLimiter {
  if (!globalRateLimiter) {
    globalRateLimiter = new LeakyBucketRateLimiter(2, 2);
    console.log('[RateLimiter] Initialized: 2 tokens, 2/sec refill');
  }
  return globalRateLimiter;
}

/**
 * Get the semaphore for getTransaction concurrency limiting
 *
 * Settings: 3 concurrent max
 * This prevents too many in-flight requests even if rate limiter allows burst
 */
export function getGetTransactionSemaphore(): Semaphore {
  if (!getTransactionSemaphore) {
    getTransactionSemaphore = new Semaphore(3);
    console.log('[Semaphore] Initialized: 3 permits');
  }
  return getTransactionSemaphore;
}

/**
 * Execute an operation with dual-layer rate limiting
 *
 * This wraps any async operation with:
 * 1. QPS control (wait for rate limiter token)
 * 2. Concurrency control (wait for semaphore permit)
 *
 * Use this for getTransaction() and other expensive RPC calls
 * that can cause 429 errors under concurrent load.
 *
 * @example
 * const tx = await withDualLayerLimiting(async () => {
 *   return await connection.getTransaction(signature);
 * });
 */
export async function withDualLayerLimiting<T>(operation: () => Promise<T>): Promise<T> {
  // Layer 1: QPS control
  await getGlobalRateLimiter().acquire();

  // Layer 2: Concurrency control
  const semaphore = getGetTransactionSemaphore();
  await semaphore.acquire();

  try {
    return await operation();
  } finally {
    semaphore.release();
  }
}

/**
 * Reset rate limiting state (useful for testing)
 */
export function resetRateLimiting(): void {
  globalRateLimiter = null;
  getTransactionSemaphore = null;
  console.log('[RateLimiter] Reset');
}
