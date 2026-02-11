'use client';

import { createContext, useContext, useState, ReactNode, useCallback, useMemo, useEffect } from 'react';
import { PoolConfig } from '@/types/note';
import {
  POOLS,
  getPoolConfig,
  POOL_OPTIONS,
  isPoolDeployed,
  initializePoolConfig,
  isPoolConfigInitialized,
  getDefaultPoolId,
  getCurrentNetwork,
} from '@/lib/pool-config';
import { detectNetworkFromHostname } from '@/lib/network-config';

// =============================================================================
// POOL CONTEXT
// =============================================================================
// Provides global pool selection state to all components.
// Components can use the usePool() hook to access the selected pool config.
// =============================================================================

interface PoolContextValue {
  // Currently selected pool ID
  selectedPoolId: string;
  // Full config for the selected pool
  poolConfig: PoolConfig | null;
  // All pool options for UI display
  poolOptions: typeof POOL_OPTIONS;
  // Only deployed (usable) pools
  deployedPools: typeof POOL_OPTIONS;
  // Function to change selected pool
  selectPool: (poolId: string) => void;
  // Check if selected pool is deployed
  isDeployed: boolean;
  // Loading state
  isLoading: boolean;
  // Error state
  error: string | null;
}

const PoolContext = createContext<PoolContextValue | undefined>(undefined);

interface PoolProviderProps {
  children: ReactNode;
}

export function PoolProvider({ children }: PoolProviderProps) {
  const [selectedPoolId, setSelectedPoolId] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  // Initialize pool config on mount
  // ANTI-DRIFT: Use hostname detection, NOT generic env vars
  // See ZEROK_SYSTEM_REPORT.md Section 1.2 and 1.3
  useEffect(() => {
    const init = async () => {
      try {
        // CRITICAL: Use hostname detection for network (single source of truth)
        const network = detectNetworkFromHostname();
        console.log('[PoolContext] Initializing pool config for:', network);
        await initializePoolConfig(network);
        const defaultPool = getDefaultPoolId();
        setSelectedPoolId(defaultPool);
        setInitialized(true);
        setIsLoading(false);
        console.log('[PoolContext] Pool config initialized, default pool:', defaultPool);
      } catch (err) {
        console.error('[PoolContext] Failed to initialize pool config:', err);
        setError(err instanceof Error ? err.message : 'Failed to load pool config');
        setIsLoading(false);
      }
    };

    // ANTI-DRIFT: Always verify network match (Section 1.3)
    // SSR may have initialized with wrong network, client must re-init
    const detectedNetwork = detectNetworkFromHostname();
    const configuredNetwork = isPoolConfigInitialized() ? getCurrentNetwork() : null;

    if (!isPoolConfigInitialized() || configuredNetwork !== detectedNetwork) {
      if (configuredNetwork && configuredNetwork !== detectedNetwork) {
        console.warn(
          `[PoolContext] Network mismatch: configured=${configuredNetwork}, detected=${detectedNetwork}. Re-initializing.`
        );
      }
      init();
    } else {
      setSelectedPoolId(getDefaultPoolId());
      setInitialized(true);
      setIsLoading(false);
    }
  }, []);

  const selectPool = useCallback((poolId: string) => {
    // Only allow switching to known pools
    if (isPoolConfigInitialized() && POOLS[poolId]) {
      setSelectedPoolId(poolId);
    } else {
      console.warn(`Unknown pool ID: ${poolId}`);
    }
  }, []);

  const value = useMemo<PoolContextValue>(() => {
    if (!initialized || !selectedPoolId) {
      return {
        selectedPoolId: '',
        poolConfig: null,
        poolOptions: [],
        deployedPools: [],
        selectPool,
        isDeployed: false,
        isLoading,
        error,
      };
    }

    return {
      selectedPoolId,
      poolConfig: getPoolConfig(selectedPoolId),
      poolOptions: POOL_OPTIONS,
      deployedPools: POOL_OPTIONS.filter(p => p.deployed),
      selectPool,
      isDeployed: isPoolDeployed(selectedPoolId),
      isLoading,
      error,
    };
  }, [selectedPoolId, selectPool, initialized, isLoading, error]);

  // Show loading state
  if (isLoading) {
    return (
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100vh',
        backgroundColor: '#0a0a0a',
        color: '#fff',
        fontFamily: 'system-ui, sans-serif'
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ marginBottom: '1rem', fontSize: '1.5rem' }}>Loading pool configuration...</div>
          <div style={{ color: '#888' }}>Connecting to {typeof window !== 'undefined' ? detectNetworkFromHostname() : 'network'}</div>
        </div>
      </div>
    );
  }

  // Show error state
  if (error) {
    return (
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100vh',
        backgroundColor: '#0a0a0a',
        color: '#ff4444',
        fontFamily: 'system-ui, sans-serif'
      }}>
        <div style={{ textAlign: 'center', maxWidth: '600px', padding: '2rem' }}>
          <div style={{ marginBottom: '1rem', fontSize: '1.5rem' }}>Failed to load pool configuration</div>
          <div style={{ color: '#888', marginBottom: '1rem' }}>{error}</div>
          <div style={{ color: '#666', fontSize: '0.875rem' }}>
            Please ensure the config file exists at /config/{typeof window !== 'undefined' ? detectNetworkFromHostname() : 'network'}.json
          </div>
        </div>
      </div>
    );
  }

  return (
    <PoolContext.Provider value={value}>
      {children}
    </PoolContext.Provider>
  );
}

/**
 * Hook to access pool context.
 * Must be used within a PoolProvider.
 *
 * @example
 * const { poolConfig, selectPool } = usePool();
 * // Use poolConfig.denominationLamports, poolConfig.programId, etc.
 */
export function usePool(): PoolContextValue {
  const context = useContext(PoolContext);
  if (!context) {
    throw new Error('usePool must be used within a PoolProvider');
  }
  return context;
}
