/**
 * ZeroK v2 JoinSplit Withdrawal (Browser Adapter)
 *
 * Uses shared core for witness building, proof serialization, and fee calculation.
 * Browser-specific: snarkjs with URL paths, WebCrypto memo encryption, relay URL detection.
 */

import { PublicKey, Connection } from '@solana/web3.js';
import { initPoseidon } from './sdk/poseidon';
import { V2Note } from '@/types/note';

// ── Shared core imports ──────────────────────────────────────────────────────

// @ts-ignore
import { buildJoinSplitWitness } from 'v2-core/witness';
// @ts-ignore
import { serializeProof } from 'v2-core/proof-serialize';
// @ts-ignore
import { calculateRelayFee } from 'v2-core/fee';
// @ts-ignore
import { fieldToBytesBE, uint8ToBase64, hexToBytes } from 'v2-core/field';
// @ts-ignore
import { isRootInHistory as coreIsRootInHistory } from 'v2-core/merkle';

import { deriveV2PoolPDAs, getRelayUrl } from './v2-config';

// ── Denomination labels (browser UI) ─────────────────────────────────────────

export const V2_DENOMINATIONS: Array<{ label: string; lamports: bigint }> = [
  { label: '0.1 SOL', lamports: 100_000_000n },
  { label: '1 SOL',   lamports: 1_000_000_000n },
  { label: '10 SOL',  lamports: 10_000_000_000n },
  { label: '100 SOL', lamports: 100_000_000_000n },
  { label: '1000 SOL', lamports: 1_000_000_000_000n },
];

export function computeV2Fee(amount: bigint): bigint {
  return calculateRelayFee(amount);
}

// ── Root history check ───────────────────────────────────────────────────────

/**
 * Check if the note's stored Merkle root is still in the pool's 256-entry ring buffer.
 * If true, the stored pathElements can be used directly without any tree rebuild.
 */
export async function checkRootInHistory(
  note: V2Note,
  connection: Connection,
): Promise<boolean> {
  if (!note.merkleRoot || note.pathElements.length === 0) return false;
  try {
    const denom = BigInt(note.amount);
    const { statePda } = deriveV2PoolPDAs(denom);
    const info = await connection.getAccountInfo(statePda);
    if (!info) return false;
    return coreIsRootInHistory(note.merkleRoot, new Uint8Array(info.data));
  } catch {
    return false;
  }
}

// ── Proof generation (browser-specific: URL paths for circuit artifacts) ─────

async function generateV2Proof(
  witness: Record<string, string | string[]>
): Promise<Uint8Array> {
  const snarkjs = await import('snarkjs');
  const { proof } = await snarkjs.groth16.fullProve(
    witness,
    '/artifacts/v2/withdraw.wasm',
    '/artifacts/v2/withdraw_final.zkey',
  );
  return serializeProof(proof as { pi_a: string[]; pi_b: string[][]; pi_c: string[] });
}

// ── Change note memo encryption (browser-specific: WebCrypto) ────────────────

async function encryptChangeNoteMemo(
  changeNote: { amount: string; nullifier: string; secret: string },
  encKey: CryptoKey,
): Promise<string> {
  const toBase64Field = (decimal: string) =>
    btoa(String.fromCharCode(...fieldToBytesBE(BigInt(decimal))));

  const payload = JSON.stringify({
    n: toBase64Field(changeNote.nullifier),
    s: toBase64Field(changeNote.secret),
    a: changeNote.amount,
  });

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(payload);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    encKey,
    encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer,
  );
  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), 12);
  return btoa(String.fromCharCode(...combined));
}

// ── Full withdrawal flow ─────────────────────────────────────────────────────

export interface V2WithdrawParams {
  note: V2Note;
  withdrawalAmount: bigint;
  recipient: PublicKey;
  relayerPubkey: PublicKey;
  encKey: CryptoKey;
  onProgress?: (status: string) => void;
}

export interface V2WithdrawResult {
  signature: string;
  changeNote: { amount: string; nullifier: string; secret: string };
  outCommitmentBigInt: bigint;
}

