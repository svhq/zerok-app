/**
 * Withdrawal utility for ZeroK web
 *
 * Handles:
 * - Witness building from note data
 * - Proof generation using snarkjs (via Web Worker)
 * - Transaction building with correct account order
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from '@solana/web3.js';
import { Note, PoolConfig } from '@/types/note';
import { getPoolConfig, getOnChainMaxFeeBps, calculateFeeFromBps } from './pool-config';
import {
  serializeProof,
  toBE32,
  u64ToBE32,
  addressToBE32Parts,
} from './sdk/serialization';
import { poseidonHashSingle, fieldToBytesBE, bytesToFieldBE, computeCommitmentFromBigInts } from './sdk/poseidon';
import { getMerklePath } from './daemon-client';
import { isAcceptedRoot } from './root-acceptance';
import type { RootAcceptanceResult } from './protocol-constants';
import { executeWithRotation } from './resilient-connection';
import { confirmTransactionWsFirst } from './ws-confirmation';
import { createComputeBudgetInstructions, WITHDRAW_COMPUTE_UNITS, WITHDRAW_PRIORITY_FEE } from './compute-budget';

// BN254 field modulus - all circuit inputs must be reduced to valid field elements
const BN254_FIELD_MODULUS = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");

// Snarkjs types (loaded dynamically)
interface SnarkjsProof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}

interface SnarkjsPublicSignals {
  [key: string]: string;
}

export interface WithdrawParams {
  note: Note;
  recipient: PublicKey;
  protocol: PublicKey;
  fee: bigint;
  refund?: bigint;
}

export interface WithdrawResult {
  signature: string;
  success: boolean;
}

// Prepared withdrawal data before signing
export interface PreparedWithdrawal {
  transaction: Transaction;
  note: Note;
  nullifierHashBytes: Uint8Array;
  rootBytes: Uint8Array;
}

// Generated proof data (blockhash-independent)
// Used for batch withdrawals: generate all proofs first, then build transactions with fresh blockhash
export interface GeneratedProof {
  proof: Uint8Array;
  nullifierHashBytes: Uint8Array;
  rootBytes: Uint8Array;
  note: Note;
  fee: bigint;
  rootResult?: RootAcceptanceResult; // Where the root was found (for correct shard PDA selection)
}

// Protocol submission data - everything needed to submit to protocol service
// CRITICAL: User never signs. Protocol service signs and submits.
export interface ProtocolSubmissionData {
  poolId: string;
  instruction: TransactionInstruction;
  note: Note;
  nullifierHashBytes: Uint8Array;
  rootBytes: Uint8Array;
  fee: bigint;
}

/**
 * Build withdrawal witness for proof generation
 */
