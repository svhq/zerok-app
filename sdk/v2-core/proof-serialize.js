/**
 * ZeroK v2-core — Proof Serialization
 *
 * Serialize snarkjs Groth16 proof to 256 bytes for on-chain verification.
 * Cross-environment (Uint8Array, no Buffer).
 */

'use strict';

const { BN254_P } = require('./constants.js');
const { fieldToBytesBE, concatBytes } = require('./field.js');

/**
 * Convert G2 point coordinates to BigEndian bytes (128 bytes).
 * Ordering: x_c1, x_c0, y_c1, y_c0 — matches Solana alt_bn128 pairing.
 */
function g2ToBE(coords) {
  const x_c1 = fieldToBytesBE(BigInt(coords[0][1]));
  const x_c0 = fieldToBytesBE(BigInt(coords[0][0]));
  const y_c1 = fieldToBytesBE(BigInt(coords[1][1]));
  const y_c0 = fieldToBytesBE(BigInt(coords[1][0]));
  return concatBytes(x_c1, x_c0, y_c1, y_c0);
}

/**
 * Serialize a snarkjs Groth16 proof to 256 bytes for on-chain verification.
 * A-point is negated (Solana's alt_bn128 pairing expects negated A).
 *
 * @param {{ pi_a: string[], pi_b: string[][], pi_c: string[] }} proof
 * @returns {Uint8Array} 256 bytes
 */
function serializeProof(proof) {
  const buf = new Uint8Array(256);
  let off = 0;

  // A: negated
  buf.set(fieldToBytesBE(BigInt(proof.pi_a[0])), off); off += 32;
  buf.set(fieldToBytesBE(BN254_P - BigInt(proof.pi_a[1])), off); off += 32;

  // B: G2 with (c1, c0) ordering
  buf.set(g2ToBE(proof.pi_b), off); off += 128;

  // C: normal
  buf.set(fieldToBytesBE(BigInt(proof.pi_c[0])), off); off += 32;
  buf.set(fieldToBytesBE(BigInt(proof.pi_c[1])), off);

  return buf;
}

module.exports = { serializeProof, g2ToBE };