export async function executeV2Withdrawal(params: V2WithdrawParams): Promise<V2WithdrawResult> {
  const { note, withdrawalAmount, recipient, relayerPubkey, encKey, onProgress } = params;
  const t0 = performance.now();
  const elapsed = () => ((performance.now() - t0) / 1000).toFixed(1) + 's';

  // 1. Build witness using SHARED CORE (same as CLI)
  onProgress?.('Building JoinSplit witness…');
  console.log(`[Withdraw] ${elapsed()} — Step 1: Init poseidon...`);
  const poseidon = await initPoseidon();
  console.log(`[Withdraw] ${elapsed()} — Poseidon ready`);
  const fee = calculateRelayFee(withdrawalAmount);

  console.log(`[Withdraw] ${elapsed()} — Building witness...`);
  const { witness, changeNote, nullifierHash, outCommitment } =
    buildJoinSplitWitness(poseidon, {
      inputNote: note,
      merkleRoot: note.merkleRoot,
      withdrawalAmount,
      feeAmount: fee,
      recipientBytes: recipient.toBytes(),
      relayerBytes: relayerPubkey.toBytes(),
    });
  console.log(`[Withdraw] ${elapsed()} — Step 1 done: witness built`);

  // 2. Generate proof (browser-specific: URL paths)
  onProgress?.('Generating ZK proof…');
  console.log(`[Withdraw] ${elapsed()} — Step 2: Loading snarkjs + circuit artifacts...`);
  const proofBytes = await generateV2Proof(witness);
  console.log(`[Withdraw] ${elapsed()} — Step 2 done: proof generated (${proofBytes.length} bytes)`);

  // 3. Encrypt change note memo (browser-specific: WebCrypto)
  onProgress?.('Encrypting change note…');
  console.log(`[Withdraw] ${elapsed()} — Step 3: Encrypting memo...`);
  const encryptedBlob = await encryptChangeNoteMemo(changeNote, encKey);
  const memoText = `zerok:v2:${encryptedBlob}`;
  console.log(`[Withdraw] ${elapsed()} — Step 3 done: memo encrypted`);

  // 4. Submit to relay
  const relayUrl = getRelayUrl();
  onProgress?.('Submitting to relay…');
  console.log(`[Withdraw] ${elapsed()} — Step 4: Submitting to relay (${relayUrl.replace(/api-key=.*/, 'api-key=****')})...`);
  const nullifierHashBytes = fieldToBytesBE(nullifierHash);
  const outCommitmentBytes = fieldToBytesBE(outCommitment);
  const rootBytes = hexToBytes(note.merkleRoot.replace('0x', '').padStart(64, '0'));

  const response = await fetch(`${relayUrl}/v2/withdraw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proof:                  uint8ToBase64(proofBytes),
      nullifierHash:          uint8ToBase64(nullifierHashBytes),
      root:                   uint8ToBase64(rootBytes),
      publicWithdrawalAmount: Number(withdrawalAmount),
      feeAmount:              Number(fee),
      outCommitment:          uint8ToBase64(outCommitmentBytes),
      recipient:              recipient.toBase58(),
      memoText,
    }),
  });
  console.log(`[Withdraw] ${elapsed()} — Relay responded: HTTP ${response.status}`);

  const result = await response.json();
  if (!response.ok || result.error || !result.signature) {
    console.log(`[Withdraw] ${elapsed()} — FAILED: ${result.error || result.message}`);
    throw new Error(result.message || result.error || `Relay withdrawal failed (HTTP ${response.status})`);
  }
  if (result.status === 'duplicate') {
    console.log(`[Withdraw] ${elapsed()} — DUPLICATE (already withdrawn)`);
    throw new Error('Already withdrawn');
  }

  console.log(`[Withdraw] ${elapsed()} — SUCCESS: ${result.signature?.slice(0, 20)}...`);

  const outCommitmentBigInt = outCommitment as bigint;
  return { signature: result.signature, changeNote, outCommitmentBigInt };
}