export async function buildWithdrawWitness(
  note: Note,
  recipient: PublicKey,
  protocol: PublicKey,
  fee: bigint,
  refund: bigint = 0n
): Promise<Record<string, string | string[] | number[]>> {
  // Diagnostic logging to help identify problematic notes
  console.log('[buildWithdrawWitness] Processing note:', {
    poolId: note.poolId,
    leafIndex: note.leafIndex,
    commitment: note.commitment?.slice(0, 24) + '...',
    rootAfter: note.rootAfter?.slice(0, 24) + '...',
    siblingsCount: note.siblings?.length,
    createdAt: note.createdAt || 'unknown',
  });

  // Parse note secrets
  const nullifier = BigInt(note.nullifierSecret);
  const secret = BigInt(note.noteSecret);

  // Verify commitment matches what the circuit will compute
  // This catches notes created before the LE→BE encoding fix
  const { commitment: computedCommitmentBytes } = await computeCommitmentFromBigInts(nullifier, secret);
  const computedCommitmentHex = '0x' + Array.from(computedCommitmentBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const storedCommitment = note.commitment;
  const commitmentMatches = computedCommitmentHex.toLowerCase() === storedCommitment?.toLowerCase();

  console.log('[buildWithdrawWitness] Commitment verification:', {
    stored: storedCommitment?.slice(0, 24) + '...',
    computed: computedCommitmentHex.slice(0, 24) + '...',
    match: commitmentMatches,
  });

  if (!commitmentMatches) {
    console.error('[buildWithdrawWitness] ⚠️ COMMITMENT MISMATCH - This note was likely created before the encoding fix and is UNRECOVERABLE');
    console.error('[buildWithdrawWitness] Stored commitment (on-chain):', storedCommitment);
    console.error('[buildWithdrawWitness] Computed commitment (circuit):', computedCommitmentHex);
  }

  // Calculate nullifier hash
  const nullifierBytes = fieldToBytesBE(nullifier);
  const nullifierHashBytes = await poseidonHashSingle(nullifierBytes);
  const nullifierHash = bytesToFieldBE(nullifierHashBytes);

  // Parse root from note (already stored as 0x-prefixed hex)
  const rootHex = note.rootAfter.replace('0x', '');
  let rootBigInt = 0n;
  if (rootHex) {
    rootBigInt = BigInt('0x' + rootHex);
  }

  // Convert siblings to path elements (already 0x-prefixed hex strings)
  // CRITICAL: Apply field modulus reduction to ensure valid BN254 field elements
  // This matches CLI behavior in cli/commands/withdraw.js:hexToFr()
  const pathElements = note.siblings.map(s => {
    const hex = s.replace('0x', '');
    const value = BigInt('0x' + hex);
    return (value % BN254_FIELD_MODULUS).toString();
  });

  // Path indices from leaf index (bit positions)
  const pathIndices: number[] = [];
  let idx = note.leafIndex;
  for (let i = 0; i < 20; i++) {
    pathIndices.push(idx & 1);
    idx >>= 1;
  }

  // Split addresses into high/low field elements
  const [recipientHigh, recipientLow] = addressToBE32Parts(recipient.toBytes());

  // CRITICAL: Match CLI behavior for fee=0 case
  // When fee=0, the on-chain contract expects Pubkey::default() (all zeros) for the protocol
  // in the ZK proof's public inputs
  const protocolForProof = fee === 0n ? PublicKey.default : protocol;
  const [protocolHigh, protocolLow] = addressToBE32Parts(protocolForProof.toBytes());

  return {
    // Private inputs
    nullifier: nullifier.toString(),
    secret: secret.toString(),
    pathElements,
    pathIndices,

    // Public inputs
    root: rootBigInt.toString(),
    nullifierHash: nullifierHash.toString(),
    recipientHigh: recipientHigh.toString(),
    recipientLow: recipientLow.toString(),
    protocolHigh: protocolHigh.toString(),
    protocolLow: protocolLow.toString(),
    fee: fee.toString(),
    refund: refund.toString(),
  };
}

/**
 * Generate ZK proof using snarkjs
 * This runs in the browser's main thread - consider using a Web Worker for better UX
 */
export async function generateProof(
  witness: Record<string, string | string[] | number[]>
): Promise<{ proof: Uint8Array; publicSignals: string[] }> {
  // Load snarkjs dynamically (it's a large library)
  const snarkjs = await import('snarkjs');

  // Fetch circuit artifacts
  const wasmUrl = '/artifacts/withdraw.wasm';
  const zkeyUrl = '/artifacts/withdraw_final.zkey';

  console.log('[withdrawal] Generating ZK proof...');

  // Generate proof
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    witness,
    wasmUrl,
    zkeyUrl
  );

  console.log('Proof generated successfully');
  console.log('Public signals:', publicSignals);

  // Serialize proof for on-chain verification
  const serializedProof = serializeProof(proof as SnarkjsProof);

  return { proof: serializedProof, publicSignals: publicSignals as string[] };
}

/**
 * Compute which shard contains the root for a given leaf index
 * Matches CLI logic in shard-manager.js:globalToShardIndex
 */
function computeShardIndex(leafIndex: number): number {
  const TOTAL_CAPACITY = 2560;  // 20 shards × 128 entries
  const SHARD_CAPACITY = 128;
  const normalizedIndex = leafIndex % TOTAL_CAPACITY;
  return Math.floor(normalizedIndex / SHARD_CAPACITY);
}

/**
 * Derive nullifier PDA using pool config
 */
export function deriveNullifierPda(nullifierHash: Uint8Array, poolConfig: PoolConfig): [PublicKey, number] {
  const programId = new PublicKey(poolConfig.programId);
  const statePda = new PublicKey(poolConfig.statePda);

  return PublicKey.findProgramAddressSync(
    [Buffer.from('nullifier'), statePda.toBuffer(), nullifierHash],
    programId
  );
}

/**
 * Build withdrawal transaction using note's pool config
 *
 * @param rootResult - Result from isAcceptedRoot() indicating where the root was found.
 *                     If source='sharded_ring', includes the shard PDA in remaining_accounts.
 *                     If source='state_history', no shard needed (checked first on-chain).
 */
