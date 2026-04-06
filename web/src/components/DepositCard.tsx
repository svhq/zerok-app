'use client';

import { useState, useCallback } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { Card, Button, Counter } from './ui';
import { formatSol } from '@/lib/pool-config';
import { usePool } from '@/contexts/PoolContext';
import { computeCommitmentFromBigInts, generateRandomFieldElement } from '@/lib/sdk/poseidon';
import { Note } from '@/types/note';
import { saveEncryptedBlob } from '@/lib/note-storage';
import { getCachedKey, encryptNote, encryptCompactMemoPayload, CompactMemoPayload } from '@/lib/note-encryption';
import { backupNoteToRelay } from '@/lib/relayer-client';
import { parseDepositEvent } from '@/lib/deposit-event';
import { executeWithRotation } from '@/lib/resilient-connection';
import { resetRpcLog, logRpcEvent, printRpcReport } from '@/lib/rpc-diagnostics';
import { confirmTransactionWsFirst } from '@/lib/ws-confirmation';
import { createComputeBudgetInstructions, DEPOSIT_COMPUTE_UNITS, DEPOSIT_WITH_MEMO_COMPUTE_UNITS, DEFAULT_PRIORITY_FEE } from '@/lib/compute-budget';

const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

interface DepositProgress {
  current: number;
  total: number;
  status: 'generating' | 'signing' | 'confirming' | 'saving';
}

// Pre-computed deposit payload (blockhash-independent)
interface DepositPayload {
  nullifier: bigint;
  secret: bigint;
  commitment: Uint8Array;
  commitmentHex: string;
  nullifierHashHex: string;
}

// Prepared transaction data before signing
interface PreparedDeposit {
  transaction: Transaction;
  payload: DepositPayload;
}

export interface DepositCardProps {
  onNotesCreated?: (notes: Note[]) => void;
  keyReady?: boolean;  // true once wallet-derived AES key is cached; gates deposit form
}

