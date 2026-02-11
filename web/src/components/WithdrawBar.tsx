'use client';

import { useState, useCallback } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { Button } from './ui';
import { Note } from '@/types/note';
import { formatSol } from '@/lib/pool-config';
import { prepareWithdrawalForProtocol, ProtocolSubmissionData } from '@/lib/withdrawal';
import { submitWithdrawalToProtocol, checkProtocolHealth } from '@/lib/protocol-client';
import ProofOverlay from './ProofOverlay';

interface WithdrawBarProps {
  selectedNotes: Note[];
  selectedBalance: bigint;
  onClear: () => void;
}

export default function WithdrawBar({ selectedNotes, selectedBalance, onClear }: WithdrawBarProps) {
  // CRITICAL PRIVACY: We only use publicKey for default recipient.
  // User wallet NEVER signs withdrawal transactions.
  const { publicKey } = useWallet();
  const { connection } = useConnection();

  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const [showProofOverlay, setShowProofOverlay] = useState(false);
  const [proofProgress, setProofProgress] = useState<string>('Initializing...');
  const [recipientAddress, setRecipientAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [successTxs, setSuccessTxs] = useState<string[]>([]);

  // Default recipient to connected wallet
  const effectiveRecipient = recipientAddress || publicKey?.toBase58() || '';

  const handleWithdraw = useCallback(async () => {
    // CRITICAL PRIVACY: User wallet is ONLY used for default recipient address.
    // All withdrawals are signed and submitted by the PROTOCOL SERVICE, not the user.
    // This preserves anonymity by not linking the user's wallet to the withdrawal.

    // Validate recipient address
    let recipient: PublicKey;
    try {
      recipient = new PublicKey(effectiveRecipient);
    } catch {
      setError('Invalid recipient address');
      return;
    }

    // Validate notes have required data for withdrawal
    const notesWithMissingData = selectedNotes.filter(
      n => !n.rootAfter || n.siblings.length === 0 || n.leafIndex < 0
    );
    if (notesWithMissingData.length > 0) {
      setError(`${notesWithMissingData.length} note(s) missing Merkle proof data. These notes may have been created before the update. Please deposit new notes.`);
      return;
    }

    setError(null);
    setIsWithdrawing(true);
    setShowProofOverlay(true);
    setProofProgress('Initializing...');
    setSuccessTxs([]);

    const txSignatures: string[] = [];

    try {
      // ═══════════════════════════════════════════════════════════════════════
      // PROTOCOL-ONLY WITHDRAWAL FLOW (Privacy-Preserving)
      //
      // Phase 1: Check protocol health and get protocol address
      // Phase 2: Generate proofs and prepare instructions (no signing!)
      // Phase 3: Submit each to protocol (protocol signs and submits)
      //
      // CRITICAL: User wallet NEVER signs. Protocol handles everything.
      // ═══════════════════════════════════════════════════════════════════════

      const DELAY_BETWEEN_PROOFS = 1500; // 1.5 seconds between proof generations
      const DELAY_BETWEEN_SUBMISSIONS = 1000; // 1 second between protocol submissions

      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 1: Check protocol health and get protocol address
      // ═══════════════════════════════════════════════════════════════════════
      setProofProgress('Connecting...');
      let protocol: PublicKey;
      try {
        const health = await checkProtocolHealth();
        console.log('[Phase 1] Protocol health:', health);
        if (health.status !== 'ok') {
          throw new Error('Service is not available');
        }
        // Get protocol address from the protocol service (source of truth)
        protocol = new PublicKey(health.protocol);
        console.log(`[Phase 1] Protocol address from service: ${protocol.toBase58()}`);
      } catch (healthErr) {
        console.error('[Phase 1] Protocol health check failed:', healthErr);
        throw new Error('Cannot reach service. Please try again later.');
      }

      console.log(`\n=== Starting ${selectedNotes.length} protocol-only withdrawal(s) ===`);
      console.log(`Protocol: ${protocol.toBase58()}`);


      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 2: Generate proofs and build instructions
      // ═══════════════════════════════════════════════════════════════════════
      const preparedSubmissions: ProtocolSubmissionData[] = [];

      for (let i = 0; i < selectedNotes.length; i++) {
        const note = selectedNotes[i];

        setProofProgress(`Generating proof ${i + 1}/${selectedNotes.length}...`);
        console.log(`[Phase 2] Preparing note ${i + 1}/${selectedNotes.length}`, {
          noteId: note.commitment?.slice(0, 16) + '...',
          pool: note.poolId,
          leafIndex: note.leafIndex,
          root: note.rootAfter?.slice(0, 16) + '...',
        });

        try {
          const submission = await prepareWithdrawalForProtocol(
            connection,
            note,
            recipient,
            protocol,
            (status) => setProofProgress(`Proof ${i + 1}/${selectedNotes.length}: ${status}`)
          );
          preparedSubmissions.push(submission);
          console.log(`[Phase 2] Proof ${i + 1}/${selectedNotes.length} ready for protocol`);
        } catch (proofErr) {
          console.error(`[Phase 2] Failed to generate proof ${i + 1}:`, proofErr);
          const errMsg = proofErr instanceof Error ? proofErr.message : 'Unknown error';
          throw new Error(`Failed to generate proof for note ${i + 1}: ${errMsg}`);
        }

        // Delay between proofs (except for last one)
        if (i < selectedNotes.length - 1) {
          await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_PROOFS));
        }
      }

      console.log(`[Phase 2] All ${preparedSubmissions.length} proofs ready`);

      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 3: Submit to protocol (protocol signs and submits on our behalf)
      // ═══════════════════════════════════════════════════════════════════════
      console.log('[Phase 3] Submitting to protocol...');

      for (let i = 0; i < preparedSubmissions.length; i++) {
        const submission = preparedSubmissions[i];

        setProofProgress(`Submitting ${i + 1}/${preparedSubmissions.length}...`);
        console.log(`[Phase 3] Submitting withdrawal ${i + 1}/${preparedSubmissions.length}`);

        try {
          const result = await submitWithdrawalToProtocol(
            submission.poolId,
            submission.instruction
          );

          if (result.status === 'success' || result.status === 'duplicate') {
            txSignatures.push(result.signature);
            console.log(`[Phase 3] Withdrawal ${i + 1} ${result.status}:`, result.signature);

            if (result.status === 'duplicate') {
              console.log(`[Phase 3] Note ${i + 1} was already withdrawn (duplicate nullifier)`);
            }
          } else {
            console.error(`[Phase 3] Withdrawal ${i + 1} failed:`, result.error);
            setError(`Withdrawal ${i + 1} failed: ${result.error || 'Unknown error'}`);
          }
        } catch (submitErr) {
          console.error(`[Phase 3] Submit error for withdrawal ${i + 1}:`, submitErr);
          const errMsg = submitErr instanceof Error ? submitErr.message : 'Unknown error';
          setError(`Withdrawal ${i + 1} submit failed: ${errMsg}`);
        }

        // Delay between submissions
        if (i < preparedSubmissions.length - 1) {
          await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_SUBMISSIONS));
        }
      }

      console.log(`[Phase 3] Completed ${txSignatures.length}/${preparedSubmissions.length} withdrawals`);

      // Show success
      if (txSignatures.length > 0) {
        setSuccessTxs(txSignatures);
        setProofProgress(`${txSignatures.length}/${selectedNotes.length} withdrawal(s) complete!`);
        console.log(`\n=== ${txSignatures.length}/${selectedNotes.length} withdrawals successful ===`);

        // Wait a bit to show success state
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Clear selection on success
        onClear();
      } else {
        setError('All withdrawals failed. Please try again.');
      }

    } catch (err) {
      console.error('Withdrawal batch error:', err);
      const errMsg = err instanceof Error ? err.message : 'Withdrawal failed';
      setError(errMsg);
    } finally {
      setShowProofOverlay(false);
      setIsWithdrawing(false);
    }
  }, [connection, effectiveRecipient, selectedNotes, onClear]);

  return (
    <>
      {/* Floating bar */}
      <div className="fixed bottom-0 left-0 right-0 z-40">
        <div className="max-w-6xl mx-auto px-6 pb-6">
          <div className="glass-card p-4 flex items-center gap-4">
            {/* Selection info */}
            <div className="flex-1">
              <div className="text-zk-text font-semibold">
                {selectedNotes.length} {selectedNotes.length === 1 ? 'note' : 'notes'} selected
              </div>
              <div className="text-zk-text-muted text-sm">
                {formatSol(selectedBalance)} SOL total
              </div>
            </div>

            {/* Recipient input */}
            <div className="flex-1">
              <input
                type="text"
                placeholder={publicKey?.toBase58().slice(0, 12) + '... (your wallet)'}
                value={recipientAddress}
                onChange={e => setRecipientAddress(e.target.value)}
                className="w-full px-4 py-2 bg-zk-bg/50 border border-zk-teal/30 rounded-xl text-zk-text placeholder-zk-text-muted text-sm focus:outline-none focus:border-zk-teal"
              />
              <div className="text-zk-text-muted text-xs mt-1">
                Recipient address (leave blank for your wallet)
              </div>
            </div>

            {/* Withdraw button */}
            <Button
              variant="primary"
              size="md"
              onClick={handleWithdraw}
              loading={isWithdrawing}
              disabled={isWithdrawing || selectedNotes.length === 0}
            >
              Withdraw {formatSol(selectedBalance)} SOL
            </Button>
          </div>

          {/* Error */}
          {error && (
            <div className="mt-2 p-2 bg-zk-danger/20 border border-zk-danger/50 rounded-xl text-zk-danger text-sm text-center">
              {error}
            </div>
          )}
        </div>
      </div>

      {/* Proof Overlay */}
      {showProofOverlay && (
        <ProofOverlay
          status={proofProgress}
          onCancel={() => {
            setShowProofOverlay(false);
            setIsWithdrawing(false);
          }}
        />
      )}
    </>
  );
}