export async function buildWithdrawTransaction(
  connection: Connection,
  payer: PublicKey,
  note: Note,
  recipient: PublicKey,
  protocol: PublicKey,
  fee: bigint,
  proof: Uint8Array,
  nullifierHashBytes: Uint8Array,
  rootBytes: Uint8Array,
  rootResult?: RootAcceptanceResult
): Promise<Transaction> {
  // Get pool config from note's poolId
  const poolConfig = getPoolConfig(note.poolId);

  const programId = new PublicKey(poolConfig.programId);
  const statePda = new PublicKey(poolConfig.statePda);
  const vaultPda = new PublicKey(poolConfig.vaultPda);
  const vkPda = new PublicKey(poolConfig.vkPda);
  const metadataPda = new PublicKey(poolConfig.metadataPda);

  // Derive nullifier PDA
  const [nullifierPda] = deriveNullifierPda(nullifierHashBytes, poolConfig);

  // Compute instruction discriminator: sha256("global:withdraw_v2_clean")[0..8]
  const preimage = 'global:withdraw_v2_clean';
  const encoder = new TextEncoder();
  const encoded = encoder.encode(preimage);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded.buffer as ArrayBuffer);
  const discriminatorBytes = new Uint8Array(hashBuffer).slice(0, 8);

  // Build instruction data:
  // - 8 bytes: discriminator
  // - 32 bytes: nullifier_hash
  // - 4 bytes: proof length (u32 LE)
  // - 256 bytes: proof
  // - 32 bytes: root
  // - 8 bytes: fee (u64 LE)
  // - 8 bytes: refund (u64 LE)
  const instructionData = new Uint8Array(8 + 32 + 4 + 256 + 32 + 8 + 8);
  let offset = 0;

  // Discriminator
  instructionData.set(discriminatorBytes, offset);
  offset += 8;

  // Nullifier hash (32 bytes)
  instructionData.set(nullifierHashBytes, offset);
  offset += 32;

  // Proof length (256 as u32 LE)
  instructionData[offset] = 0;
  instructionData[offset + 1] = 1; // 256 = 0x0100
  instructionData[offset + 2] = 0;
  instructionData[offset + 3] = 0;
  offset += 4;

  // Proof (256 bytes)
  instructionData.set(proof, offset);
  offset += 256;

  // Root (32 bytes)
  instructionData.set(rootBytes, offset);
  offset += 32;

  // Fee (u64 LE)
  const feeView = new DataView(instructionData.buffer, offset, 8);
  feeView.setBigUint64(0, fee, true);
  offset += 8;

  // Refund (u64 LE) - always 0 for now
  const refundView = new DataView(instructionData.buffer, offset, 8);
  refundView.setBigUint64(0, 0n, true);

  // Build account list matching WithdrawV2Clean struct order:
  // 1. pool_state (mut)
  // 2. vk_pda
  // 3. nullifier_record (mut)
  // 4. vault (mut)
  // 5. recipient (mut)
  // 6. protocol (mut)
  // 7. payer (signer, mut)
  // 8. system_program
  // 9. root_ring (legacy, pass program_id as placeholder)
  // 10. root_ring_metadata
  // 11+ remaining_accounts: shard PDAs (only if root found in sharded_ring)

  // Determine which shard PDA to include based on rootResult
  // - If root is in state_history: no shard needed (state check happens first on-chain)
  // - If root is in sharded_ring: include the specific shard that contains the root
  // - If root not found (daemon path): include shard computed from leaf index as fallback
  let targetShardPda: PublicKey | null = null;

  if (rootResult?.source === 'sharded_ring' && rootResult.shardIndex !== undefined) {
    // Root found in specific shard - include that shard PDA
    targetShardPda = new PublicKey(poolConfig.shardPdas[rootResult.shardIndex]);
    console.log(`[withdrawal] Root in sharded_ring[${rootResult.shardIndex}], including shard PDA`);
  } else if (rootResult?.source === 'state_history') {
    // Root in state_history - no shard needed
    console.log('[withdrawal] Root in state_history, no shard PDA needed');
  } else {
    // Fallback: daemon provided fresh path, compute shard from leaf index
    const shardIndex = computeShardIndex(note.leafIndex);
    targetShardPda = new PublicKey(poolConfig.shardPdas[shardIndex]);
    console.log(`[withdrawal] Using fallback shard ${shardIndex} for daemon path (leafIndex: ${note.leafIndex})`);
  }

  // CRITICAL: Match CLI behavior for fee=0 case
  // When fee=0, use payer as the protocol account (not PublicKey.default() because
  // it's the System Program and can't be mutable)
  const protocolAccountForTx = fee === 0n ? payer : protocol;

  // Build keys array - base accounts first
  const keys = [
    { pubkey: statePda, isSigner: false, isWritable: true },
    { pubkey: vkPda, isSigner: false, isWritable: false },
    { pubkey: nullifierPda, isSigner: false, isWritable: true },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: recipient, isSigner: false, isWritable: true },
    { pubkey: protocolAccountForTx, isSigner: false, isWritable: true },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: programId, isSigner: false, isWritable: false }, // root_ring placeholder (legacy)
    { pubkey: metadataPda, isSigner: false, isWritable: false }, // root_ring_metadata
  ];

  // Add shard PDA to remaining_accounts only if needed
  if (targetShardPda) {
    keys.push({ pubkey: targetShardPda, isSigner: false, isWritable: false });
  }

  const withdrawIx = new TransactionInstruction({
    programId,
    keys,
    data: Buffer.from(instructionData),
  });

  // Build transaction with ComputeBudget instructions first
  // This tells the wallet exactly what compute/priority to expect,
  // reducing wallet "guesswork" and potentially speeding up signing preview
  const transaction = new Transaction();
  transaction.add(...createComputeBudgetInstructions(WITHDRAW_COMPUTE_UNITS, WITHDRAW_PRIORITY_FEE));
  transaction.add(withdrawIx);

  // Get recent blockhash (use executeWithRotation for Helius with high rate limits)
  const { blockhash } = await executeWithRotation(
    (conn) => conn.getLatestBlockhash('confirmed')
  );
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = payer;

  return transaction;
}

