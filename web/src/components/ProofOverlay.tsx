'use client';

import { useState, useEffect } from 'react';
import { ProgressBar } from './ui';

interface ProofOverlayProps {
  onCancel?: () => void;
  status?: string;  // Real-time status from withdrawal flow
}

const PROOF_MESSAGES = [
  'Constructing Merkle path...',
  'Blinding nullifier...',
  'Generating Groth16 proof...',
  'Finalizing cryptographic witness...',
  'Verifying proof constraints...',
];

export default function ProofOverlay({ onCancel, status }: ProofOverlayProps) {
  const [progress, setProgress] = useState(0);
  const [messageIndex, setMessageIndex] = useState(0);

  // Simulate progress (only when no real status provided)
  useEffect(() => {
    if (status) {
      // Estimate progress based on status keywords
      // Protocol-only flow: NO signing by user wallet
      if (status.includes('witness')) setProgress(20);
      else if (status.includes('proof') || status.includes('Generating')) setProgress(50);
      else if (status.includes('transaction') || status.includes('Building')) setProgress(70);
      else if (status.includes('Submitting') || status.includes('protocol')) setProgress(80);
      else if (status.includes('Sending')) setProgress(85);
      else if (status.includes('Confirming') || status.includes('waiting')) setProgress(90);
      else if (status.includes('complete') || status.includes('success')) setProgress(100);
      return;
    }

    const progressInterval = setInterval(() => {
      setProgress(prev => {
        if (prev >= 95) return prev;
        return prev + Math.random() * 5;
      });
    }, 500);

    return () => clearInterval(progressInterval);
  }, [status]);

  // Cycle messages (only when no real status provided)
  useEffect(() => {
    if (status) return; // Don't cycle if we have real status

    const messageInterval = setInterval(() => {
      setMessageIndex(prev => (prev + 1) % PROOF_MESSAGES.length);
    }, 3000);

    return () => clearInterval(messageInterval);
  }, [status]);

  const displayMessage = status || PROOF_MESSAGES[messageIndex];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 glass-overlay" />

      {/* Content */}
      <div className="relative glass-card p-8 max-w-md w-full mx-4 text-center">
        {/* Shield Icon */}
        <div className="mb-6">
          <div className="w-24 h-24 mx-auto relative">
            <svg
              className="w-full h-full shield-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="url(#shield-gradient)"
              strokeWidth="1.5"
            >
              <defs>
                <linearGradient id="shield-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#14B8A6" />
                  <stop offset="100%" stopColor="#2DD4BF" />
                </linearGradient>
              </defs>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
              />
            </svg>

            {/* Glow effect */}
            <div className="absolute inset-0 rounded-full bg-gradient-to-br from-zk-teal/30 to-zk-teal-light/30 blur-xl animate-pulse" />
          </div>
        </div>

        {/* Title */}
        <h2 className="text-xl font-semibold text-zk-text mb-2">Generating Proof</h2>

        {/* Status message */}
        <p className="text-zk-teal mb-6 h-6 transition-all duration-300">
          {displayMessage}
        </p>

        {/* Progress bar */}
        <div className="mb-4">
          <ProgressBar progress={progress} variant="gradient" />
          <div className="flex justify-between mt-2">
            <span className="text-zk-text-muted text-sm">Progress</span>
            <span className="text-zk-text text-sm">{Math.round(progress)}%</span>
          </div>
        </div>

        {/* Warning */}
        <div className="p-3 bg-zk-warning/10 border border-zk-warning/30 rounded-xl mb-6">
          <div className="flex items-center gap-2 justify-center">
            <svg className="w-4 h-4 text-zk-warning" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            <p className="text-zk-warning text-sm">
              Please keep this tab open
            </p>
          </div>
        </div>

        {/* Cancel button */}
        {onCancel && (
          <button
            onClick={onCancel}
            className="text-zk-text-muted text-sm hover:text-zk-text transition-colors"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
