'use client';

import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import DepositCard from '@/components/DepositCard';
import StatusTab from '@/components/StatusTab';
import RecentNotes from '@/components/RecentNotes';
import HowToGuide from '@/components/HowToGuide';
import { Note } from '@/types/note';
import { usePool } from '@/contexts/PoolContext';
import { loadBackupNotes, clearBackupNotes } from '@/lib/note-storage';
import { isPoolDeployed } from '@/lib/pool-config';
import { getCurrentNetwork } from '@/lib/network-config';

type Tab = 'deposit' | 'status';

export default function AppHome() {
  const [activeTab, setActiveTab] = useState<Tab>('deposit');
  const { connected } = useWallet();
  const { isLoading: poolsLoading } = usePool();
  const [recentNotes, setRecentNotes] = useState<Note[]>([]);
  const [recoveredNotes, setRecoveredNotes] = useState(false);
  const [autoDownloadedIds, setAutoDownloadedIds] = useState<Set<string>>(new Set());
  const [networkName, setNetworkName] = useState<string>('');

  // Detect network on client-side
  useEffect(() => {
    setNetworkName(getCurrentNetwork());
  }, []);

  // Load backed-up notes from localStorage on mount (after pools are loaded)
  useEffect(() => {
    if (poolsLoading) return; // Wait for pools to be initialized

    const backupNotes = loadBackupNotes();
    if (backupNotes.length > 0) {
      // Filter out notes with unknown pool IDs (from old deployments)
      const validNotes = backupNotes.filter(note => {
        const isValid = isPoolDeployed(note.poolId);
        if (!isValid) {
          console.warn('[page] Skipping note with unknown pool:', note.poolId);
        }
        return isValid;
      });

      if (validNotes.length > 0) {
        setRecentNotes(validNotes);
        setRecoveredNotes(true);
        console.log('[page] Recovered', validNotes.length, 'notes from previous session');
        if (validNotes.length < backupNotes.length) {
          console.warn('[page] Filtered out', backupNotes.length - validNotes.length, 'notes with unknown pools');
        }
      }
    }
  }, [poolsLoading]);

  // Handle new notes created from deposit
  const handleNotesCreated = useCallback((notes: Note[]) => {
    setRecentNotes(prev => [...notes, ...prev]);
    setRecoveredNotes(false); // New notes added, clear recovery message
    // Mark these notes as auto-downloaded (they were downloaded during deposit)
    setAutoDownloadedIds(prev => new Set([...prev, ...notes.map(n => n.id)]));
  }, []);

  // Clear recent notes and localStorage backup
  const handleClearRecentNotes = useCallback(() => {
    setRecentNotes([]);
    clearBackupNotes();
    setRecoveredNotes(false);
    setAutoDownloadedIds(new Set());
  }, []);

  // Warn before leaving if there are unsaved notes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (recentNotes.length > 0) {
        e.preventDefault();
        e.returnValue = 'You have unsaved notes. Are you sure you want to leave?';
        return e.returnValue;
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [recentNotes.length]);

  return (
    <main className="min-h-screen">
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 glass-card border-0 border-b border-zk-border rounded-none">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          {/* Logo */}
          <div className="flex items-center gap-2">
            <span className="text-xl font-semibold text-zk-text">zero<span className="text-zk-teal font-bold">K</span></span>
          </div>

          {/* Tab Navigation */}
          <nav className="flex gap-1 bg-zk-bg/50 rounded-lg p-1">
            <button
              onClick={() => setActiveTab('deposit')}
              className={`px-6 py-2 rounded-md text-sm font-medium transition-all ${
                activeTab === 'deposit'
                  ? 'bg-zk-teal/20 text-zk-text'
                  : 'text-zk-text-muted hover:text-zk-text'
              }`}
            >
              Deposit
            </button>
            <button
              onClick={() => setActiveTab('status')}
              className={`px-6 py-2 rounded-md text-sm font-medium transition-all ${
                activeTab === 'status'
                  ? 'bg-zk-teal/20 text-zk-text'
                  : 'text-zk-text-muted hover:text-zk-text'
              }`}
            >
              Status
            </button>
          </nav>

          {/* Wallet Button */}
          <WalletMultiButton className="!bg-zk-teal !text-zk-bg !rounded-xl !h-10 !font-medium" />
        </div>
      </header>

      {/* Main Content */}
      <div className="pt-24 pb-8 px-6">
        <div className="max-w-6xl mx-auto relative">
          {/* How To Guide - positioned in left margin */}
          {connected && (
            <HowToGuide mode={activeTab === 'deposit' ? 'deposit' : 'withdraw'} />
          )}

          {!connected ? (
            // Not connected state
            <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
              <div className="w-24 h-24 rounded-full bg-zk-surface flex items-center justify-center mb-6">
                <svg className="w-12 h-12 text-zk-teal" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <h2 className="text-2xl font-semibold text-zk-text mb-2">Connect Your Wallet</h2>
              <p className="text-zk-text-muted mb-6 max-w-md">
                Connect your Solana wallet to deposit SOL privately or withdraw from your notes.
              </p>
              <WalletMultiButton className="!bg-zk-teal !text-zk-bg !rounded-xl !h-12 !px-8 !font-medium" />
            </div>
          ) : (
            // Connected state - show active tab
            <>
              {activeTab === 'deposit' && (
                <>
                  <DepositCard onNotesCreated={handleNotesCreated} />
                  <RecentNotes
                    notes={recentNotes}
                    onClear={handleClearRecentNotes}
                    isRecovered={recoveredNotes}
                    autoDownloadedIds={autoDownloadedIds}
                  />
                </>
              )}
              {activeTab === 'status' && <StatusTab />}
            </>
          )}
        </div>
      </div>

      {/* Footer */}
      <footer className="fixed bottom-0 left-0 right-0 py-3 text-center text-zk-text-muted text-xs">
        <span className="opacity-60 capitalize">{networkName || 'Loading...'} • Use at your own risk</span>
      </footer>
    </main>
  );
}