/**
 * Generate withdrawal proof only (blockhash-independent)
 *
 * This is the slow part (~30s per note). For batch withdrawals:
 * 1. Call generateWithdrawProof() for each note (slow, with delays between)
 * 2. Get fresh blockhash AFTER all proofs done
 * 3. Call buildTransactionFromProof() for each proof (fast)
 * 4. Sign all transactions at once (single wallet popup)
 */
export async function generateWithdrawProof(
  connection: Connection,
  note: Note,
  recipient: PublicKey,
  protocol: PublicKey,
  onProgress?: (status: string) => void
): Promise<GeneratedProof> {
  // Get pool config from note's poolId
  const poolConfig = getPoolConfig(note.poolId);
  const denomination = BigInt(poolConfig.denominationLamports);

  // Read max_fee_bps from on-chain state to ensure fee matches pool's actual limit
  const maxFeeBps = await getOnChainMaxFeeBps(poolConfig.statePda);
  const fee = calculateFeeFromBps(denomination, maxFeeBps);
  console.log(`[withdrawal] Using on-chain max_fee_bps: ${maxFeeBps} (fee: ${fee} lamports)`);

  onProgress?.('Checking if root is in on-chain ring buffer...');

  // Ring-first architecture: check on-chain ring buffer before calling daemon
  // Use isAcceptedRoot() to get the full result including shardIndex
  let freshRoot = note.rootAfter;
  let freshSiblings = note.siblings;

  const rootResult = await isAcceptedRoot(connection, poolConfig, note.rootAfter);

  if (rootResult.found) {
    onProgress?.('Root found in on-chain ring buffer');
    console.log(`[withdrawal] Root in ${rootResult.source}, using note data directly: ${freshRoot.slice(0, 16)}...`);
  } else {
    onProgress?.('Root aged out, fetching fresh path from daemon...');
    console.log('[withdrawal] Root not in ring, calling daemon for fresh path...');
    const daemonPath = await getMerklePath(note.poolId, note.commitment);
    freshRoot = daemonPath.root;
    freshSiblings = daemonPath.pathElements;
    console.log(`[withdrawal] Using fresh root from daemon: ${freshRoot.slice(0, 16)}...`);
  }

  onProgress?.('Building witness...');

  // Build witness with refreshed path data
  const refreshedNote = { ...note, rootAfter: freshRoot, siblings: freshSiblings };
  const witness = await buildWithdrawWitness(refreshedNote, recipient, protocol, fee);

  onProgress?.('Generating ZK proof...');

  // Generate proof (slow, ~30s)
  const { proof } = await generateProof(witness);

  // Extract nullifier hash from witness (as bytes)
  const nullifierHashBigInt = BigInt(witness.nullifierHash as string);
  const nullifierHashBytes = toBE32(nullifierHashBigInt);

  // Extract root (as bytes)
  const rootHex = freshRoot.replace('0x', '');
  const rootBigInt = rootHex ? BigInt('0x' + rootHex) : 0n;
  const rootBytes = toBE32(rootBigInt);

  onProgress?.('Proof generated!');

  return {
    proof,
    nullifierHashBytes,
    rootBytes,
    note,
    fee,
    rootResult: rootResult.found ? rootResult : undefined,
  };
}

/**
 * Build transaction from pre-generated proof (fast, needs fresh blockhash)
 *
 * Call this AFTER all proofs are generated, with a fresh blockhash.
 */
export async function buildTransactionFromProof(
  generatedProof: GeneratedProof,
  recipient: PublicKey,
  protocol: PublicKey,
  payer: PublicKey,
  blockhash: string
): Promise<PreparedWithdrawal> {
  const { proof, nullifierHashBytes, rootBytes, note, fee, rootResult } = generatedProof;

  // Build transaction with the fresh blockhash, passing rootResult for correct shard PDA selection
  const transaction = await buildWithdrawTransactionWithBlockhash(
    payer,
    note,
    recipient,
    protocol,
    fee,
    proof,
    nullifierHashBytes,
    rootBytes,
    blockhash,
    rootResult
  );

  return {
    transaction,
    note,
    nullifierHashBytes,
    rootBytes,
  };
}

/**
 * Prepare a withdrawal (build witness, generate proof, build transaction) without signing
 * Used for batch signing with signAllTransactions
 */
