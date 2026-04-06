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
import { initPoseidon, isRootInHistory } from './sdk/poseidon';
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

/**
 * Execute a V3 withdrawal via the protocol relay.
 *
 * Uses the shared V3 witness builder (same as CLI), V3 circuit artifacts,
 * and the /v3/withdraw relay endpoint.
 */
export async function executeV3Withdrawal(params: V3WithdrawParams): Promise<V3WithdrawResult> {
  const { note, recipient, onProgress } = params;
  const denom = BigInt(note.amount);
  const pc = getV3PoolConfig(denom);
  const fee = calculateRelayFee(denom) as bigint;

  // 1. Build witness using SHARED V3 CORE (same code as CLI)
  onProgress?.('Building V3 witness…');
  const poseidon = await initPoseidon();
  const nullifier = BigInt(note.nullifier);
  const secret = BigInt(note.secret);
  const pathElements = note.pathElements.map((e: string) => BigInt(e));
  const relayerPubkey = new PublicKey(DEFAULT_RELAYER);

  const { witness, nullifierHash } = buildV3Witness(poseidon, {
    nullifier,
    secret,
    pathElements,
    pathIndices: note.pathIndices,
    recipientBytes: recipient.toBytes(),
    relayerBytes: relayerPubkey.toBytes(),
    fee,
  });

  // 2. Generate proof (V3 = V1 circuit, NOT JoinSplit)
  onProgress?.('Generating ZK proof…');
  const snarkjs = await import('snarkjs');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { proof } = await snarkjs.groth16.fullProve(
    witness as any,
    '/artifacts/v3/withdraw_fixed.wasm',
    '/artifacts/v3/withdraw_final.zkey',
  );
  const proofBytes: Uint8Array = serializeProof(proof);

  // 3. Submit to V3 relay endpoint
  onProgress?.('Submitting to relay…');
  const relayUrl = getRelayUrl();
  const nullifierHashBytes: Uint8Array = fieldToBytesBE(nullifierHash);
  const rootBytes: Uint8Array = fieldToBytesBE(BigInt('0x' + note.merkleRoot.replace('0x', '')));

  const response = await fetch(`${relayUrl}/v3/withdraw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proof: uint8ToBase64(proofBytes),
      nullifierHash: uint8ToBase64(nullifierHashBytes),
      root: uint8ToBase64(rootBytes),
      recipient: recipient.toBase58(),
      denomination: Number(denom),
      fee: Number(fee),
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

  return { signature: result.signature };
}
