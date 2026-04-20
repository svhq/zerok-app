/**
 * ZeroK v2-core — Note Model & Memo Codecs
 *
 * Cross-environment note generation, commitment computation, and memo encoding.
 * Takes poseidon as a parameter (dependency injection).
 */

'use strict';

const { MEMO_PREFIX_V2 } = require('./constants.js');
const { randomFieldElement, fieldToBytesBE, uint8ToBase64 } = require('./field.js');

// ─────────────────────────────────────────────────────────────────────────────
// Commitment & Nullifier Hash
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the v2 commitment: Poseidon(amount, nullifier, secret)
 *
 * @param {Object} poseidon - circomlibjs poseidon instance
 * @param {bigint} amount - Note value in lamports
 * @param {bigint} nullifier
 * @param {bigint} secret
 * @returns {bigint}
 */
function computeCommitment(poseidon, amount, nullifier, secret) {
  return poseidon.F.toObject(poseidon([amount, nullifier, secret]));
}

/**
 * Compute nullifier hash: Poseidon(nullifier)
 *
 * @param {Object} poseidon
 * @param {bigint} nullifier
 * @returns {bigint}
 */
function computeNullifierHash(poseidon, nullifier) {
  return poseidon.F.toObject(poseidon([nullifier]));
}

// ─────────────────────────────────────────────────────────────────────────────
// Note Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a fresh v2 note with random nullifier and secret.
 * The commitment is NOT computed yet — call computeCommitment() when you have poseidon.
 *
 * @param {bigint} amountLamports
 * @returns {{ amount: bigint, nullifier: bigint, secret: bigint }}
 */
function generateNote(amountLamports) {
  return {
    amount: BigInt(amountLamports),
    nullifier: randomFieldElement(),
    secret: randomFieldElement(),
  };
}

/**
 * Create a complete note object with commitment and Merkle path.
 *
 * @param {Object} poseidon
 * @param {bigint} amountLamports
 * @param {number} leafIndex
 * @param {string} merkleRoot - hex
 * @param {bigint[]} pathElements
 * @param {number[]} pathIndices
 * @returns {Object}
 */
function buildNote(poseidon, amountLamports, leafIndex, merkleRoot, pathElements, pathIndices) {
  const base = generateNote(amountLamports);
  const commitment = computeCommitment(poseidon, base.amount, base.nullifier, base.secret);
  const nullifierHash = computeNullifierHash(poseidon, base.nullifier);

  return {
    version: 'v2',
    amount: base.amount.toString(),
    nullifier: base.nullifier.toString(),
    secret: base.secret.toString(),
    commitment: commitment.toString(),
    nullifierHash: nullifierHash.toString(),
    leafIndex,
    merkleRoot,
    pathElements: pathElements.map(e => e.toString()),
    pathIndices,
    spent: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Memo Serialization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serialize a note into a memo payload for encryption.
 * Used for DEPOSIT memos (full decimal strings, leafIndex known).
 */
function noteToMemoPayload(note) {
  return {
    n: note.nullifier.toString(),
    s: note.secret.toString(),
    a: note.amount.toString(),
    i: note.leafIndex,
  };
}

/**
 * Serialize a CHANGE NOTE into a compact memo payload for relay withdrawal memos.
 * Uses base64(32 bytes BE) for nullifier/secret to minimize size.
 * (Decimal BigInt strings are ~78 chars each; base64(32 bytes) = 44 chars)
 */
function changeNoteToMemoPayload(changeNote) {
  const fieldToBase64 = (v) => uint8ToBase64(fieldToBytesBE(BigInt(v)));
  return {
    n: fieldToBase64(changeNote.nullifier),
    s: fieldToBase64(changeNote.secret),
    a: BigInt(changeNote.amount).toString(),
  };
}

/**
 * Parse a decrypted memo payload back into a note record.
 */
function memoPayloadToNote(payload) {
  return {
    version: 'v2',
    amount: payload.a,
    nullifier: payload.n,
    secret: payload.s,
    leafIndex: payload.i,
    spent: false,
  };
}

/**
 * Encode a memo payload into the memo string for the Memo program instruction.
 * Format: "zerok:v2:" + base64(JSON)
 */
function encodeMemoPayload(payload) {
  const json = JSON.stringify(payload);
  return MEMO_PREFIX_V2 + btoa(json);
}

/**
 * Decode a memo string back to a payload object.
 * Returns null if the memo is not a v2 memo.
 */
function decodeMemoPayload(memo) {
  if (!memo || !memo.startsWith(MEMO_PREFIX_V2)) return null;
  try {
    const b64 = memo.slice(MEMO_PREFIX_V2.length);
    return JSON.parse(atob(b64));
  } catch {
    return null;
  }
}

module.exports = {
  computeCommitment,
  computeNullifierHash,
  generateNote,
  buildNote,
  noteToMemoPayload,
  changeNoteToMemoPayload,
  memoPayloadToNote,
  encodeMemoPayload,
  decodeMemoPayload,
};
