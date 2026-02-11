/**
 * RPC Diagnostics
 *
 * Tracks and measures all RPC calls to diagnose performance issues.
 * Use during development to identify bottlenecks.
 */

interface RpcEntry {
  method: string;
  time: number;
  duration?: number;
  args?: string;
}

let rpcLog: RpcEntry[] = [];
let globalStartTime = Date.now();

/**
 * Log the start of an RPC call
 * @returns Call ID for pairing with logRpcEnd
 */
export function logRpcStart(method: string, args?: string): number {
  const id = rpcLog.length;
  const elapsed = Date.now() - globalStartTime;
  rpcLog.push({ method, time: Date.now(), args });
  console.log(`[RPC:${id}] +${elapsed}ms ${method}${args ? ` (${args})` : ''} started`);
  return id;
}

/**
 * Log the end of an RPC call
 */
export function logRpcEnd(id: number): void {
  const entry = rpcLog[id];
  if (entry) {
    entry.duration = Date.now() - entry.time;
    const elapsed = Date.now() - globalStartTime;
    console.log(`[RPC:${id}] +${elapsed}ms ${entry.method} completed in ${entry.duration}ms`);
  }
}

/**
 * Log a synchronous RPC-related event (like wallet signing)
 */
export function logRpcEvent(event: string): void {
  const elapsed = Date.now() - globalStartTime;
  console.log(`[RPC] +${elapsed}ms ${event}`);
}

/**
 * Print a summary report of all RPC calls
 */
export function printRpcReport(): void {
  const totalTime = Date.now() - globalStartTime;
  console.log('\n=== RPC CALL REPORT ===');
  console.log(`Total elapsed: ${totalTime}ms`);
  console.log(`Total calls: ${rpcLog.length}`);
  console.log('');

  rpcLog.forEach((entry, i) => {
    const status = entry.duration !== undefined
      ? `${entry.duration}ms`
      : 'pending';
    const args = entry.args ? ` (${entry.args})` : '';
    console.log(`  [${i}] ${entry.method}${args}: ${status}`);
  });

  // Calculate time spent in RPC vs elsewhere
  const rpcTime = rpcLog.reduce((sum, e) => sum + (e.duration || 0), 0);
  const otherTime = totalTime - rpcTime;
  console.log('');
  console.log(`RPC time: ${rpcTime}ms (${((rpcTime/totalTime)*100).toFixed(1)}%)`);
  console.log(`Other time: ${otherTime}ms (${((otherTime/totalTime)*100).toFixed(1)}%)`);
  console.log('========================\n');
}

/**
 * Reset the RPC log for a new operation
 */
export function resetRpcLog(): void {
  rpcLog = [];
  globalStartTime = Date.now();
  console.log('[RPC] Log reset, starting new measurement');
}

/**
 * Get the current RPC log (for programmatic access)
 */
export function getRpcLog(): RpcEntry[] {
  return [...rpcLog];
}
