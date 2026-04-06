'use client';

import { useState, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import dynamic from 'next/dynamic';
import CustomWalletButton from '@/components/CustomWalletButton';
import { Card } from '@/components/ui';
import { getCurrentNetwork } from '@/lib/network-config';

// Lazy-load PrivateCard — prevents the 13MB snarkjs bundle from blocking page load.
// The bundle downloads in the background while the user sees the connect screen.
const PrivateCard = dynamic(() => import('@/components/PrivateCard'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center py-12">
      <div className="animate-spin w-6 h-6 border-2 border-zk-teal border-t-transparent rounded-full" />
    </div>
  ),
});

export default function AppHome() {
  const { connected } = useWallet();
  const [networkName, setNetworkName] = useState<string>('');

  useEffect(() => {
    setNetworkName(getCurrentNetwork());
  }, []);

  return (
    <main className="min-h-screen">
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 glass-card border-0 border-b border-zk-border rounded-none">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl font-semibold text-zk-text">zero<span className="text-zk-teal font-bold">K</span></span>
          </div>
          <CustomWalletButton />
        </div>
      </header>

      {/* Main Content */}
      <div className="pt-24 pb-8 px-6">
        <div className="max-w-md mx-auto">
          {!connected ? (
            <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
              <div className="w-24 h-24 rounded-full bg-zk-surface flex items-center justify-center mb-6">
                <svg className="w-12 h-12 text-zk-teal" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <h2 className="text-2xl font-semibold text-zk-text mb-2">Send SOL Privately</h2>
              <p className="text-zk-text-muted mb-6 max-w-sm">
                Deposit any amount. Send in fixed denominations. Your wallet never signs withdrawals.
              </p>
              <CustomWalletButton className="!h-12 !px-8" />
            </div>
          ) : (
            <Card className="p-0 overflow-hidden">
              <PrivateCard />
            </Card>
          )}
        </div>
      </div>

      {/* Footer */}
      <footer className="fixed bottom-0 left-0 right-0 py-3 text-center text-zk-text-muted text-xs">
        <span className="opacity-60 capitalize">
          {(networkName === 'mainnet-beta' ? 'Mainnet' : networkName) || 'Loading...'} • Use at your own risk
        </span>
      </footer>
    </main>
  );
}
