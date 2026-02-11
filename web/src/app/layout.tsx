'use client';

import './globals.css';
import { useMemo, useState, useEffect } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { Commitment } from '@solana/web3.js';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-wallets';
import { PoolProvider } from '@/contexts/PoolContext';
import { getPrimaryEndpoint } from '@/lib/resilient-connection';
import { detectNetworkFromHostname } from '@/lib/network-config';

// Import wallet adapter CSS
import '@solana/wallet-adapter-react-ui/styles.css';

// Initialize MetaMask Solana support via Wallet Standard
// This registers MetaMask as a Wallet Standard wallet for Solana dApps
if (typeof window !== 'undefined') {
  import('@solflare-wallet/metamask-wallet-standard').then(({ initialize }) => {
    initialize();
  }).catch(() => {
    // MetaMask adapter not available, continue without it
  });
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // CRITICAL: Detect network client-side to avoid SSR mismatch
  // SSR cannot access hostname, so we use state to trigger re-render on client
  const [isClient, setIsClient] = useState(false);
  const [network, setNetwork] = useState<string>('');

  useEffect(() => {
    // Client-side network detection (single source of truth: hostname)
    const detected = detectNetworkFromHostname();
    setNetwork(detected);
    setIsClient(true);
    console.log('[Layout] Client-side network detected:', detected);
  }, []);

  // Get endpoint based on detected network (recalculates when network changes)
  const endpoint = useMemo(() => {
    if (!isClient) return ''; // Return empty during SSR
    return getPrimaryEndpoint();
  }, [isClient, network]);

  // Connection config - CRITICAL: disableRetryOnRateLimit prevents web3.js from
  // internally retrying 5x on 429 errors, which would multiply RPC load during rate limits.
  // Our executeWithRotation() handles retries with proper rate limiting instead.
  const connectionConfig = useMemo(() => ({
    commitment: 'confirmed' as Commitment,
    disableRetryOnRateLimit: true,
  }), []);

  // TESTNET FIX: Disable autoConnect on testnet to prevent Phantom from making
  // RPC calls at page load that burn through the rate limit before our app starts.
  // Testnet only has 1 public endpoint with aggressive rate limiting.
  // Users will need to click to connect on testnet, but the app will be reliable.
  const shouldAutoConnect = network !== 'testnet';

  // Phantom auto-registers via Wallet Standard protocol (no legacy adapter needed).
  // Solflare needs its legacy adapter (doesn't reliably register via Wallet Standard).
  // MetaMask registers via @solflare-wallet/metamask-wallet-standard (above).
  const wallets = useMemo(() => [new SolflareWalletAdapter()], []);

  // Don't render ConnectionProvider until client-side endpoint is determined
  // This prevents SSR from caching wrong network endpoint
  if (!isClient || !endpoint) {
    return (
      <html lang="en">
        <head>
          <title>zeroK - Private Transfers, Verified On-Chain</title>
          <meta name="description" content="Privacy protocol for crypto transfers using zero-knowledge proofs." />
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        </head>
        <body>
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
              <div style={{ marginBottom: '1rem', fontSize: '1.5rem' }}>Initializing...</div>
              <div style={{ color: '#888' }}>Detecting network configuration</div>
            </div>
          </div>
        </body>
      </html>
    );
  }

  return (
    <html lang="en">
      <head>
        <title>zeroK - Private Transfers, Verified On-Chain</title>
        <meta name="description" content="Privacy protocol for crypto transfers using zero-knowledge proofs." />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body>
        <PoolProvider>
          <ConnectionProvider endpoint={endpoint} config={connectionConfig}>
            <WalletProvider wallets={wallets} autoConnect={shouldAutoConnect}>
              <WalletModalProvider>
                {children}
              </WalletModalProvider>
            </WalletProvider>
          </ConnectionProvider>
        </PoolProvider>
      </body>
    </html>
  );
}
