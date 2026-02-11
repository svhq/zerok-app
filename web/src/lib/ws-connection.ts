/**
 * WebSocket Connection Manager
 *
 * Ported from CLI: cli/utils/resilient-rpc.js (connection pooling pattern)
 *
 * Provides a single reusable WebSocket connection for all confirmations.
 * This prevents connection multiplication that causes self-DoS on RPC endpoints.
 *
 * Key features:
 * - Single connection per endpoint (no multiplication)
 * - Multiplexed subscriptions share one WebSocket socket
 * - Automatic reconnection on disconnect
 * - Endpoint rotation on failure
 *
 * ANTI-DRIFT: Network detection from hostname, NOT generic env vars.
 * See: network-config.ts for endpoint configuration.
 */

import { Connection, Commitment } from '@solana/web3.js';
import {
  getRpcEndpoints as getNetworkRpcEndpoints,
  getWsEndpoints as getNetworkWsEndpoints,
  getCurrentNetwork,
} from './network-config';

/**
 * WebSocket endpoints for current network
 * Uses hostname-based network detection (single source of truth)
 */
function getWsEndpoints(): string[] {
  const endpoints = getNetworkWsEndpoints();
  console.log(`[WS] Network: ${getCurrentNetwork()}, WS endpoints: ${endpoints.length}`);
  return endpoints;
}

/**
 * HTTP endpoints for fallback (when all WS fail)
 * Uses hostname-based network detection (single source of truth)
 */
function getHttpEndpoints(): string[] {
  return getNetworkRpcEndpoints();
}

// Connection state
interface WsConnectionState {
  connection: Connection | null;
  wsEndpoint: string;
  httpEndpoint: string;
  endpointIndex: number;
  isConnecting: boolean;
  lastError: Error | null;
}

const state: WsConnectionState = {
  connection: null,
  wsEndpoint: '',
  httpEndpoint: '',
  endpointIndex: 0,
  isConnecting: false,
  lastError: null,
};

/**
 * Get or create a single reusable WebSocket connection
 *
 * This connection is shared across all confirmation subscriptions.
 * Multiplexed subscriptions share one WebSocket socket, reducing
 * connection overhead and preventing self-DoS on RPC endpoints.
 *
 * @param commitment - Commitment level (default: 'confirmed')
 * @returns Connection with WebSocket support
 */
export function getWsConnection(commitment: Commitment = 'confirmed'): Connection {
  const wsEndpoints = getWsEndpoints();
  const httpEndpoints = getHttpEndpoints();

  // Reuse existing connection if available
  if (state.connection) {
    return state.connection;
  }

  // Create new connection with explicit WebSocket endpoint
  const wsEndpoint = wsEndpoints[state.endpointIndex];
  const httpEndpoint = httpEndpoints[state.endpointIndex];

  console.log(`[WS] Creating connection to ${wsEndpoint.substring(0, 50)}...`);

  state.connection = new Connection(httpEndpoint, {
    commitment,
    wsEndpoint,
  });

  state.wsEndpoint = wsEndpoint;
  state.httpEndpoint = httpEndpoint;

  return state.connection;
}

/**
 * Rotate to next WebSocket endpoint after failure
 *
 * Called when current endpoint fails (429, timeout, disconnect).
 * Returns true if there are more endpoints to try, false if exhausted.
 */
export function rotateWsEndpoint(): boolean {
  const wsEndpoints = getWsEndpoints();

  // Clear current connection
  state.connection = null;

  // Try next endpoint
  state.endpointIndex = (state.endpointIndex + 1) % wsEndpoints.length;

  // Return false if we've tried all endpoints
  if (state.endpointIndex === 0) {
    console.log('[WS] All endpoints exhausted, will reset and retry');
    return false;
  }

  console.log(`[WS] Rotating to endpoint ${state.endpointIndex + 1}/${wsEndpoints.length}`);
  return true;
}

/**
 * Reset connection state (after all endpoints exhausted or manual reset)
 */
export function resetWsConnection(): void {
  state.connection = null;
  state.endpointIndex = 0;
  state.lastError = null;
  console.log('[WS] Connection state reset');
}

/**
 * Get current connection state (for diagnostics)
 */
export function getWsConnectionState(): {
  isConnected: boolean;
  endpoint: string;
  endpointIndex: number;
  totalEndpoints: number;
} {
  const wsEndpoints = getWsEndpoints();
  return {
    isConnected: state.connection !== null,
    endpoint: state.wsEndpoint,
    endpointIndex: state.endpointIndex,
    totalEndpoints: wsEndpoints.length,
  };
}

/**
 * Get primary HTTP endpoint (for operations that don't need WS)
 */
export function getPrimaryHttpEndpoint(): string {
  const httpEndpoints = getHttpEndpoints();
  return httpEndpoints[0];
}

/**
 * Get all HTTP endpoints (for rotation)
 */
export function getAllHttpEndpoints(): string[] {
  return getHttpEndpoints();
}
