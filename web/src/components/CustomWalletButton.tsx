'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';

// Only show these wallets (case-insensitive match)
const ALLOWED_WALLETS = ['phantom', 'solflare'];

interface CustomWalletButtonProps {
  className?: string;
}

export default function CustomWalletButton({ className = '' }: CustomWalletButtonProps) {
  const { wallets, select, connect, disconnect, connected, publicKey, wallet } = useWallet();
  const [showModal, setShowModal] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [copied, setCopied] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // Filter wallets to only allowed ones
  const filteredWallets = wallets.filter(w =>
    ALLOWED_WALLETS.includes(w.adapter.name.toLowerCase())
  );

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        setShowModal(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Handle wallet selection
  const handleSelect = useCallback(async (walletName: string) => {
    try {
      select(walletName as any);
      setShowModal(false);
      // Connect happens automatically via autoConnect or the adapter
    } catch (err) {
      console.error('[CustomWalletButton] Failed to select wallet:', err);
    }
  }, [select]);

  // Truncate public key for display
  const truncatedAddress = publicKey
    ? `${publicKey.toBase58().slice(0, 4)}..${publicKey.toBase58().slice(-4)}`
    : '';

  // Connected state: show address with dropdown
  if (connected && publicKey) {
    return (
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setShowDropdown(!showDropdown)}
          className={`flex items-center gap-2 bg-zk-teal text-zk-bg rounded-xl h-10 px-4 font-medium text-sm hover:bg-zk-teal-light transition-colors ${className}`}
        >
          {wallet?.adapter.icon && (
            <img src={wallet.adapter.icon} alt="" className="w-5 h-5 rounded" />
          )}
          {truncatedAddress}
          <svg className={`w-3 h-3 transition-transform ${showDropdown ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {showDropdown && (
          <div className="absolute right-0 mt-2 w-48 rounded-xl bg-zk-surface border border-zk-border shadow-xl z-50 overflow-hidden">
            <div className="px-4 py-3 border-b border-zk-border">
              <div className="text-xs text-zk-text-muted">Connected</div>
              <div className="text-sm text-zk-text font-mono mt-0.5">{truncatedAddress}</div>
            </div>
            <button
              onClick={async () => {
                if (publicKey) {
                  await navigator.clipboard.writeText(publicKey.toBase58());
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }
              }}
              className="w-full px-4 py-3 text-left text-sm text-zk-text hover:bg-zk-surface-light transition-colors flex items-center gap-2"
            >
              {copied ? (
                <>
                  <svg className="w-4 h-4 text-zk-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Copied!
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  Copy Address
                </>
              )}
            </button>
            <button
              onClick={() => {
                disconnect();
                setShowDropdown(false);
              }}
              className="w-full px-4 py-3 text-left text-sm text-zk-danger hover:bg-zk-surface-light transition-colors flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  // Disconnected state: show connect button + modal
  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        className={`bg-zk-teal text-zk-bg rounded-xl h-10 px-6 font-medium text-sm hover:bg-zk-teal-light transition-colors ${className}`}
      >
        Connect Wallet
      </button>

      {/* Wallet Selection Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div ref={modalRef} className="w-full max-w-sm mx-4 rounded-2xl bg-zk-surface border border-zk-border shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-zk-border">
              <h3 className="text-lg font-semibold text-zk-text">Connect Wallet</h3>
              <button
                onClick={() => setShowModal(false)}
                className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-zk-surface-light transition-colors text-zk-text-muted hover:text-zk-text"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Wallet List */}
            <div className="p-4 space-y-2">
              {filteredWallets.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-zk-text-muted text-sm mb-3">No supported wallets detected</p>
                  <p className="text-zk-text-muted text-xs">
                    Install{' '}
                    <a href="https://phantom.app" target="_blank" rel="noopener noreferrer" className="text-zk-teal hover:underline">Phantom</a>
                    {' '}or{' '}
                    <a href="https://solflare.com" target="_blank" rel="noopener noreferrer" className="text-zk-teal hover:underline">Solflare</a>
                  </p>
                </div>
              ) : (
                filteredWallets.map((w) => (
                  <button
                    key={w.adapter.name}
                    onClick={() => handleSelect(w.adapter.name)}
                    className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-zk-surface-light transition-colors group"
                  >
                    {w.adapter.icon && (
                      <img src={w.adapter.icon} alt="" className="w-8 h-8 rounded-lg" />
                    )}
                    <div className="flex-1 text-left">
                      <div className="text-sm font-medium text-zk-text group-hover:text-zk-teal transition-colors">
                        {w.adapter.name}
                      </div>
                      <div className="text-xs text-zk-text-muted">
                        {w.readyState === 'Installed' ? 'Detected' : 'Not installed'}
                      </div>
                    </div>
                    {w.readyState === 'Installed' && (
                      <div className="w-2 h-2 rounded-full bg-zk-success" />
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
