/**
 * ZeroK v2-core — V3 Witness Builder
 *
 * Pure math witness construction for V3 (V1-style) withdrawal circuit.
 * Shared between CLI (sdk/v3/withdraw.js) and browser (web/src/lib/v3-withdraw.ts).
 *
 * V3 commitment = Poseidon(nullifier, secret) — no amount field.
 * Circuit: 8 public inputs (root, nullifierHash, recipientHigh/Low, relayerHigh/Low, fee, refund).
 *
 * Takes poseidon as a parameter. No fs, no crypto, no Connection.
 */

'use strict';

const { splitAddress } = require('./field.js');
const { computeNullifierHash } = require('./note.js');
const { computeRoot } = require('./merkle.js');

/**
 * Build the witness for the V3 withdrawal circuit.
 *
 * @param {Object} poseidon - circomlibjs poseidon instance
 * @param {Object} params
 * @param {bigint}      params.nullifier      - Note nullifier (bigint)
 * @param {bigint}      params.secret         - Note secret (bigint)
 * @param {bigint[]}    params.pathElements   - Merkle path siblings (bigint[])
 * @param {number[]}    params.pathIndices    - Merkle path indices (0=left, 1=right)
 * @param {Uint8Array}  params.recipientBytes - Recipient public key (32 bytes)
 * @param {Uint8Array}  params.relayerBytes   - Relayer public key (32 bytes)
 * @param {bigint}      [params.fee=0n]       - Relay fee in lamports
 * @returns {{ witness: Object, commitment: bigint, nullifierHash: bigint, computedRoot: bigint }}
 */
function buildV3Witness(poseidon, params) {
  const {
    nullifier, secret, pathElements, pathIndices,
    recipientBytes, relayerBytes, fee = 0n,
  } = params;

  // V3 commitment = Poseidon(nullifier, secret) — no amount
  const commitment = poseidon.F.toObject(poseidon([nullifier, secret]));

  // Nullifier hash = Poseidon(nullifier)
  const nullifierHash = computeNullifierHash(poseidon, nullifier);

  // Merkle root from commitment + path
  const computedRoot = computeRoot(poseidon, commitment, pathElements, pathIndices);

  // Split addresses for circuit binding (high 128 bits, low 128 bits)
  const { high: recipientHigh, low: recipientLow } = splitAddress(recipientBytes);
  let relayerHigh = 0n, relayerLow = 0n;
  if (fee > 0n) {
    const split = splitAddress(relayerBytes);
    relayerHigh = split.high;
    relayerLow = split.low;
  }

  // Circuit input (all values as decimal strings — snarkjs requirement)
  const witness = {
    // Public inputs (8):
    root:           computedRoot.toString(),
    nullifierHash:  nullifierHash.toString(),
    recipientHigh:  recipientHigh.toString(),
    recipientLow:   recipientLow.toString(),
    relayerHigh:    relayerHigh.toString(),
    relayerLow:     relayerLow.toString(),
    fee:            fee.toString(),
    refund:         '0',
    // Private inputs:
    nullifier:      nullifier.toString(),
    secret:         secret.toString(),
    pathElements:   pathElements.map(e => e.toString()),
    pathIndices:    pathIndices.map(i => i.toString()),
  };

  return { witness, commitment, nullifierHash, computedRoot };
}

module.exports = { buildV3Witness };
