/**
 * Network Configuration - Single Source of Truth
 *
 * ANTI-DRIFT ARCHITECTURE:
 * - Network is determined by hostname ONLY (client-side)
 * - SSR falls back to NEXT_PUBLIC_NETWORK env var
 * - NO generic env vars (NEXT_PUBLIC_RPC_PRIMARY is FORBIDDEN)
 * - All endpoints are hardcoded per-network or use network-scoped env vars
 *
 * ALLOWED ENV VARS (network-scoped only):
 * - NEXT_PUBLIC_RPC_PRIMARY_DEVNET
 * - NEXT_PUBLIC_RPC_PRIMARY_TESTNET
 * - NEXT_PUBLIC_RPC_PRIMARY_MAINNET
 * - NEXT_PUBLIC_NETWORK (SSR fallback only)
 *
 * FORBIDDEN ENV VARS (override all networks):
 * - NEXT_PUBLIC_RPC_PRIMARY
 * - NEXT_PUBLIC_PROTOCOL_URL
 * - NEXT_PUBLIC_DAEMON_URL
 *
 * See: ZEROK_SYSTEM_REPORT.md Section 1 for details
 */

export type NetworkId = 'devnet' | 'testnet' | 'mainnet-beta' | 'localnet';

interface NetworkEndpoints {
  rpc: string[];
  publicRpc: string;  // Free endpoint for wallet adapter (absorbs Phantom background polling)
  ws: string[];
  protocol: string;
}

/**
 * Network endpoint configurations.
 * These are the ONLY allowed endpoint sources.
 */
const NETWORK_ENDPOINTS: Record<NetworkId, NetworkEndpoints> = {
  devnet: {
    rpc: [
      // Paid endpoints for executeWithRotation (deposit/withdrawal operations).
      // Add your paid RPC providers here (Helius, Alchemy, Ankr, etc.).
      // The free public endpoint is used separately for wallet adapter polling.
      'https://api.devnet.solana.com',
    ],
    // Free public endpoint for ConnectionProvider (wallet adapter background polling).
    // Phantom makes ~40+ req/min per connected user for balance checks, tx history, etc.
    // Using a free endpoint here prevents wallet background noise from burning paid credits.
    // Our critical operations (deposit/withdraw) use executeWithRotation with paid endpoints.
    publicRpc: 'https://api.devnet.solana.com',
    ws: ['wss://api.devnet.solana.com'],
    protocol: '', // Configure your protocol service endpoint
  },
  testnet: {
    rpc: [
      'https://api.testnet.solana.com',
    ],
    publicRpc: 'https://api.testnet.solana.com',
    ws: ['wss://api.testnet.solana.com'],
    protocol: '', // Configure your protocol service endpoint
  },
  'mainnet-beta': {
    rpc: ['https://api.mainnet-beta.solana.com'],
    publicRpc: 'https://api.mainnet-beta.solana.com',
    ws: ['wss://api.mainnet-beta.solana.com'],
    protocol: '', // Configure your protocol service endpoint
  },
  localnet: {
    rpc: ['http://localhost:8899'],
    publicRpc: 'http://localhost:8899',
    ws: ['ws://localhost:8900'],
    protocol: 'http://localhost:8789',
  },
};

/**
 * Detect network from hostname (client-side only).
 * This is the ONLY source of truth for network selection in the browser.
 */
export function detectNetworkFromHostname(): NetworkId {
  if (typeof window === 'undefined') {
    // SSR fallback - use env var (cannot detect hostname on server)
    const envNetwork = process.env.NEXT_PUBLIC_NETWORK;
    if (envNetwork && isValidNetwork(envNetwork)) {
      return envNetwork as NetworkId;
    }
    return 'devnet';
  }

  const hostname = window.location.hostname;

  // Explicit hostname mapping (single source of truth)
  // Matches both subdomains (devnet.zerok.app) and Vercel previews (devnet-zerok.vercel.app)
  if (hostname.startsWith('devnet')) return 'devnet';
  if (hostname.startsWith('testnet')) return 'testnet';
  // Landing page uses devnet until mainnet launches
  if (hostname === 'zerok.app' || hostname === 'www.zerok.app') return 'devnet';
  if (hostname === 'localhost' || hostname === '127.0.0.1') return 'localnet';

  // Unknown hostname - fail safe to devnet with warning
  console.warn(`[NetworkConfig] Unknown hostname: ${hostname}, defaulting to devnet`);
  return 'devnet';
}

