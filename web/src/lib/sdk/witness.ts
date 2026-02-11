/**
 * Witness builder for ZeroK withdrawal proofs (Browser TypeScript)
 * Uses Solana-compatible Poseidon with BigEndian byte interpretation
 */

import { poseidonHashSingle, fieldToBytesBE, bytesToFieldBE } from './poseidon';
import { addressToBE32Parts } from './serialization';
import { PublicKey } from '@solana/web3.js';

export interface MerkleTree {
  root: bigint;
  getPath(index: number): {
    pathElements: bigint[];
    pathIndices: number[];
  };
}

export interface NoteData {
  nullifier: string | bigint;
  secret: string | bigint;
  index: number;
}

export interface WithdrawWitness {
  // Private inputs
  nullifier: string;
  secret: string;
  pathElements: string[];
  pathIndices: number[];

  // Public inputs
  root: string;
  nullifierHash: string;
  recipientHigh: string;
  recipientLow: string;
  protocolHigh: string;
  protocolLow: string;
  fee: string;
  refund: string;
}

/**
 * Build withdrawal witness for proof generation (v2 - BE encoding)
 * All public inputs use canonical 32-byte big-endian format
 */
export async function buildWithdrawWitnessV2(
  note: NoteData,
  merkleTree: MerkleTree,
  recipient: PublicKey,
  protocol: PublicKey | null,
  fee: bigint | number = 0,
  refund: bigint | number = 0
): Promise<WithdrawWitness> {
  // Parse note values
  const nullifier = typeof note.nullifier === 'string' ? BigInt(note.nullifier) : note.nullifier;
  const secret = typeof note.secret === 'string' ? BigInt(note.secret) : note.secret;

  // Calculate nullifier hash using Solana-compatible Poseidon
  const nullifierBytes = fieldToBytesBE(nullifier);
  const nullifierHashBytes = await poseidonHashSingle(nullifierBytes);
  const nullifierHash = bytesToFieldBE(nullifierHashBytes);

  // Get merkle path for the note
  const { pathElements, pathIndices } = merkleTree.getPath(note.index);

  // Convert Solana PublicKeys to BE32 field elements
  const [recipientHigh, recipientLow] = addressToBE32Parts(recipient.toBytes());

  let protocolHigh = 0n;
  let protocolLow = 0n;
  if (protocol) {
    [protocolHigh, protocolLow] = addressToBE32Parts(protocol.toBytes());
  }

  // Build witness object
  const witness: WithdrawWitness = {
    // Private inputs
    nullifier: nullifier.toString(),
    secret: secret.toString(),
    pathElements: pathElements.map(e => e.toString()),
    pathIndices: pathIndices,

    // Public inputs
    root: merkleTree.root.toString(),
    nullifierHash: nullifierHash.toString(),
    recipientHigh: recipientHigh.toString(),
    recipientLow: recipientLow.toString(),
    protocolHigh: protocolHigh.toString(),
    protocolLow: protocolLow.toString(),
    fee: BigInt(fee).toString(),
    refund: BigInt(refund).toString()
  };

  return witness;
}

/**
 * Format witness for snarkjs fullProve
 */
export function formatWitnessForSnarkjs(witness: WithdrawWitness): Record<string, string | string[] | number[]> {
  return {
    nullifier: witness.nullifier,
    secret: witness.secret,
    pathElements: witness.pathElements,
    pathIndices: witness.pathIndices,
    root: witness.root,
    nullifierHash: witness.nullifierHash,
    recipientHigh: witness.recipientHigh,
    recipientLow: witness.recipientLow,
    protocolHigh: witness.protocolHigh,
    protocolLow: witness.protocolLow,
    fee: witness.fee,
    refund: witness.refund
  };
}