export async function prepareWithdraw(
  connection: Connection,
  note: Note,
  recipient: PublicKey,
  protocol: PublicKey,
  payer: PublicKey,
  blockhash: string,
  onProgress?: (status: string) => void
): Promise<PreparedWithdrawal> {
  // Get pool config from note's poolId
  const poolConfig = getPoolConfig(note.poolId);
  const denomination = BigInt(poolConfig.denominationLamports);

  // Read max_fee_bps from on-chain state to ensure fee matches pool's actual limit
  const maxFeeBps = await getOnChainMaxFeeBps(poolConfig.statePda);
  const fee = calculateFeeFromBps(denomination, maxFeeBps);
  console.log(`[withdrawal] Using on-chain max_fee_bps: ${maxFeeBps} (fee: ${fee} lamports)`);

  onProgress?.('Checking if root is in on-chain ring buffer...');

  // Ring-first architecture: check on-chain ring buffer before calling daemon
  // Use isAcceptedRoot() to get the full result including shardIndex
  let freshRoot = note.rootAfter;
  let freshSiblings = note.siblings;

  const rootResult = await isAcceptedRoot(connection, poolConfig, note.rootAfter);

  if (rootResult.found) {
    // Root found in ring buffer - use note data directly (no daemon call!)
    onProgress?.('Root found in on-chain ring buffer');
    console.log(`[withdrawal] ✅ Root in ${rootResult.source}, using note data directly: ${freshRoot.slice(0, 16)}...`);
  } else {
    // Root aged out - call daemon for fresh path
    onProgress?.('Root aged out, fetching fresh path from daemon...');
    console.log('[withdrawal] Root not in ring, calling daemon for fresh path...');
    const daemonPath = await getMerklePath(note.poolId, note.commitment);
    freshRoot = daemonPath.root;
    freshSiblings = daemonPath.pathElements;
    console.log(`[withdrawal] Using fresh root from daemon: ${freshRoot.slice(0, 16)}...`);
  }

  onProgress?.('Building witness...');

  // Build witness with refreshed path data
  const refreshedNote = { ...note, rootAfter: freshRoot, siblings: freshSiblings };
  const witness = await buildWithdrawWitness(refreshedNote, recipient, protocol, fee);

  onProgress?.('Generating ZK proof...');

  // Generate proof
  const { proof } = await generateProof(witness);

  // Extract nullifier hash from witness (as bytes)
  const nullifierHashBigInt = BigInt(witness.nullifierHash as string);
  const nullifierHashBytes = toBE32(nullifierHashBigInt);

  // Extract root (as bytes) - use the fresh root from daemon
  const rootHex = freshRoot.replace('0x', '');
  const rootBigInt = rootHex ? BigInt('0x' + rootHex) : 0n;
  const rootBytes = toBE32(rootBigInt);

  onProgress?.('Building transaction...');

  // Build transaction with provided blockhash, passing rootResult for correct shard PDA selection
  const transaction = await buildWithdrawTransactionWithBlockhash(
    payer,
    note,
    recipient,
    protocol,
    fee,
    proof,
    nullifierHashBytes,
    rootBytes,
    blockhash,
    rootResult.found ? rootResult : undefined
  );

  return {
    transaction,
    note,
    nullifierHashBytes,
    rootBytes,
  };
}

/**
 * Build withdrawal transaction with specific blockhash (for batch signing)
 *
 * @param rootResult - Result from isAcceptedRoot() indicating where the root was found.
 *                     Used to determine which shard PDA to include (if any).
 */
