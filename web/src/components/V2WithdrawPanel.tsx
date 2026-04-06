'use client';

/**
 * V2WithdrawPanel — inline JoinSplit withdrawal UI
 *
 * Sits below the "Private Balance (v2)" card in StatusTab.
 * - Denomination selector (only shows denoms ≤ current balance)
 * - Recipient address (defaults to connected wallet)
 * - Progress indicator during proof generation (~30-60s)
 */

import { useState } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { Button } from './ui';
import { V2Note } from '@/types/note';
import {
  V2_DENOMINATIONS,
  checkRootInHistory,
  executeV2Withdrawal,
} from '@/lib/v2-withdrawal';
import {
  executeV3Withdrawal,
  isNoteWithdrawable as isV3NoteWithdrawable,
} from '@/lib/v3-withdraw';
import { getPoolConfig, getDeployedPools } from '@/lib/pool-config';

// Relay relayer pubkey (from server config — devnet relay)
const RELAY_PUBKEY = new PublicKey('BEWNKrbVnLuWxPqVLSszwZpC6o86mC8RoSAWDaWwFivq');

/** Detect V3 note: denomination exists in V3 pool config. */
function isV3Note(note: V2Note): boolean {
  try {
    const denom = BigInt(note.amount);
    for (const { id } of getDeployedPools()) {
      const pc = getPoolConfig(id);
      if (BigInt(pc.denominationLamports) === denom) return true;
    }
    return false;
  } catch { return false; }
}

type Phase = 'idle' | 'checking' | 'proving' | 'submitting' | 'done' | 'error';

interface Props {
  v2Notes: V2Note[];
  encKey: CryptoKey;
  onWithdrawComplete?: (spentNoteId: string, changeNote: { amount: string; nullifier: string; secret: string } | null) => void;
}