function isValidNetwork(network: string): network is NetworkId {
  return ['devnet', 'testnet', 'mainnet-beta', 'localnet'].includes(network);
}

/**
 * Get network-scoped env var or undefined.
 * Only network-scoped env vars are allowed (NEXT_PUBLIC_*_<NETWORK>).
 */
function getNetworkEnvVar(prefix: string, network: NetworkId): string | undefined {
  // Convert network to env var suffix: devnet -> DEVNET, mainnet-beta -> MAINNET_BETA
  const suffix = network.toUpperCase().replace('-', '_');
  const varName = `${prefix}_${suffix}`;

  // Access via process.env (Next.js inlines NEXT_PUBLIC_* at build time)
  if (varName === 'NEXT_PUBLIC_RPC_PRIMARY_DEVNET') {
    return process.env.NEXT_PUBLIC_RPC_PRIMARY_DEVNET;
  }
  if (varName === 'NEXT_PUBLIC_RPC_PRIMARY_TESTNET') {
    return process.env.NEXT_PUBLIC_RPC_PRIMARY_TESTNET;
  }
  if (varName === 'NEXT_PUBLIC_RPC_PRIMARY_MAINNET_BETA') {
    return process.env.NEXT_PUBLIC_RPC_PRIMARY_MAINNET;
  }

  return undefined;
}

/**
 * Get RPC endpoints for the detected network.
 * Returns primary + fallbacks in order of preference.
 */
export function getRpcEndpoints(): string[] {
  const network = detectNetworkFromHostname();
  const config = NETWORK_ENDPOINTS[network];

  // Check network-scoped env var first (e.g., NEXT_PUBLIC_RPC_PRIMARY_DEVNET)
  const envPrimary = getNetworkEnvVar('NEXT_PUBLIC_RPC_PRIMARY', network);

  const endpoints: string[] = [];
  if (envPrimary) endpoints.push(envPrimary);
  endpoints.push(...config.rpc);

  // Deduplicate while preserving order
  return [...new Set(endpoints)];
}

/**
 * Get the free public RPC endpoint for wallet adapter ConnectionProvider.
 *
 * WHY: Phantom (and other wallets) make ~40+ background RPC calls per minute per
 * connected user (getBalance, getSignaturesForAddress, etc.). These go through
 * the ConnectionProvider endpoint. Using a paid endpoint here means every idle
 * connected wallet burns paid RPC credits.
 *
 * ARCHITECTURE: Two-layer RPC strategy:
 * - ConnectionProvider (this function): Free public endpoint → absorbs wallet background noise
 * - executeWithRotation (getRpcEndpoints): Paid endpoints → deposit/withdrawal operations
 */
export function getPublicRpcEndpoint(): string {
  const network = detectNetworkFromHostname();
  return NETWORK_ENDPOINTS[network].publicRpc;
}

/**
 * Get WebSocket endpoints for the detected network.
 */
export function getWsEndpoints(): string[] {
  const network = detectNetworkFromHostname();
  const config = NETWORK_ENDPOINTS[network];

  // Convert primary RPC to WSS if available
  const rpcEndpoints = getRpcEndpoints();
  const wsEndpoints: string[] = [];

  // Try to convert primary HTTP endpoint to WS
  const primaryRpc = rpcEndpoints[0];
  if (primaryRpc) {
    const primaryWs = primaryRpc.replace('https://', 'wss://').replace('http://', 'ws://');
    wsEndpoints.push(primaryWs);
  }

  // Add hardcoded WS fallbacks
  wsEndpoints.push(...config.ws);

  return [...new Set(wsEndpoints)];
}

/**
 * Get protocol service endpoint for the detected network.
 */
export function getProtocolEndpoint(): string {
  const network = detectNetworkFromHostname();
  const endpoint = NETWORK_ENDPOINTS[network].protocol;

  if (!endpoint) {
    throw new Error(`No protocol service endpoint configured for network: ${network}`);
  }

  return endpoint;
}

/**
 * Get current network (for logging/display).
 */
export function getCurrentNetwork(): NetworkId {
  return detectNetworkFromHostname();
}

/**
 * Validate that configured network matches detected network.
 * Call this after SSR hydration to ensure consistency.
 */
export function validateNetworkConsistency(configuredNetwork: string): void {
  const detected = detectNetworkFromHostname();
  if (configuredNetwork !== detected) {
    console.error(
      `[NetworkConfig] NETWORK MISMATCH: configured=${configuredNetwork}, detected=${detected}. ` +
        `This may cause wallet connection issues. Check env vars and hostname.`
    );
  }
}
