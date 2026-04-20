/**
 * ZeroK v2-core — Field Element Utilities
 *
 * Cross-environment (Node.js + browser) field arithmetic and byte conversions.
 * Uses Uint8Array instead of Buffer, globalThis.crypto instead of Node crypto.
 */

'use strict';

const { FIELD_MODULUS, BN254_P } = require('./constants.js');

// ─────────────────────────────────────────────────────────────────────────────
// Byte ↔ Hex conversion (replaces Buffer.toString('hex') / Buffer.from(hex,'hex'))
// ─────────────────────────────────────────────────────────────────────────────

function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function hexToBytes(hex) {
  const clean = hex.replace('0x', '').padStart(64, '0');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Uint8Array ↔ Base64 (replaces Buffer.toString('base64') / Buffer.from(b64,'base64'))
// Works in both Node 20+ and browser (btoa/atob are globally available).
// ─────────────────────────────────────────────────────────────────────────────

function uint8ToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToUint8(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Uint8Array concatenation (replaces Buffer.concat)
// ─────────────────────────────────────────────────────────────────────────────

function concatBytes(...arrays) {
  let totalLen = 0;
  for (const arr of arrays) totalLen += arr.length;
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Field element utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse hex string to field element (BigInt mod FIELD_MODULUS).
 */
function hexToFr(hex) {
  return BigInt('0x' + hex.replace('0x', '').padStart(64, '0')) % FIELD_MODULUS;
}

/**
 * Convert BigInt field element to 32-byte BigEndian Uint8Array.
 */
function fieldToBytesBE(bn) {
  return hexToBytes(BigInt(bn).toString(16).padStart(64, '0'));
}

/**
 * Split a 32-byte public key into high (bytes 0-15) and low (bytes 16-31) BigInts.
 * Used for circuit recipient/relayer binding.
 *
 * @param {Uint8Array} pubkeyBytes - 32-byte public key
 * @returns {{ high: bigint, low: bigint }}
 */
function splitAddress(pubkeyBytes) {
  const high = BigInt('0x' + bytesToHex(pubkeyBytes.slice(0, 16)));
  const low  = BigInt('0x' + bytesToHex(pubkeyBytes.slice(16, 32)));
  return { high, low };
}

/**
 * Generate a random BN254 field element as BigInt.
 * Rejection-sample until < FIELD_MODULUS (probability of rejection < 1/2^128).
 * Uses globalThis.crypto.getRandomValues (works in both Node 20+ and browser).
 */
function randomFieldElement() {
  while (true) {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    const value = BigInt('0x' + bytesToHex(bytes));
    if (value < FIELD_MODULUS) return value;
  }
}

module.exports = {
  // Byte helpers
  bytesToHex,
  hexToBytes,
  uint8ToBase64,
  base64ToUint8,
  concatBytes,

  // Field utilities
  hexToFr,
  fieldToBytesBE,
  splitAddress,
  randomFieldElement,
};
