'use client';

import { useState, useCallback } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { Card, Button, Counter } from './ui';
import { formatSol } from '@/lib/pool-config';
import { usePool } from '@/contexts/PoolContext';
import { computeCommitmentFromBigInts, generateRandomFieldElement } from '@/lib/sdk/poseidon';
import { Note } from '@/types/note';
import { exportNoteToFile } from '@/lib/note-storage';
import { parseDepositEvent } from '@/lib/deposit-event';
import { executeWithRotation } from '@/lib/resilient-connection';
import { resetRpcLog, logRpcEvent, printRpcReport } from '@/lib/rpc-diagnostics';
import { confirmTransactionWsFirst } from '@/lib/ws-confirmation';
import { withControlledConcurrency } from '@/lib/confirmation-limiter';
import { createComputeBudgetInstructions, DEPOSIT_COMPUTE_UNITS, DEFAULT_PRIORITY_FEE } from '@/lib/compute-budget';
import { getCurrentNetwork } from '@/lib/network-config';

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
}

export default function DepositCard({ onNotesCreated }: DepositCardProps) {
  const { publicKey, signTransaction, signAllTransactions } = useWallet();
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
        <div className="text-center text-gray-400">Select a pool to deposit</div>
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
    activeShardIndex: number
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
    const transaction = new Transaction();
    transaction.add(...createComputeBudgetInstructions(DEPOSIT_COMPUTE_UNITS, DEFAULT_PRIORITY_FEE));
    transaction.add(depositIx);
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

  const handleDeposit = useCallback(async () => {
    if (!publicKey || !signAllTransactions) {
      setError('Please connect your wallet');
      return;
    }

    setIsDepositing(true);
    setError(null);
    setCompletedCount(0);

    // Start RPC diagnostics
    resetRpcLog();
    logRpcEvent('=== DEPOSIT START ===');

    const createdNotes: Note[] = [];

    try {
      // Optimized 4-Phase Deposit Flow:
      // Phase 1: Generate all payloads (fast, no blockhash needed)
      // Phase 2: Read metadata + get fresh blockhash + build transactions (fast)
      // Phase 3: Sign all at once (single popup)
      // Phase 4: Send and confirm sequentially

      console.log(`\n=== Starting ${quantity} deposit(s) with optimized flow ===`);

      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 1: Generate all payloads (no blockhash needed)
      // ═══════════════════════════════════════════════════════════════════════
      setProgress({ current: 0, total: quantity, status: 'generating' });
      console.log('[Phase 1] Generating deposit payloads...');

      const payloads: DepositPayload[] = [];
      for (let i = 0; i < quantity; i++) {
        setProgress({ current: i + 1, total: quantity, status: 'generating' });
        const payload = await generateDepositPayload();
        payloads.push(payload);
        console.log(`[Phase 1] Generated payload ${i + 1}/${quantity}`);
      }

      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 2: Get metadata + blockhash (simple, no caching)
      // ═══════════════════════════════════════════════════════════════════════
      console.log('[Phase 2] Fetching metadata and blockhash...');
      const phase2Start = performance.now();

      // Fetch metadata - use executeWithRotation for Helius (high rate limits)
      let activeShardIndex = 0;
      const metadataPda = new PublicKey(poolConfig.metadataPda);
      try {
        const metadataAccount = await executeWithRotation(
          (conn) => conn.getAccountInfo(metadataPda)
        );
        if (metadataAccount && metadataAccount.data.length >= 36) {
          const dataView = new DataView(new Uint8Array(metadataAccount.data).buffer);
          activeShardIndex = dataView.getUint32(32, true);
        }
        console.log(`[Phase 2] Metadata fetched in ${(performance.now() - phase2Start).toFixed(0)}ms, shard: ${activeShardIndex}`);
      } catch (err) {
        console.warn('[Phase 2] Failed to read metadata, defaulting to shard 0:', err);
      }

      // Fetch blockhash - use executeWithRotation for Helius (high rate limits)
      const blockhashStart = performance.now();
      const { blockhash, lastValidBlockHeight } = await executeWithRotation(
        (conn) => conn.getLatestBlockhash('confirmed')
      );
      console.log(`[Phase 2] Blockhash fetched in ${(performance.now() - blockhashStart).toFixed(0)}ms: ${blockhash.slice(0, 16)}...`);
      console.log(`[Phase 2] Total Phase 2: ${(performance.now() - phase2Start).toFixed(0)}ms`);

      // Build all transactions with fresh blockhash (fast)
      const preparedDeposits: PreparedDeposit[] = [];
      for (const payload of payloads) {
        const prepared = await buildDepositTransaction(payload, blockhash, activeShardIndex);
        preparedDeposits.push(prepared);
      }
      console.log(`[Phase 2] Built ${preparedDeposits.length} transactions`);

      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 3: Sign transactions (with detailed timing)
      // ═══════════════════════════════════════════════════════════════════════
      setProgress({ current: quantity, total: quantity, status: 'signing' });

      const transactions = preparedDeposits.map(p => p.transaction);
      console.log(`[Phase 3] Built ${transactions.length} transaction(s), preparing to sign...`);

      // Log transaction details for debugging
      const tx = transactions[0];
      console.log(`[Phase 3] Transaction details:`, {
        numInstructions: tx.instructions.length,
        feePayer: tx.feePayer?.toBase58().slice(0, 12) + '...',
        blockhash: tx.recentBlockhash?.slice(0, 16) + '...',
        signatureCount: tx.signatures.length,
      });

      const phase3Start = performance.now();
      console.log(`[Phase 3] Calling signTransaction NOW at ${new Date().toISOString()}...`);
      logRpcEvent('SIGN_TX_START - Wallet will simulate transaction internally');

      let signedTransactions: Transaction[];

      if (transactions.length === 1 && signTransaction) {
        // Single transaction - use simpler signTransaction
        const signed = await signTransaction(transactions[0]);
        signedTransactions = [signed];
        const signTime = (performance.now() - phase3Start).toFixed(0);
        console.log(`[Phase 3] Signed 1 transaction in ${signTime}ms`);
        logRpcEvent(`SIGN_TX_END - Took ${signTime}ms (THIS IS THE WALLET SIMULATION TIME)`);
      } else if (signAllTransactions) {
        // Multiple transactions - use signAllTransactions
        signedTransactions = await signAllTransactions(transactions);
        const signTime = (performance.now() - phase3Start).toFixed(0);
        console.log(`[Phase 3] Signed ${signedTransactions.length} transactions in ${signTime}ms`);
        logRpcEvent(`SIGN_TX_END - Took ${signTime}ms (THIS IS THE WALLET SIMULATION TIME)`);
      } else {
        throw new Error('Wallet does not support transaction signing');
      }

      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 4: Send ALL transactions first (fast, no waiting for confirm)
      // ═══════════════════════════════════════════════════════════════════════
      console.log('[Phase 4] Sending all transactions...');
      setProgress({ current: 0, total: quantity, status: 'confirming' });

      // Testnet-only delays to avoid 429 rate limits (single RPC endpoint)
      const isTestnet = getCurrentNetwork() === 'testnet';
      const PHASE4_INITIAL_DELAY_MS = 5000; // 5 seconds before starting
      const TX_SEND_DELAY_MS = 3000; // 3 seconds between sends
      const TX_SEND_MAX_RETRIES = 5;
      const TX_SEND_BASE_DELAY_MS = 3000;

      // TESTNET ONLY: Wait for rate limit to reset after Phase 2-3 RPC calls
      if (isTestnet) {
        console.log(`[Testnet] Waiting ${PHASE4_INITIAL_DELAY_MS}ms for rate limit reset before Phase 4...`);
        await new Promise(r => setTimeout(r, PHASE4_INITIAL_DELAY_MS));
      }

      const sendResults: { index: number; signature: string; payload: DepositPayload }[] = [];

      for (let i = 0; i < signedTransactions.length; i++) {
        const signedTx = signedTransactions[i];
        let signature: string | null = null;

        // Retry loop with exponential backoff for 429 errors
        for (let attempt = 1; attempt <= TX_SEND_MAX_RETRIES; attempt++) {
          try {
            signature = await executeWithRotation(
              (conn) => conn.sendRawTransaction(signedTx.serialize(), {
                skipPreflight: true,
                preflightCommitment: 'confirmed',
                maxRetries: 3,
              })
            );
            console.log(`[Phase 4] Transaction ${i + 1} sent:`, signature);
            break; // Success - exit retry loop
          } catch (sendErr) {
            const errMsg = sendErr instanceof Error ? sendErr.message : 'Unknown';
            const is429 = errMsg.includes('429') || errMsg.includes('rate');

            if (is429 && attempt < TX_SEND_MAX_RETRIES) {
              const delay = TX_SEND_BASE_DELAY_MS * Math.pow(2, attempt - 1);
              console.warn(`[Phase 4] Tx ${i + 1} got 429, retry ${attempt}/${TX_SEND_MAX_RETRIES} after ${delay}ms...`);
              await new Promise(r => setTimeout(r, delay));
              continue;
            }

            console.error(`[Phase 4] Failed to send transaction ${i + 1}:`, sendErr);
            setError(`Failed to send deposit ${i + 1}: ${errMsg}`);
            signature = null;
            break;
          }
        }

        if (signature) {
          sendResults.push({ index: i, signature, payload: preparedDeposits[i].payload });

          // TESTNET ONLY: Delay between sends to avoid 429
          if (isTestnet && i < signedTransactions.length - 1) {
            console.log(`[Testnet] Waiting ${TX_SEND_DELAY_MS}ms before next send...`);
            await new Promise(r => setTimeout(r, TX_SEND_DELAY_MS));
          }
        }
      }

      console.log(`[Phase 4] Sent ${sendResults.length}/${signedTransactions.length} transactions`);

      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 5: Confirm with WebSocket-first strategy (ported from CLI)
      // Uses onSignature() for push notifications, falls back to HTTP polling
      // ═══════════════════════════════════════════════════════════════════════
      console.log('[Phase 5] Confirming with WebSocket-first strategy...');
      let successfulDeposits = 0;

      // Use controlled concurrency with WS-first confirmation
      // Sequential (1) for devnet to prevent self-DDOS
      const confirmResults = await withControlledConcurrency(
        sendResults,
        async ({ index, signature, payload }) => {
          try {
            // Use WebSocket-first confirmation (ported from CLI)
            // This uses onSignature() for push notifications, not polling
            const result = await confirmTransactionWsFirst(signature, 'confirmed');

            if (!result.confirmed) {
              throw new Error(result.error || 'Confirmation failed');
            }

            console.log(`[Phase 5] Transaction ${index + 1} confirmed via ${result.confirmMode} in ${result.durationMs}ms`);
            return { success: true, index, signature, payload };
          } catch (confirmErr) {
            console.error(`[Phase 5] Transaction ${index + 1} confirmation failed:`, confirmErr);
            return { success: false, index, signature, payload, error: confirmErr };
          }
        },
        1 // Sequential for devnet (prevents self-DDOS, WS handles multiplexing)
      );

      // Process confirmed transactions
      // Testnet-only: Add delay between note parses to avoid overwhelming single RPC
      // (isTestnet already defined in Phase 4)
      const NOTE_PARSE_DELAY_MS = 2000; // 2 seconds between note parses on testnet

      for (let i = 0; i < confirmResults.length; i++) {
        const result = confirmResults[i];

        // Testnet only: Wait before parsing each note (after the first one)
        if (isTestnet && i > 0) {
          console.log(`[Testnet] Waiting ${NOTE_PARSE_DELAY_MS}ms before parsing note ${i + 1}...`);
          await new Promise(r => setTimeout(r, NOTE_PARSE_DELAY_MS));
        }

        if (result.success) {
          setProgress({ current: successfulDeposits + 1, total: quantity, status: 'saving' });

          try {
            const note = await processConfirmedDeposit(result.signature, result.payload);

            // Safety net validation - should never fail if retry logic works
            if (note.leafIndex < 0 || !note.rootAfter || note.siblings.length === 0) {
              console.error('CRITICAL: Note validation failed after retries:', {
                leafIndex: note.leafIndex,
                hasRootAfter: !!note.rootAfter,
                siblingsCount: note.siblings.length
              });
              throw new Error(
                `CRITICAL: Note data incomplete after retries. ` +
                `Tx: ${result.signature.slice(0, 8)}... ` +
                `DO NOT CLOSE THIS PAGE. Contact support immediately.`
              );
            }

            // Auto-download note file (also saves to localStorage backup)
            exportNoteToFile(note);
            createdNotes.push(note);

            successfulDeposits++;
            setCompletedCount(successfulDeposits);

          } catch (parseErr: unknown) {
            console.error(`[Phase 5] Failed to parse deposit ${result.index + 1}:`, parseErr);
            const errMsg = parseErr instanceof Error ? parseErr.message : 'Unknown error';
            setError(`Deposit ${result.index + 1} confirmed but note creation failed: ${errMsg}`);
          }
        } else {
          const errMsg = result.error instanceof Error ? result.error.message : 'Confirmation failed';
          setError(`Deposit ${result.index + 1} failed: ${errMsg}`);
        }
      }

      // Notify parent of created notes (for RecentNotes feature)
      if (createdNotes.length > 0 && onNotesCreated) {
        onNotesCreated(createdNotes);
      }

      // Show success modal
      if (successfulDeposits > 0) {
        setShowSuccessModal(true);
        console.log(`\n=== ${successfulDeposits}/${quantity} deposits successful ===`);
      } else {
        setError('All deposits failed. Please try again.');
      }

    } catch (err) {
      console.error('Deposit batch error:', err);
      const errMsg = err instanceof Error ? err.message : 'Deposit failed';

      // If user rejected batch signing, show clear message
      if (errMsg.includes('rejected') || errMsg.includes('cancelled') || errMsg.includes('User rejected')) {
        setError('Deposit cancelled by user');
      } else {
        setError(errMsg);
      }
    } finally {
      // Print RPC diagnostics report
      logRpcEvent('=== DEPOSIT END ===');
      printRpcReport();

      setIsDepositing(false);
      setProgress(null);
    }
  }, [publicKey, signTransaction, signAllTransactions, connection, quantity, onNotesCreated, poolConfig]);

  return (
    <>
      <div className="flex justify-center py-8">
        <Card className="w-full max-w-md">
          {/* Header */}
          <div className="text-center mb-6">
            <h2 className="text-2xl font-semibold text-zk-text mb-2">Private Deposit</h2>
            <p className="text-zk-text-muted text-sm">
              Deposit SOL privately into the anonymity pool
            </p>
          </div>

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
            <label className="block text-zk-text-muted text-sm mb-2">Pool</label>
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
                  {completedCount} note{completedCount > 1 ? 's' : ''} saved to downloads
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

          {/* Info */}
          <p className="text-zk-text-muted text-xs text-center mt-4">
            {quantity > 1
              ? `You will receive ${quantity} secret note files. Keep them safe!`
              : 'You will receive a secret note file. Keep it safe!'
            }
          </p>
        </Card>
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
              {completedCount} Note{completedCount > 1 ? 's' : ''} Saved!
            </h3>
            <p className="text-zk-text-muted text-sm mb-6">
              Your note file{completedCount > 1 ? 's have' : ' has'} been downloaded.
              <br />
              <span className="text-zk-warning">Keep {completedCount > 1 ? 'them' : 'it'} safe - you need {completedCount > 1 ? 'them' : 'it'} to withdraw!</span>
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