export default function V2WithdrawPanel({ v2Notes, encKey, onWithdrawComplete }: Props) {
  const { publicKey } = useWallet();
  const { connection } = useConnection();

  const [open, setOpen] = useState(false);
  const [denomIdx, setDenomIdx] = useState(0);
  const [recipient, setRecipient] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);

  // Total unspent v2 balance
  const unspent = v2Notes.filter(n => n.status === 'unspent');
  const totalBalance = unspent.reduce((s, n) => s + BigInt(n.amount), 0n);

  // Available denominations (≤ total balance)
  const available = V2_DENOMINATIONS.filter(d => d.lamports <= totalBalance);

  const selectedDenom = available[denomIdx] ?? available[0];

  // Pick a note with sufficient balance
  function pickNote(denom: bigint): V2Note | null {
    return unspent.find(n => BigInt(n.amount) >= denom) ?? null;
  }

  const recipientAddr = recipient.trim() || publicKey?.toBase58() || '';
  const canSubmit = !!selectedDenom && !!recipientAddr && phase === 'idle';

  async function handleWithdraw() {
    if (!selectedDenom || !publicKey) return;
    const note = pickNote(selectedDenom.lamports);
    if (!note) {
      setError('No single note has sufficient balance for this denomination.');
      return;
    }

    setError(null);
    setPhase('checking');
    setProgress('Checking Merkle root validity…');

    try {
      let recipientPubkey: PublicKey;
      try {
        recipientPubkey = new PublicKey(recipientAddr);
      } catch {
        throw new Error('Invalid recipient address');
      }

      // Verify note has the data needed for proof generation
      if (note.leafIndex < 0) {
        throw new Error(
          'This note is missing its leaf index. Please disconnect and reconnect your wallet to trigger a full recovery scan.'
        );
      }
      if (!note.merkleRoot || note.pathElements.length === 0) {
        throw new Error(
          'This note is missing its Merkle path. Please disconnect and reconnect your wallet — ' +
          'the recovery scan will rebuild it automatically.'
        );
      }

      if (isV3Note(note)) {
        // V3 pre-flight: verify note is still withdrawable BEFORE proof gen
        setProgress('Verifying note validity…');
        const withdrawable = await isV3NoteWithdrawable(note, connection);
        if (!withdrawable) {
          throw new Error(
            'Note is no longer withdrawable (already spent or root expired). Please refresh your wallet.'
          );
        }

        setPhase('proving');
        const result = await executeV3Withdrawal({
          note,
          recipient: recipientPubkey,
          onProgress: msg => setProgress(msg),
        });

        setPhase('done');
        setLastSig(result.signature);
        setProgress('');
        onWithdrawComplete?.(note.id, null); // V3 has no change notes
      } else {
        // V2 JoinSplit withdrawal (legacy)
        const rootOk = await checkRootInHistory(note, connection);
        if (!rootOk) {
          throw new Error(
            'Merkle root has expired. Please disconnect and reconnect your wallet — ' +
            'the recovery scan will compute a fresh path automatically.'
          );
        }

        setPhase('proving');
        const result = await executeV2Withdrawal({
          note,
          withdrawalAmount: selectedDenom.lamports,
          recipient: recipientPubkey,
          relayerPubkey: RELAY_PUBKEY,
          encKey,
          onProgress: msg => setProgress(msg),
        });

        setPhase('done');
        setLastSig(result.signature);
        setProgress('');
        onWithdrawComplete?.(note.id, result.changeNote.amount === '0' ? null : result.changeNote);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
      setProgress('');
    }
  }

  function reset() {
    setPhase('idle');
    setError(null);
    setLastSig(null);
    setProgress('');
  }

  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="text-blue-300 border-blue-700/50 hover:bg-blue-900/20"
        disabled={available.length === 0}
      >
        Withdraw
      </Button>
    );
  }

  const isBusy = phase === 'checking' || phase === 'proving' || phase === 'submitting';

  return (
    <div className="mt-3 border-t border-blue-800/30 pt-3 space-y-3">
      {/* Denomination */}
      <div>
        <p className="text-xs text-blue-400 mb-1.5">Denomination</p>
        <div className="flex flex-wrap gap-1.5">
          {available.map((d, i) => (
            <button
              key={d.label}
              onClick={() => { setDenomIdx(i); reset(); }}
              disabled={isBusy}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors
                ${i === denomIdx
                  ? 'bg-blue-600 text-white'
                  : 'bg-blue-900/30 text-blue-300 hover:bg-blue-800/40'
                } disabled:opacity-50`}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      {/* Recipient */}
      <div>
        <p className="text-xs text-blue-400 mb-1.5">Recipient</p>
        <input
          type="text"
          placeholder={publicKey?.toBase58() ?? 'Solana address'}
          value={recipient}
          onChange={e => { setRecipient(e.target.value); reset(); }}
          disabled={isBusy}
          className="w-full bg-gray-800/60 border border-gray-600/50 rounded px-3 py-1.5 text-xs
                     text-white font-mono placeholder-gray-500 focus:outline-none
                     focus:border-blue-500 disabled:opacity-50"
        />
        <p className="text-xs text-gray-500 mt-1">
          Leave blank to withdraw to your connected wallet
        </p>
      </div>

      {/* Progress / Error / Success */}
      {isBusy && (
        <div className="flex items-center gap-2 text-xs text-blue-300">
          <span className="animate-spin inline-block w-3 h-3 border border-blue-400 border-t-transparent rounded-full" />
          {progress || 'Working…'}
        </div>
      )}

      {error && (
        <div className="text-xs text-red-400 bg-red-900/20 rounded p-2 break-all">{error}</div>
      )}

      {phase === 'done' && lastSig && (
        <div className="text-xs text-green-400 bg-green-900/20 rounded p-2">
          Withdrawn {selectedDenom?.label}!{' '}
          <a
            href={`https://explorer.solana.com/tx/${lastSig}?cluster=devnet`}
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-green-300"
          >
            View tx
          </a>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        {phase !== 'done' ? (
          <Button
            onClick={handleWithdraw}
            disabled={!canSubmit || isBusy}
            size="sm"
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            {isBusy ? 'Processing…' : `Withdraw ${selectedDenom?.label ?? ''}`}
          </Button>
        ) : (
          <Button onClick={reset} size="sm" variant="outline">
            Withdraw again
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => { setOpen(false); reset(); }}
          disabled={isBusy}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
