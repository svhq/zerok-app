'use client';

import { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { SystemProgram, Transaction } from '@solana/web3.js';
import { executeWithRotation } from '@/lib/resilient-connection';
import { Button, Card } from './ui';

/**
 * Diagnostic component to test wallet signing speed.
 *
 * Purpose: Isolate whether the 45-second delay is:
 * 1. Wallet/environment issue (trivial tx is also slow)
 * 2. Our transaction triggering wallet "deep inspection" (trivial tx is fast)
 *
 * Per consultant: "If trivial tx takes 30-45s → it's almost certainly Phantom/network/environment"
 */
export default function DiagnosticTest() {
  const { publicKey, signTransaction } = useWallet();
  const [result, setResult] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const runTest = async () => {
    if (!publicKey || !signTransaction) return;

    setIsRunning(true);
    setResult('Starting test...');

    try {
      // Get blockhash using resilient connection
      const blockhashStart = performance.now();
      const { blockhash } = await executeWithRotation(
        (conn) => conn.getLatestBlockhash('confirmed')
      );
      const blockhashTime = performance.now() - blockhashStart;
      setResult(`Got blockhash in ${blockhashTime.toFixed(0)}ms, preparing trivial transaction...`);

      // Build trivial transaction (0 lamports to self)
      const transaction = new Transaction();
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: publicKey,
          lamports: 0,
        })
      );
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = publicKey;

      // Time the signing - this is what we're measuring
      const signStart = performance.now();
      setResult('Calling signTransaction... (timing wallet preview/simulation)');
      console.log('[DIAGNOSTIC] Calling signTransaction at', new Date().toISOString());

      await signTransaction(transaction);
      const signTime = performance.now() - signStart;

      console.log(`[DIAGNOSTIC] Trivial tx signed in ${signTime.toFixed(0)}ms`);

      // Interpret results based on consultant guidance
      let interpretation = '';
      let emoji = '';
      if (signTime < 5000) {
        emoji = '✅';
        interpretation = 'FAST - Wallet is working normally.\n' +
          'This confirms our ZK transaction triggers the slow "deep inspection" path.\n' +
          '→ Next: Add ComputeBudget instructions to reduce wallet guesswork.';
      } else if (signTime < 15000) {
        emoji = '⚠️';
        interpretation = 'MODERATE - Some wallet delay, but not extreme.\n' +
          'Wallet may be doing extra work but not timing out.\n' +
          '→ Next: Try with Backpack wallet, check Phantom extension network calls.';
      } else {
        emoji = '❌';
        interpretation = 'SLOW - Environment/wallet issue detected!\n' +
          'Even a trivial transaction is slow, so the problem is NOT our transaction.\n' +
          '→ Next: Check Phantom extension network (chrome://extensions),\n' +
          '   try different network (mobile hotspot), or try Backpack wallet.';
      }

      setResult(
        `${emoji} Signed in ${(signTime / 1000).toFixed(1)} seconds\n\n` +
        `Interpretation:\n${interpretation}\n\n` +
        `Blockhash fetch: ${blockhashTime.toFixed(0)}ms\n` +
        `Wallet signing: ${signTime.toFixed(0)}ms`
      );

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error('[DIAGNOSTIC] Error:', err);
      setResult(`Error: ${errMsg}\n\nThis might indicate a wallet or network issue.`);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <Card className="mb-4">
      <div className="p-4">
        <h3 className="text-white text-lg font-semibold mb-2">Wallet Speed Diagnostic</h3>
        <p className="text-sol-gray text-sm mb-4">
          Tests a trivial transaction (0 SOL to self) to isolate if wallet signing
          itself is slow (environment issue) or if our ZK transaction triggers a slow path.
        </p>

        <Button
          onClick={runTest}
          disabled={!publicKey || isRunning}
          loading={isRunning}
          variant="outline"
          size="md"
        >
          {isRunning ? 'Testing...' : 'Test Trivial Transaction'}
        </Button>

        {!publicKey && (
          <p className="text-sol-gray text-xs mt-2">Connect wallet to run test</p>
        )}

        {result && (
          <pre className="mt-4 p-3 bg-sol-dark rounded text-sm text-white whitespace-pre-wrap overflow-x-auto">
            {result}
          </pre>
        )}
      </div>
    </Card>
  );
}
