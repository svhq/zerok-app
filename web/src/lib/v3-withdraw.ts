/**
 * ZeroK v3 — Native V3 Browser Withdrawal
 *
 * Uses the shared V3 witness builder (sdk/v2-core/v3-witness.js) — same code
 * as the CLI. No V2 wrapper, no JoinSplit, no change notes.
 *
 * Flow: buildV3Witness → snarkjs proof → POST /v3/withdraw
 */

import { PublicKey, Connection } from '@solana/web3.js';
import { V2Note } from '@/types/note';
import { initPoseidon, isRootInHistory, computeCommitmentFromBigInts, bytesToFieldBE, computeRootFromPath } from './sdk/poseidon';
import { getPoolConfig, getDeployedPools } from './pool-config';
import { getRelayUrl } from './v2-config';

// Shared V3 core — same code as CLI (sdk/v2-core/v3-witness.js)
// @ts-ignore — no TS declarations for shared JS modules
import { buildV3Witness } from 'v2-core/v3-witness';
// @ts-ignore
import { serializeProof } from 'v2-core/proof-serialize';
// @ts-ignore
import { calculateRelayFee } from 'v2-core/fee';
// @ts-ignore
import { fieldToBytesBE, uint8ToBase64 } from 'v2-core/field';

// ─── Pool config resolution (uses V3 pool config, NOT V2 PDA derivation) ────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getV3PoolConfig(denomination: bigint): any {
  for (const { id } of getDeployedPools()) {
    const pc = getPoolConfig(id);
    if (BigInt(pc.denominationLamports) === denomination) return pc;
  }
  throw new Error(`V3 pool not found for denomination ${denomination}`);
}

// ─── Note withdrawability check ─────────────────────────────────────────────

/**
 * Check if a V3 note is ready to withdraw:
 * - Has valid Merkle path
 * - Root is in pool's 256-entry in-state history
 */
export async function isNoteWithdrawable(
  note: V2Note,
  connection: Connection,
): Promise<boolean> {
  if (note.status !== 'unspent') return false;
  if (note.leafIndex < 0) return false;
  if (!note.pathElements?.length || !note.merkleRoot) return false;

  try {
    const pc = getV3PoolConfig(BigInt(note.amount));
    const info = await connection.getAccountInfo(new PublicKey(pc.statePda));
    if (!info) return false;
    return isRootInHistory(note.merkleRoot, new Uint8Array(info.data));
  } catch {
    return false;
  }
}

// ─── V3 withdrawal execution ────────────────────────────────────────────────

// Default protocol relay pubkey (receives fee, pays gas)
const DEFAULT_RELAYER = 'BEWNKrbVnLuWxPqVLSszwZpC6o86mC8RoSAWDaWwFivq';

export interface V3WithdrawParams {
  note: V2Note;
  recipient: PublicKey;
  onProgress?: (status: string) => void;
}

export interface V3WithdrawResult {
  signature: string;
}

/** Proof data produced by generateV3Proof, consumed by submitV3ToRelay */
export interface V3ProofData {
  proofBytes: Uint8Array;
  nullifierHashBytes: Uint8Array;
  rootBytes: Uint8Array;
  denomination: number;
  fee: number;
  recipient: string;
  timings: { witness: number; proof: number };
}

/**
 * Phase 1: Build witness + generate ZK proof (CPU-bound, ~1.2s).
 * Can be started for note N+1 while relay processes note N.
 */
