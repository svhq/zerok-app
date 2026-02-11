/**
 * ZeroK Daemon Client
 *
 * Browser-compatible client for communicating with the ZeroK Daemon.
 * Used for fetching fresh Merkle paths when note's root has aged out of ring buffer.
 *
 * IMPORTANT: Uses /v1/witness/recover endpoint which returns FRESH root + witness.
 * Legacy endpoints (/path, /fastforward) return HISTORICAL roots which may have
 * aged out of the ACCEPTED_ROOT_SET, causing RootNotInRing errors.
 */

const DAEMON_URL = 'http://localhost:8788';

export interface MerklePathResponse {
  root: string;           // Current root (0x-prefixed)
  pathElements: string[]; // Sibling hashes (0x-prefixed)
  pathIndices: number[];  // Left/right path indices
  leafIndex: number;
}

/**
 * Get fresh Merkle path for a commitment using /v1/witness/recover endpoint.
 *
 * This endpoint correctly computes the current Merkle root and fresh sibling path
 * to that root, ensuring the returned root is in the ACCEPTED_ROOT_SET.
 *
 * Unlike legacy endpoints (/path, /fastforward) which return historical roots
 * from deposit time, this endpoint guarantees fresh data.
 */
export async function getMerklePath(poolId: string, commitment: string): Promise<MerklePathResponse> {
  const commitmentHex = commitment.startsWith('0x') ? commitment.slice(2) : commitment;

  // Use /v1/witness/recover POST endpoint for fresh root + witness
  const response = await fetch(`${DAEMON_URL}/v1/witness/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      poolId,
      commitment: commitmentHex,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Daemon getMerklePath (recover) failed (${response.status}): ${text}`);
  }

  const data = await response.json();

  // Transform /recover response format to MerklePathResponse format
  // /recover returns: { note: { rootAfter, siblings, ... }, metadata: { leafIndex, ... } }
  return {
    root: data.note.rootAfter,
    pathElements: data.note.siblings,
    pathIndices: data.metadata.pathIndices || [],
    leafIndex: data.metadata.leafIndex,
  };
}

/**
 * Check if daemon is healthy and running
 */
export async function checkDaemonHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${DAEMON_URL}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    const health = await response.json();
    return health.status === 'healthy' || health.status === 'degraded';
  } catch {
    return false;
  }
}