async function buildWithdrawTransactionWithBlockhash(
  payer: PublicKey,
  note: Note,
  recipient: PublicKey,
  protocol: PublicKey,
  fee: bigint,
  proof: Uint8Array,
  nullifierHashBytes: Uint8Array,
  rootBytes: Uint8Array,
  blockhash: string,
  rootResult?: RootAcceptanceResult
): Promise<Transaction> {
  // Get pool config from note's poolId
  const poolConfig = getPoolConfig(note.poolId);

  const programId = new PublicKey(poolConfig.programId);
  const statePda = new PublicKey(poolConfig.statePda);
  const vaultPda = new PublicKey(poolConfig.vaultPda);
  const vkPda = new PublicKey(poolConfig.vkPda);
  const metadataPda = new PublicKey(poolConfig.metadataPda);

  // Derive nullifier PDA
  const [nullifierPda] = deriveNullifierPda(nullifierHashBytes, poolConfig);

  // Compute instruction discriminator: sha256("global:withdraw_v2_clean")[0..8]
  const preimage = 'global:withdraw_v2_clean';
  const encoder = new TextEncoder();
  const encoded = encoder.encode(preimage);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded.buffer as ArrayBuffer);
  const discriminatorBytes = new Uint8Array(hashBuffer).slice(0, 8);

  // Build instruction data
  const instructionData = new Uint8Array(8 + 32 + 4 + 256 + 32 + 8 + 8);
  let offset = 0;

  instructionData.set(discriminatorBytes, offset);
  offset += 8;
  instructionData.set(nullifierHashBytes, offset);
  offset += 32;
  instructionData[offset] = 0;
  instructionData[offset + 1] = 1;
  instructionData[offset + 2] = 0;
  instructionData[offset + 3] = 0;
  offset += 4;
  instructionData.set(proof, offset);
  offset += 256;
  instructionData.set(rootBytes, offset);
  offset += 32;

  const feeView = new DataView(instructionData.buffer, offset, 8);
  feeView.setBigUint64(0, fee, true);
  offset += 8;
  const refundView = new DataView(instructionData.buffer, offset, 8);
  refundView.setBigUint64(0, 0n, true);

  // Determine which shard PDA to include based on rootResult
  let targetShardPda: PublicKey | null = null;

  if (rootResult?.source === 'sharded_ring' && rootResult.shardIndex !== undefined) {
    targetShardPda = new PublicKey(poolConfig.shardPdas[rootResult.shardIndex]);
    console.log(`[withdrawal] Root in sharded_ring[${rootResult.shardIndex}], including shard PDA`);
  } else if (rootResult?.source === 'state_history') {
    console.log('[withdrawal] Root in state_history, no shard PDA needed');
  } else {
    // Fallback: daemon provided fresh path
    const shardIndex = computeShardIndex(note.leafIndex);
    targetShardPda = new PublicKey(poolConfig.shardPdas[shardIndex]);
    console.log(`[withdrawal] Using fallback shard ${shardIndex} for daemon path`);
  }

  // Log instruction details for debugging
  console.log('[withdrawal] Discriminator:', Array.from(discriminatorBytes).map(b => b.toString(16).padStart(2, '0')).join(''));
  console.log('[withdrawal] Root bytes:', Array.from(rootBytes.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('') + '...');

  // CRITICAL: Match CLI behavior for fee=0 case
  // When fee=0, use payer as the protocol account (not PublicKey.default() because
  // it's the System Program and can't be mutable)
  const protocolAccountForTx = fee === 0n ? payer : protocol;

  // Build keys array - base accounts first
  const keys = [
    { pubkey: statePda, isSigner: false, isWritable: true },      // 1. pool_state
    { pubkey: vkPda, isSigner: false, isWritable: false },        // 2. vk_pda
    { pubkey: nullifierPda, isSigner: false, isWritable: true },  // 3. nullifier_record
    { pubkey: vaultPda, isSigner: false, isWritable: true },      // 4. vault
    { pubkey: recipient, isSigner: false, isWritable: true },     // 5. recipient
    { pubkey: protocolAccountForTx, isSigner: false, isWritable: true },       // 6. protocol
    { pubkey: payer, isSigner: true, isWritable: true },          // 7. payer (signer)
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 8. system_program
    { pubkey: programId, isSigner: false, isWritable: false },    // 9. root_ring (placeholder)
    { pubkey: metadataPda, isSigner: false, isWritable: false },  // 10. root_ring_metadata
  ];

  // Add shard PDA to remaining_accounts only if needed
  if (targetShardPda) {
    keys.push({ pubkey: targetShardPda, isSigner: false, isWritable: false });
  }

  const withdrawIx = new TransactionInstruction({
    programId,
    keys,
    data: Buffer.from(instructionData),
  });

  // Build transaction with ComputeBudget instructions first
  // ZK verification uses ~300k CU, set 400k with buffer
  const transaction = new Transaction();
  transaction.add(...createComputeBudgetInstructions(WITHDRAW_COMPUTE_UNITS, WITHDRAW_PRIORITY_FEE));
  transaction.add(withdrawIx);
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = payer;

  return transaction;
}

/**
 * Build withdrawal instruction for protocol service submission.
 *
 * CRITICAL PRIVACY INVARIANT:
 * This builds ONLY the instruction - no transaction, no blockhash, no payer.
 * The protocol service will:
 * 1. Validate the instruction
 * 2. Build the transaction with its own wallet as payer/signer
 * 3. Sign with the protocol wallet
 * 4. Submit to the network
 *
 * The user's wallet NEVER signs withdrawal transactions.
 *
 * @param note - Note to withdraw
 * @param recipient - Recipient address (any wallet, for privacy use fresh)
 * @param protocol - Protocol public key (from config)
 * @param fee - Fee in lamports
 * @param proof - Generated proof bytes
 * @param nullifierHashBytes - Nullifier hash as bytes
 * @param rootBytes - Root as bytes
 * @param rootResult - Where the root was found (for shard selection)
 * @returns TransactionInstruction ready for protocol submission
 */