export async function generateV3Proof(params: V3WithdrawParams): Promise<V3ProofData> {
  const { note, recipient, onProgress } = params;
  const denom = BigInt(note.amount);
  const fee = calculateRelayFee(denom) as bigint;

  const t0 = performance.now();
  onProgress?.('Building witness…');
  const poseidon = await initPoseidon();
  const nullifier = BigInt(note.nullifier);
  const secret = BigInt(note.secret);
  const pathElements = note.pathElements.map((e: string) => BigInt(e));
  const relayerPubkey = new PublicKey(DEFAULT_RELAYER);

  // Pre-flight: verify stored witness is internally consistent
  const { commitment: prefComm } = await computeCommitmentFromBigInts(nullifier, secret);
  const computedRoot = await computeRootFromPath(bytesToFieldBE(prefComm), note.pathElements, note.pathIndices);
  const normalizeRoot = (r: string) => r.replace(/^0x/, '');
  if (normalizeRoot(computedRoot) !== normalizeRoot(note.merkleRoot)) {
    throw new Error(
      `Witness inconsistency for leaf ${note.leafIndex}: ` +
      `stored root ${note.merkleRoot.slice(0,16)}… ≠ computed ${computedRoot.slice(0,16)}…. ` +
      `Note path is invalid — please reconnect wallet to refresh.`
    );
  }

  const { witness, nullifierHash } = buildV3Witness(poseidon, {
    nullifier, secret, pathElements,
    pathIndices: note.pathIndices,
    recipientBytes: recipient.toBytes(),
    relayerBytes: relayerPubkey.toBytes(),
    fee,
  });

  const t1 = performance.now();
  console.log(`[V3Withdraw] Witness built in ${(t1 - t0).toFixed(0)}ms`);
  onProgress?.('Generating ZK proof…');
  const snarkjs = await import('snarkjs');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { proof } = await snarkjs.groth16.fullProve(
    witness as any,
    '/artifacts/v3/withdraw_fixed.wasm',
    '/artifacts/v3/withdraw_final.zkey',
  );
  const proofBytes: Uint8Array = serializeProof(proof);
  const t2 = performance.now();
  console.log(`[V3Withdraw] Proof generated in ${(t2 - t1).toFixed(0)}ms`);

  return {
    proofBytes,
    nullifierHashBytes: fieldToBytesBE(nullifierHash),
    rootBytes: fieldToBytesBE(BigInt('0x' + note.merkleRoot.replace('0x', ''))),
    denomination: Number(denom),
    fee: Number(fee),
    recipient: recipient.toBase58(),
    timings: { witness: t1 - t0, proof: t2 - t1 },
  };
}

/**
 * Phase 2: Submit proof to relay (network-bound, ~1.7s).
 * Runs while next note's proof is being generated.
 */
export async function submitV3ToRelay(proofData: V3ProofData, onProgress?: (status: string) => void): Promise<V3WithdrawResult> {
  const t0 = performance.now();
  onProgress?.('Submitting to relay…');
  const relayUrl = getRelayUrl();

  const response = await fetch(`${relayUrl}/v3/withdraw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proof: uint8ToBase64(proofData.proofBytes),
      nullifierHash: uint8ToBase64(proofData.nullifierHashBytes),
      root: uint8ToBase64(proofData.rootBytes),
      recipient: proofData.recipient,
      denomination: proofData.denomination,
      fee: proofData.fee,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error((err as { error?: string }).error || `Relay error: HTTP ${response.status}`);
  }

  const result = await response.json() as { signature?: string; ok?: boolean };
  if (!result.signature) {
    throw new Error('Relay returned no signature');
  }

  const t1 = performance.now();
  console.log(`[V3Withdraw] Relay responded in ${(t1 - t0).toFixed(0)}ms`);
  console.log(`[V3Withdraw] TOTAL: ${(proofData.timings.witness + proofData.timings.proof + (t1 - t0)).toFixed(0)}ms (witness=${proofData.timings.witness.toFixed(0)} proof=${proofData.timings.proof.toFixed(0)} relay=${(t1 - t0).toFixed(0)})`);

  return { signature: result.signature };
}

/**
 * Execute a V3 withdrawal (legacy single-call API, still used for one-off withdrawals).
 * For pipelined multi-note withdrawals, use generateV3Proof + submitV3ToRelay directly.
 */
export async function executeV3Withdrawal(params: V3WithdrawParams): Promise<V3WithdrawResult> {
  const proofData = await generateV3Proof(params);
  return submitV3ToRelay(proofData, params.onProgress);
}