export default function DepositCard({ onNotesCreated, keyReady = false }: DepositCardProps) {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const { poolConfig, deployedPools, selectedPoolId, selectPool } = usePool();

  const [quantity, setQuantity] = useState(1);
  const [isDepositing, setIsDepositing] = useState(false);
  const [progress, setProgress] = useState<DepositProgress | null>(null);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [completedCount, setCompletedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Early return if pool not selected
  if (!poolConfig) {
    return (
      <Card>
        <div className="text-center text-gray-400">Select a vault to deposit</div>
      </Card>
    );
  }

  const totalAmount = BigInt(quantity) * BigInt(poolConfig.denominationLamports);
  const totalAmountDisplay = formatSol(totalAmount);

  // Generate deposit payload (blockhash-independent, can be done early)
  const generateDepositPayload = async (): Promise<DepositPayload> => {
    // Generate random field elements for nullifier and secret
    const nullifier = generateRandomFieldElement();
    const secret = generateRandomFieldElement();

    // Compute commitment
    const { commitment, nullifierHash } = await computeCommitmentFromBigInts(nullifier, secret);

    // Convert to hex strings
    const commitmentHex = Array.from(commitment).map(b => b.toString(16).padStart(2, '0')).join('');
    const nullifierHashHex = Array.from(nullifierHash).map(b => b.toString(16).padStart(2, '0')).join('');

    return {
      nullifier,
      secret,
      commitment,
      commitmentHex,
      nullifierHashHex,
    };
  };

  // Build deposit transaction from payload (needs fresh blockhash)
  const buildDepositTransaction = async (
    payload: DepositPayload,
    blockhash: string,
    activeShardIndex: number,
    memoText?: string
  ): Promise<PreparedDeposit> => {
    if (!publicKey) {
      throw new Error('Wallet not connected');
    }

    // Build the deposit instruction
    const programId = new PublicKey(poolConfig.programId);
    const statePda = new PublicKey(poolConfig.statePda);
    const vaultPda = new PublicKey(poolConfig.vaultPda);
    const metadataPda = new PublicKey(poolConfig.metadataPda);
    const rootRingPda = new PublicKey(poolConfig.rootRingPda);

    const activeShardPda = new PublicKey(poolConfig.shardPdas[activeShardIndex]);

    // Compute discriminator for deposit_v2_clean using SubtleCrypto
    const preimage = 'global:deposit_v2_clean';
    const encoder = new TextEncoder();
    const encoded = encoder.encode(preimage);
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoded.buffer as ArrayBuffer);
    const discriminatorBytes = new Uint8Array(hashBuffer).slice(0, 8);

    // Build instruction data: discriminator(8) + commitment(32) + light_params(7)
    // Light Protocol params (all zeros = disabled):
    //   light_enabled: bool = false (1 byte)
    //   light_proof_bytes: Vec<u8> = empty (4 bytes for Borsh length prefix)
    //   output_tree_index: u8 = 0 (1 byte)
    //   light_accounts_offset: u8 = 0 (1 byte)
    const instructionData = new Uint8Array(8 + 32 + 7);
    instructionData.set(discriminatorBytes, 0);
    instructionData.set(payload.commitment, 8);
    // Bytes 40-46 are already zero (light disabled)

    // Create deposit instruction with DepositV2Clean accounts:
    // 0. pool_state (mut)
    // 1. vault (mut)
    // 2. depositor (signer, mut)
    // 3. system_program
    // 4. cooldown_config (placeholder = programId)
    // 5. user_cooldown (placeholder = programId)
    // 6. root_ring (mut)          — legacy K=128 ring buffer
    // 7. root_ring_metadata (mut) — sharded ring metadata
    // 8. active_shard (mut)
    const depositIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: statePda, isSigner: false, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: programId, isSigner: false, isWritable: false }, // cooldown_config placeholder
        { pubkey: programId, isSigner: false, isWritable: false }, // user_cooldown placeholder
        { pubkey: rootRingPda, isSigner: false, isWritable: true },
        { pubkey: metadataPda, isSigner: false, isWritable: true },
        { pubkey: activeShardPda, isSigner: false, isWritable: true },
      ],
      data: Buffer.from(instructionData),
    });

    // Build transaction with ComputeBudget instructions first
    // This tells the wallet exactly what compute/priority to expect,
    // reducing wallet "guesswork" and potentially speeding up signing preview
    const cuUnits = memoText ? DEPOSIT_WITH_MEMO_COMPUTE_UNITS : DEPOSIT_COMPUTE_UNITS;
    const transaction = new Transaction();
    transaction.add(...createComputeBudgetInstructions(cuUnits, DEFAULT_PRIORITY_FEE));
    transaction.add(depositIx);
    if (memoText) {
      // Memo instruction: encrypted note secrets live permanently in tx history
      // atomic with deposit — only exists if deposit succeeded
      transaction.add(new TransactionInstruction({
        programId: new PublicKey(MEMO_PROGRAM_ID),
        keys: [],  // No signers — avoids Phantom pre-sign simulation failure.
        // Memo v2 with empty keys records data without signature verification.
        // The deposit tx signature already authenticates this memo.
        data: Buffer.from(memoText, 'utf8'),
      }));
    }
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = publicKey;

    return {
      transaction,
      payload,
    };
  };

  // Parse transaction and create note
  // CRITICAL: Retry until successful - a deposit without a note is unacceptable
  const processConfirmedDeposit = async (
    signature: string,
    payload: DepositPayload
  ): Promise<Note> => {
    let leafIndex = -1;
    let rootAfter = '';
    let siblings: string[] = [];

    // Retry configuration - more aggressive for single-endpoint networks
    const maxRetries = 10;
    const baseDelay = 3000; // 3 seconds

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`Parsing deposit event (attempt ${attempt}/${maxRetries})...`);
        const eventData = await parseDepositEvent(connection, signature);
        leafIndex = eventData.leafIndex;
        rootAfter = eventData.rootAfter;
        siblings = eventData.siblings;
        console.log('Parsed deposit event successfully:', {
          leafIndex,
          rootAfter: rootAfter.slice(0, 20) + '...',
          siblingsCount: siblings.length
        });
        break; // Success - exit retry loop
      } catch (eventErr) {
        const errMsg = eventErr instanceof Error ? eventErr.message : 'Unknown';
        const is429 = errMsg.includes('429') || errMsg.includes('rate') || errMsg.includes('cooldown');

        if (is429) {
          // Exponential backoff: 3s, 6s, 12s, 24s, 48s, 96s...
          const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 1000;
          console.warn(`[Retry ${attempt}/${maxRetries}] Rate limited, waiting ${Math.round(delay / 1000)}s...`);

          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
        }

        // Non-429 error or max retries exhausted
        if (attempt === maxRetries) {
          console.error('CRITICAL: Note parsing failed after all retries:', eventErr);
          throw new Error(
            `Failed to parse note after ${maxRetries} attempts. ` +
            `Your deposit tx (${signature.slice(0, 8)}...) is on-chain. ` +
            `Please try again later or contact support.`
          );
        }

        // Non-429 error on non-final attempt - try one more time after short delay
        console.warn(`[Retry ${attempt}/${maxRetries}] Error: ${errMsg}, retrying...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // At this point we MUST have valid note data
    return {
      id: payload.commitmentHex,
      poolId: poolConfig.poolId,
      commitment: '0x' + payload.commitmentHex,
      nullifierSecret: payload.nullifier.toString(),
      noteSecret: payload.secret.toString(),
      nullifierHash: '0x' + payload.nullifierHashHex,
      leafIndex,
      rootAfter,
      siblings,
      depositTx: signature,
      createdAt: new Date().toISOString(),
      status: 'confirmed',
    };
  };

  // Silently encrypt and store a note for wallet-based recovery.
  // Non-fatal: file download already happened; this is the backup layer.
  const backupNoteEncrypted = async (note: Note, key: CryptoKey) => {
    try {
      const blob = await encryptNote(note, key);
      saveEncryptedBlob(note.commitment, blob);   // localStorage (primary)
      backupNoteToRelay(note.commitment, blob);   // relay (cross-device, fire-and-forget)
    } catch (err) {
      console.warn('[DepositCard] Encrypted backup failed (non-fatal):', err);
    }
  };

  const handleDeposit = useCallback(async () => {
    if (!publicKey || !signTransaction) {
      setError('Please connect your wallet');
      return;
    }

    setIsDepositing(true);
    setError(null);
    setCompletedCount(0);

    resetRpcLog();
    logRpcEvent('=== DEPOSIT START ===');

    // Use pre-cached key from StatusTab session (derived when user clicks "Load my notes").
    // We deliberately do NOT call signMessage here — doing signMessage → signTransaction
    // in the same gesture triggers Phantom's anti-drainer simulation check, which
    // causes a false-positive "reverted during simulation" warning even when the tx
    // would succeed on-chain. Key is derived once in StatusTab; all deposits that
    // session get Memo backup silently with no extra popups.
    const encryptionKey = getCachedKey(publicKey.toBase58()) ?? null;

    const createdNotes: Note[] = [];
    const metadataPda = new PublicKey(poolConfig.metadataPda);

    try {
      console.log(`\n=== Starting ${quantity} deposit(s) (sequential per-deposit) ===`);

      for (let i = 0; i < quantity; i++) {
        console.log(`\n--- Deposit ${i + 1}/${quantity} ---`);

        // ── Step A: Generate unique payload ────────────────────────────────
        setProgress({ current: i + 1, total: quantity, status: 'generating' });
        const payload = await generateDepositPayload();
        console.log(`[Deposit ${i + 1}] Payload generated`);

        // ── Step B: Fresh on-chain state (per deposit, eliminates race conditions)
        // Both activeShardIndex and blockhash are fetched fresh so each deposit
        // sees the fully-settled result of all prior deposits in this batch.
        let activeShardIndex = 0;
        try {
          const metadataAccount = await executeWithRotation(
            (conn) => conn.getAccountInfo(metadataPda)
          );
          if (metadataAccount && metadataAccount.data.length >= 36) {
            const dataView = new DataView(new Uint8Array(metadataAccount.data).buffer);
            activeShardIndex = dataView.getUint32(32, true);
          }
          console.log(`[Deposit ${i + 1}] Shard index: ${activeShardIndex}`);
        } catch (err) {
          console.warn(`[Deposit ${i + 1}] Metadata read failed, defaulting shard=0:`, err);
        }

        const { blockhash } = await executeWithRotation(
          (conn) => conn.getLatestBlockhash('confirmed')
        );
        console.log(`[Deposit ${i + 1}] Blockhash: ${blockhash.slice(0, 16)}...`);

        // ── Step C: Build transaction ───────────────────────────────────────
        // Encrypt compact payload for on-chain Memo recovery (non-fatal if fails)
        let memoText: string | undefined;
        if (encryptionKey) {
          try {
            const compact: CompactMemoPayload = {
              n: payload.nullifier.toString(16).padStart(62, '0'),
              s: payload.secret.toString(16).padStart(62, '0'),
              c: payload.commitmentHex,
              h: payload.nullifierHashHex,
              p: poolConfig.poolId,
              d: poolConfig.denominationLamports.toString(),
            };
            memoText = await encryptCompactMemoPayload(compact, encryptionKey);
          } catch {
            // non-fatal — deposit proceeds without Memo backup
          }
        }
        const { transaction } = await buildDepositTransaction(payload, blockhash, activeShardIndex, memoText);

        // ── Step D: Sign (one popup per deposit — avoids Blowfish batch-drain) ─
        setProgress({ current: i + 1, total: quantity, status: 'signing' });
        console.log(`[Deposit ${i + 1}] Signing...`);
        logRpcEvent(`SIGN_TX_START deposit ${i + 1}`);

        let signedTx: Transaction;
        try {
          signedTx = await signTransaction(transaction);
        } catch (signErr) {
          const errMsg = signErr instanceof Error ? signErr.message : String(signErr);
          if (errMsg.includes('rejected') || errMsg.includes('cancelled') || errMsg.includes('User rejected')) {
            setError(`Deposit ${i + 1} cancelled by user`);
            break; // User explicitly cancelled — stop the loop
          }
          throw signErr;
        }
        console.log(`[Deposit ${i + 1}] Signed`);
        logRpcEvent(`SIGN_TX_END deposit ${i + 1}`);

        // ── Step E: Send ────────────────────────────────────────────────────
        const TX_SEND_MAX_RETRIES = 5;
        const TX_SEND_BASE_DELAY_MS = 3000;
        let signature: string | null = null;

        for (let attempt = 1; attempt <= TX_SEND_MAX_RETRIES; attempt++) {
          try {
            signature = await executeWithRotation(
              (conn) => conn.sendRawTransaction(signedTx.serialize(), {
                skipPreflight: true,
                preflightCommitment: 'confirmed',
                maxRetries: 3,
              })
            );
            console.log(`[Deposit ${i + 1}] Sent: ${signature}`);
            break;
          } catch (sendErr) {
            const errMsg = sendErr instanceof Error ? sendErr.message : 'Unknown';
            const is429 = errMsg.includes('429') || errMsg.includes('rate');
            if (is429 && attempt < TX_SEND_MAX_RETRIES) {
              const delay = TX_SEND_BASE_DELAY_MS * Math.pow(2, attempt - 1);
              console.warn(`[Deposit ${i + 1}] 429, retry ${attempt}/${TX_SEND_MAX_RETRIES} after ${delay}ms...`);
              await new Promise(r => setTimeout(r, delay));
              continue;
            }
            console.error(`[Deposit ${i + 1}] Send failed:`, sendErr);
            setError(`Deposit ${i + 1} send failed: ${errMsg}`);
            signature = null;
            break;
          }
        }

        if (!signature) continue; // skip to next deposit if send failed

        // ── Step F: Confirm (wait before starting next deposit) ─────────────
        setProgress({ current: i + 1, total: quantity, status: 'confirming' });
        console.log(`[Deposit ${i + 1}] Confirming...`);

        try {
          const confirmResult = await confirmTransactionWsFirst(signature, 'confirmed');
          if (!confirmResult.confirmed) {
            throw new Error(confirmResult.error || 'Confirmation failed');
          }
          console.log(`[Deposit ${i + 1}] Confirmed in ${confirmResult.durationMs}ms`);
        } catch (confirmErr) {
          const errMsg = confirmErr instanceof Error ? confirmErr.message : String(confirmErr);
          console.error(`[Deposit ${i + 1}] Confirmation failed:`, confirmErr);
          setError(`Deposit ${i + 1} failed: ${errMsg}`);
          continue; // try remaining deposits
        }

        // ── Step G: Parse event and save note ──────────────────────────────
        setProgress({ current: i + 1, total: quantity, status: 'saving' });
        try {
          const note = await processConfirmedDeposit(signature, payload);

          if (note.leafIndex < 0 || !note.rootAfter || note.siblings.length === 0) {
            throw new Error(
              `CRITICAL: Note data incomplete. Tx: ${signature.slice(0, 8)}... ` +
              `DO NOT CLOSE THIS PAGE. Contact support immediately.`
            );
          }

          if (encryptionKey) {
            backupNoteEncrypted(note, encryptionKey); // fire-and-forget (localStorage + relay)
          }
          createdNotes.push(note);
          setCompletedCount(createdNotes.length);
          console.log(`[Deposit ${i + 1}] Note secured in wallet Memo, leafIndex=${note.leafIndex}`);

        } catch (parseErr: unknown) {
          const errMsg = parseErr instanceof Error ? parseErr.message : 'Unknown error';
          console.error(`[Deposit ${i + 1}] Note parse failed:`, parseErr);
          setError(`Deposit ${i + 1} confirmed but note creation failed: ${errMsg}`);
        }
      }

      // Notify parent of created notes (for RecentNotes feature)
      if (createdNotes.length > 0 && onNotesCreated) {
        onNotesCreated(createdNotes);
      }

      if (createdNotes.length > 0) {
        setShowSuccessModal(true);
        console.log(`\n=== ${createdNotes.length}/${quantity} deposits successful ===`);
      } else {
        setError('All deposits failed. Please try again.');
      }

    } catch (err) {
      console.error('Deposit error:', err);
      const errMsg = err instanceof Error ? err.message : 'Deposit failed';
      if (errMsg.includes('rejected') || errMsg.includes('cancelled') || errMsg.includes('User rejected')) {
        setError('Deposit cancelled by user');
      } else {
        setError(errMsg);
      }
    } finally {
      logRpcEvent('=== DEPOSIT END ===');
      printRpcReport();
      setIsDepositing(false);
      setProgress(null);
    }
  }, [publicKey, signTransaction, connection, quantity, onNotesCreated, poolConfig]);

  return (
    <>
      <div className="p-6 pb-8">
          {/* Header */}
          <div className="mb-6">
            <h2 className="text-xl font-semibold text-zk-text mb-1">Private Deposit</h2>
            <p className="text-zk-text-muted text-sm">
              Deposit SOL privately into the shielded vault
            </p>
          </div>

          {/* Recovery gate: deposit form is only shown once the wallet-derived AES key is cached.
              This guarantees every deposit writes a Memo to the transaction — the permanent
              on-chain recovery path. Without the key, we'd have no backup for the note. */}
          {!keyReady ? (
            <div className="flex flex-col items-center justify-center py-10 text-center gap-3">
              <div className="w-2 h-2 rounded-full bg-zk-teal animate-pulse" />
              <p className="text-zk-text-muted text-sm">
                Approve the sign request in your wallet to enable note recovery.
              </p>
              <p className="text-zk-text-muted/50 text-xs">
                Only approve on zerok.app — this secures your notes to your wallet.
              </p>
            </div>
          ) : (<>

          {/* Token Selector (disabled - SOL only) */}
          <div className="mb-4">
            <label className="block text-zk-text-muted text-sm mb-2">Token</label>
            <div className="flex items-center gap-3 p-3 bg-zk-bg/50 rounded-xl border border-zk-teal/20">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-zk-teal to-zk-success flex items-center justify-center">
                <span className="text-zk-text font-bold text-sm">◎</span>
              </div>
              <span className="text-zk-text font-medium">SOL</span>
              <span className="text-zk-text-muted text-sm ml-auto">Solana</span>
            </div>
          </div>

          {/* Pool Selector */}
          <div className="mb-4">
            <label className="block text-zk-text-muted text-sm mb-2">Vault</label>
            <div className="flex gap-2 flex-wrap">
              {deployedPools.map((pool) => (
                <button
                  key={pool.id}
                  onClick={() => selectPool(pool.id)}
                  disabled={isDepositing}
                  className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                    selectedPoolId === pool.id
                      ? 'bg-zk-teal text-zk-text'
                      : 'bg-zk-bg/50 text-zk-text-muted hover:text-zk-text hover:bg-zk-surface/80 border border-zk-teal/20'
                  } ${isDepositing ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {pool.label}
                </button>
              ))}
            </div>
          </div>

          {/* Quantity */}
          <div className="mb-6">
            <label className="block text-zk-text-muted text-sm mb-2">Quantity</label>
            <div className="flex items-center justify-between">
              <Counter value={quantity} min={1} max={10} onChange={setQuantity} />
              <div className="text-right">
                <div className="text-zk-text font-semibold">{totalAmountDisplay} SOL</div>
              </div>
            </div>
          </div>

          {/* Error Message */}
          {error && (
            <div className="mb-4 p-3 bg-zk-danger/20 border border-zk-danger/50 rounded-xl text-zk-danger text-sm">
              {error}
            </div>
          )}

          {/* Progress Display */}
          {progress && (
            <div className="mb-4 p-4 bg-zk-bg/50 rounded-xl border border-zk-teal/20">
              <div className="flex items-center justify-between mb-2">
                <span className="text-zk-text-muted text-sm">
                  Deposit {progress.current} of {progress.total}
                </span>
                <span className="text-zk-teal text-sm font-medium">
                  {progress.status === 'generating' && 'Generating...'}
                  {progress.status === 'signing' && 'Sign in wallet...'}
                  {progress.status === 'confirming' && 'Confirming...'}
                  {progress.status === 'saving' && 'Saving note...'}
                </span>
              </div>
              <div className="w-full h-2 bg-zk-bg rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-zk-teal to-zk-success transition-all duration-300"
                  style={{ width: `${((progress.current - 1) / progress.total) * 100 + (progress.status === 'saving' ? 100 / progress.total : 50 / progress.total)}%` }}
                />
              </div>
              {completedCount > 0 && (
                <p className="text-zk-success text-xs mt-2">
                  {completedCount} note{completedCount > 1 ? 's' : ''} secured in wallet
                </p>
              )}
            </div>
          )}

          {/* Deposit Button */}
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            onClick={handleDeposit}
            loading={isDepositing}
            disabled={!publicKey || isDepositing}
          >
            {isDepositing
              ? (progress ? `Depositing ${progress.current}/${progress.total}...` : 'Preparing...')
              : `DEPOSIT ${totalAmountDisplay} SOL`
            }
          </Button>

          </>)} {/* end keyReady gate */}
      </div>

      {/* Success Modal */}
      {showSuccessModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <Card className="w-full max-w-sm text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-zk-success/20 flex items-center justify-center">
              <svg className="w-8 h-8 text-zk-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold text-zk-text mb-2">
              {completedCount} Note{completedCount > 1 ? 's' : ''} Secured!
            </h3>
            <p className="text-zk-text-muted text-sm mb-6">
              Your {completedCount > 1 ? 'notes are' : 'note is'} permanently embedded in your wallet&apos;s transaction history — recoverable from any device.
            </p>
            <Button
              variant="primary"
              className="w-full"
              onClick={() => {
                setShowSuccessModal(false);
                setCompletedCount(0);
                setQuantity(1);
              }}
            >
              Done
            </Button>
          </Card>
        </div>
      )}
    </>
  );
}
