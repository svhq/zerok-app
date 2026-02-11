/**
 * Solana-Compatible Poseidon Hash (Browser TypeScript)
 *
 * This module provides Poseidon hashing that matches Solana's on-chain behavior.
 * Solana's `solana-poseidon` with `Endianness::BigEndian` interprets 32-byte
 * arrays as BigEndian integers before hashing.
 */

// @ts-ignore - circomlibjs types not available
import { buildPoseidon } from 'circomlibjs';

let poseidonInstance: any = null;

/**
 * Initialize Poseidon (call once at startup)
 */
export async function initPoseidon(): Promise<any> {
  if (!poseidonInstance) {
    poseidonInstance = await buildPoseidon();
  }
  return poseidonInstance;
}

/**
 * Convert hex string or Uint8Array to BigInt (BigEndian interpretation)
 */
export function bytesToFieldBE(bytes: Uint8Array | string): bigint {
  const data = typeof bytes === 'string'
    ? new Uint8Array(bytes.match(/.{1,2}/g)?.map(b => parseInt(b, 16)) || [])
    : bytes;

  if (data.length !== 32) {
    throw new Error(`Expected 32 bytes, got ${data.length}`);
  }

  // Interpret as BigEndian integer
  let hex = '';
  for (const byte of data) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return BigInt('0x' + hex);
}

/**
 * Convert BN254 field element to 32-byte BigEndian Uint8Array
 */
export function fieldToBytesBE(fieldElement: bigint): Uint8Array {
  const hex = fieldElement.toString(16).padStart(64, '0');
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Convert BN254 field element to 32-byte LittleEndian Uint8Array
 */
export function fieldToBytesLE(fieldElement: bigint): Uint8Array {
  const be = fieldToBytesBE(fieldElement);
  return new Uint8Array(be.reverse());
}

/**
 * Poseidon hash two 32-byte inputs (Solana-compatible)
 */
export async function poseidonHash(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
  const poseidon = await initPoseidon();

  // Convert BE bytes to field elements
  const leftField = bytesToFieldBE(left);
  const rightField = bytesToFieldBE(right);

  // Hash with circomlibjs
  const hashField = poseidon([leftField, rightField]);
  const hash = poseidon.F.toObject(hashField);

  // Return as BE bytes
  return fieldToBytesBE(hash);
}

/**
 * Poseidon hash single input (for nullifier hash)
 */
export async function poseidonHashSingle(input: Uint8Array): Promise<Uint8Array> {
  const poseidon = await initPoseidon();

  // Convert BE bytes to field element
  const inputField = bytesToFieldBE(input);

  // Hash with circomlibjs
  const hashField = poseidon([inputField]);
  const hash = poseidon.F.toObject(hashField);

  // Return as BE bytes
  return fieldToBytesBE(hash);
}

/**
 * Compute commitment from nullifier and secret BigInts
 */
export async function computeCommitmentFromBigInts(
  nullifierBigInt: bigint,
  secretBigInt: bigint
): Promise<{ commitment: Uint8Array; nullifierHash: Uint8Array }> {
  const poseidon = await initPoseidon();

  const commitmentField = poseidon([nullifierBigInt, secretBigInt]);
  // CRITICAL: Use BE bytes to match on-chain program expectation
  // CLI uses BE encoding in sdk/poseidon_solana.js:fieldToBytesBE()
  const commitment = fieldToBytesBE(poseidon.F.toObject(commitmentField));

  const nullifierHashField = poseidon([nullifierBigInt]);
  // CRITICAL: Use BE bytes for consistency with commitment
  const nullifierHash = fieldToBytesBE(poseidon.F.toObject(nullifierHashField));

  return { commitment, nullifierHash };
}

/**
 * Generate random field element (< BN254 modulus)
 */
export function generateRandomFieldElement(): bigint {
  const BN254_P = BigInt('21888242871839275222246405745257275088696311157297823662689037894645226208583');

  // Generate 32 random bytes
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);

  // Convert to BigInt and reduce mod p
  const randomBigInt = bytesToFieldBE(randomBytes);
  return randomBigInt % BN254_P;
}
