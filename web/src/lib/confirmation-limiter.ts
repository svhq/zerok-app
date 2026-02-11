/**
 * Confirmation Limiter
 *
 * Ported from CLI: /zerok/cli/utils/confirmation-limiter.js
 *
 * Provides semaphore-based concurrency control for transaction confirmations.
 * Prevents browser resource exhaustion when handling many transactions.
 *
 * The CLI uses this exact pattern to handle 30-50 operations reliably.
 */

/**
 * Simple semaphore implementation for concurrency control
 */
class Semaphore {
  private permits: number;
  private waiting: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    if (this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      next();
    } else {
      this.permits++;
    }
  }

  get available(): number {
    return this.permits;
  }
}

// Max 1 concurrent confirmation for devnet (prevents self-DDOS)
// Devnet rate limits are strict; sequential confirmation is more reliable
// CLI used 10 for mainnet, but devnet needs conservative approach
const confirmationLimiter = new Semaphore(1);

/**
 * Execute a function with confirmation concurrency limiting
 *
 * Prevents too many concurrent confirmations from overwhelming the browser.
 *
 * @param fn - Async function to execute
 * @returns Result of the function
 */
export async function withConfirmationLimit<T>(fn: () => Promise<T>): Promise<T> {
  await confirmationLimiter.acquire();
  try {
    return await fn();
  } finally {
    confirmationLimiter.release();
  }
}

/**
 * Execute multiple operations with controlled concurrency
 *
 * Unlike Promise.all() which runs everything in parallel, this limits
 * concurrency to prevent resource exhaustion.
 *
 * @param items - Items to process
 * @param operation - Async operation to run on each item
 * @param maxConcurrent - Maximum concurrent operations (default: 5)
 */
export async function withControlledConcurrency<T, R>(
  items: T[],
  operation: (item: T, index: number) => Promise<R>,
  maxConcurrent: number = 5
): Promise<R[]> {
  const results: R[] = [];
  const semaphore = new Semaphore(maxConcurrent);
  const errors: { index: number; error: Error }[] = [];

  const promises = items.map(async (item, index) => {
    await semaphore.acquire();
    try {
      const result = await operation(item, index);
      results[index] = result;
    } catch (err) {
      errors.push({ index, error: err instanceof Error ? err : new Error(String(err)) });
    } finally {
      semaphore.release();
    }
  });

  await Promise.all(promises);

  if (errors.length > 0) {
    console.error(`[Limiter] ${errors.length} operations failed:`, errors);
    throw new Error(
      `${errors.length} operations failed: ${errors.map((e) => `[${e.index}] ${e.error.message}`).join(', ')}`
    );
  }

  return results;
}

/**
 * Get current available permits (for diagnostics)
 */
export function getAvailablePermits(): number {
  return confirmationLimiter.available;
}