export async function buildWithdrawInstruction(
  note: Note,
  recipient: PublicKey,
  protocol: PublicKey,
  fee: bigint,
  proof: Uint8Array,
  nullifierHashBytes: Uint8Array,
  rootBytes: Uint8Array,
  rootResult?: RootAcceptanceResult
): Promise<TransactionInstruction> {
  // Get pool config from note's poolId
  const poolConfig = getPoolConfig(note.poolId);

  const programId = new PublicKey(poolConfig.programId);
  const statePda = new PublicKey(poolConfig.statePda);
  const vaultPda = new PublicKey(poolConfig.vaultPda);
  const vkPda = new PublicKey(poolConfig.vkPda);
  const metadataPda = new PublicKey(poolConfig.metadataPda);

  // Derive nullifier PDA
  const [nullifierPda] = deriveNullifierPda(nullifierHashBytes, poolConfig);

  // Compute instruction discriminator: sha256("global:withdraw_v2_clean")[0..8]
  const preimage = 'global:withdraw_v2_clean';
  const encoder = new TextEncoder();
  const encoded = encoder.encode(preimage);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded.buffer as ArrayBuffer);
  const discriminatorBytes = new Uint8Array(hashBuffer).slice(0, 8);

  // Build instruction data
  const instructionData = new Uint8Array(8 + 32 + 4 + 256 + 32 + 8 + 8);
  let offset = 0;

  instructionData.set(discriminatorBytes, offset);
  offset += 8;
  instructionData.set(nullifierHashBytes, offset);
  offset += 32;
  instructionData[offset] = 0;
  instructionData[offset + 1] = 1;
  instructionData[offset + 2] = 0;
  instructionData[offset + 3] = 0;
  offset += 4;
  instructionData.set(proof, offset);
  offset += 256;
  instructionData.set(rootBytes, offset);
  offset += 32;

  const feeView = new DataView(instructionData.buffer, offset, 8);
  feeView.setBigUint64(0, fee, true);
  offset += 8;
  const refundView = new DataView(instructionData.buffer, offset, 8);
  refundView.setBigUint64(0, 0n, true);

  // Determine which shard PDA to include based on rootResult
  let targetShardPda: PublicKey | null = null;

  if (rootResult?.source === 'sharded_ring' && rootResult.shardIndex !== undefined) {
    targetShardPda = new PublicKey(poolConfig.shardPdas[rootResult.shardIndex]);
    console.log(`[withdrawal/instruction] Root in sharded_ring[${rootResult.shardIndex}], including shard PDA`);
  } else if (rootResult?.source === 'state_history') {
    console.log('[withdrawal/instruction] Root in state_history, no shard PDA needed');
  } else {
    // Fallback: daemon provided fresh path
    const shardIndex = computeShardIndex(note.leafIndex);
    targetShardPda = new PublicKey(poolConfig.shardPdas[shardIndex]);
    console.log(`[withdrawal/instruction] Using fallback shard ${shardIndex} for daemon path`);
  }

  // CRITICAL: For protocol submission, the protocol wallet is BOTH:
  // - Account[5] (protocol - receives fee)
  // - Account[6] (payer - signs and pays tx fees)
  // The protocol service validates this and replaces the signer.
  //
  // When fee=0, we still use protocol (not PublicKey.default) because
  // the protocol service validates that account[5] and account[6] match its wallet.
  const protocolAccountForTx = protocol;

  // Build keys array
  // IMPORTANT: The protocol service validates that:
  // - Account[0] matches pool statePda
  // - Account[1] matches pool vkPda
  // - Account[3] matches pool vaultPda
  // - Account[5] (protocol) matches the protocol service's wallet
  // - Account[6] (payer) matches the protocol service's wallet
  const keys = [
    { pubkey: statePda, isSigner: false, isWritable: true },      // 0. pool_state
    { pubkey: vkPda, isSigner: false, isWritable: false },        // 1. vk_pda
    { pubkey: nullifierPda, isSigner: false, isWritable: true },  // 2. nullifier_record
    { pubkey: vaultPda, isSigner: false, isWritable: true },      // 3. vault
    { pubkey: recipient, isSigner: false, isWritable: true },     // 4. recipient
    { pubkey: protocolAccountForTx, isSigner: false, isWritable: true },  // 5. protocol (receives fee)
    { pubkey: protocol, isSigner: true, isWritable: true },       // 6. payer (protocol signs)
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 7. system_program
    { pubkey: programId, isSigner: false, isWritable: false },    // 8. root_ring (placeholder)
    { pubkey: metadataPda, isSigner: false, isWritable: false },  // 9. root_ring_metadata
  ];

  // Add shard PDA to remaining_accounts only if needed
  if (targetShardPda) {
    keys.push({ pubkey: targetShardPda, isSigner: false, isWritable: false });
  }

  return new TransactionInstruction({
    programId,
    keys,
    data: Buffer.from(instructionData),
  });
}

/**
 * Generate withdrawal proof and build instruction for protocol submission.
 *
 * CRITICAL PRIVACY INVARIANT:
 * This is the ONLY way to perform withdrawals. User never signs.
 *
 * @returns ProtocolSubmissionData ready to submit via protocol-client.ts
 */
export async function prepareWithdrawalForProtocol(
  connection: Connection,
  note: Note,
  recipient: PublicKey,
  protocol: PublicKey,
  onProgress?: (status: string) => void
): Promise<ProtocolSubmissionData> {
  // Get pool config from note's poolId
  const poolConfig = getPoolConfig(note.poolId);
  const denomination = BigInt(poolConfig.denominationLamports);

  // Read max_fee_bps from on-chain state to ensure fee matches pool's actual limit
  const maxFeeBps = await getOnChainMaxFeeBps(poolConfig.statePda);
  const fee = calculateFeeFromBps(denomination, maxFeeBps);
  console.log(`[withdrawal/protocol] Using on-chain max_fee_bps: ${maxFeeBps} (fee: ${fee} lamports)`);

  onProgress?.('Checking if root is in on-chain ring buffer...');

  // Ring-first architecture: check on-chain ring buffer before calling daemon
  let freshRoot = note.rootAfter;
  let freshSiblings = note.siblings;

  const rootResult = await isAcceptedRoot(connection, poolConfig, note.rootAfter);

  if (rootResult.found) {
    onProgress?.('Root found in on-chain ring buffer');
    console.log(`[withdrawal/protocol] Root in ${rootResult.source}, using note data directly: ${freshRoot.slice(0, 16)}...`);
  } else {
    onProgress?.('Root aged out, fetching fresh path from daemon...');
    console.log('[withdrawal/protocol] Root not in ring, calling daemon for fresh path...');
    const daemonPath = await getMerklePath(note.poolId, note.commitment);
    freshRoot = daemonPath.root;
    freshSiblings = daemonPath.pathElements;
    console.log(`[withdrawal/protocol] Using fresh root from daemon: ${freshRoot.slice(0, 16)}...`);
  }

  onProgress?.('Building witness...');

  // Build witness with refreshed path data
  const refreshedNote = { ...note, rootAfter: freshRoot, siblings: freshSiblings };
  const witness = await buildWithdrawWitness(refreshedNote, recipient, protocol, fee);

  onProgress?.('Generating ZK proof...');

  // Generate proof (slow, ~30s)
  const { proof } = await generateProof(witness);

  // Extract nullifier hash from witness (as bytes)
  const nullifierHashBigInt = BigInt(witness.nullifierHash as string);
  const nullifierHashBytes = toBE32(nullifierHashBigInt);

  // Extract root (as bytes)
  const rootHex = freshRoot.replace('0x', '');
  const rootBigInt = rootHex ? BigInt('0x' + rootHex) : 0n;
  const rootBytes = toBE32(rootBigInt);

  onProgress?.('Building instruction for protocol...');

  // Build instruction (NO TRANSACTION - protocol service handles that)
  const instruction = await buildWithdrawInstruction(
    note,
    recipient,
    protocol,
    fee,
    proof,
    nullifierHashBytes,
    rootBytes,
    rootResult.found ? rootResult : undefined
  );

  onProgress?.('Ready for protocol submission');

  return {
    poolId: note.poolId,
    instruction,
    note,
    nullifierHashBytes,
    rootBytes,
    fee,
  };
}

/**
 * @deprecated PRIVACY VIOLATION - DO NOT USE
 *
 * This function allowed user wallets to sign withdrawal transactions,
 * which LINKS the user's wallet to the withdrawal and destroys anonymity.
 *
 * CRITICAL PRIVACY INVARIANT:
 * User wallets MUST NEVER sign withdrawal transactions.
 * All withdrawals MUST go through the protocol service.
 *
 * Use instead:
 *   1. prepareWithdrawalForProtocol() - generates proof and instruction
 *   2. submitWithdrawalToProtocol() - from protocol-client.ts
 *
 * See: WithdrawBar.tsx for the correct protocol-only flow.
 *
 * @throws Always throws to prevent privacy violations
 */
export async function executeWithdraw(
  _connection: Connection,
  _signTransaction: (tx: Transaction) => Promise<Transaction>,
  _note: Note,
  _recipient: PublicKey,
  _protocol: PublicKey,
  _onProgress?: (status: string) => void
): Promise<WithdrawResult> {
  throw new Error(
    'PRIVACY VIOLATION: executeWithdraw() is deprecated and has been disabled. ' +
    'User wallets must NEVER sign withdrawal transactions as this links the wallet to the withdrawal. ' +
    'Use prepareWithdrawalForProtocol() + submitWithdrawalToProtocol() instead. ' +
    'See WithdrawBar.tsx for the correct protocol-only withdrawal flow.'
  );
}
