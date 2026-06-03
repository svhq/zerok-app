'use strict';

/**
 * ZeroK memo codecs (framework-agnostic, Node).
 *
 * Node port of the decrypt side of `web/src/lib/note-encryption.ts`. The web
 * client writes three memo formats; this module reads all three so the SDK's
 * `recover()` reattaches to notes deposited from app.zerok.app.
 *
 *   v3 (`zerok:v3:`) — AES-GCM(JSON {d,n,s,v})              — 1 note / memo
 *   v4 (`zerok:v4:`) — AES-GCM(72B [denom LE][null BE][sec BE]) — 1 note / memo
 *   v5 (`zerok:v5:`) — AES-GCM([seed][count][progPfx][denoms]) — N notes / memo
 *
 * All three use the SAME wallet-derived AES-256-GCM key (see deriveEncryptionKey
 * in sdk/agent/index.js). Wire layout for every version:
 *   base64( IV(12) ++ ciphertext ++ GCM-tag(16) )
 *
 * Output shape (uniform with the v3 JSON payload the SDK already consumes):
 *   { d: <denom decimal string>, n: <nullifier hex>, s: <secret hex>, v: <ver> }
 * `decodeMemo()` always returns an ARRAY (v3/v4 → 1 element, v5 → N).
 */

const crypto = require('crypto');

const MEMO_PREFIX_V3 = 'zerok:v3:';
const MEMO_PREFIX_V4 = 'zerok:v4:';
const MEMO_PREFIX_V5 = 'zerok:v5:';

// BN254 scalar field — v5 derives nullifier/secret as SHA256(...) mod this.
const BN254_P = BigInt(
  '21888242871839275222246405745257275088696311157297823662689037894645226208583'
);

/** AES-256-GCM decrypt of `IV(12) ++ ciphertext ++ tag(16)`. Returns null on any failure. */
function aesGcmDecrypt(combined, key) {
  if (!combined || combined.length < 12 + 16) return null;
  try {
    const iv = combined.subarray(0, 12);
    const ciphertext = combined.subarray(12, combined.length - 16);
    const tag = combined.subarray(combined.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return null;
  }
}

/** Slice the base64 blob that follows a known prefix (tolerates RPC wrapping). */
function blobAfter(memo, prefix) {
  const idx = memo.indexOf(prefix);
  return idx >= 0 ? memo.slice(idx + prefix.length) : memo;
}

/** 32-byte big-endian hex (64 chars) from a BigInt. */
function bigToHex32(x) {
  return x.toString(16).padStart(64, '0');
}

/**
 * Decrypt a v3 JSON memo → { d, n, s, v }. Returns null on wrong key / malformed.
 */
function tryDecryptV3Memo(memo, key) {
  const blob = blobAfter(memo, MEMO_PREFIX_V3);
  const plaintext = aesGcmDecrypt(safeBase64(blob), key);
  if (!plaintext) return null;
  try {
    const parsed = JSON.parse(plaintext.toString('utf8'));
    if (parsed && parsed.n && parsed.s && parsed.d != null) {
      return { d: String(parsed.d), n: parsed.n, s: parsed.s, v: parsed.v || 3 };
    }
  } catch {
    /* not v3 JSON */
  }
  return null;
}

/**
 * Decrypt a v4 binary memo → { d, n, s, v:4 }.
 * Plaintext: [8B denom LE][32B nullifier BE][32B secret BE] = 72 bytes.
 */
function tryDecryptV4BinaryMemo(memo, key) {
  const blob = blobAfter(memo, MEMO_PREFIX_V4);
  const plain = aesGcmDecrypt(safeBase64(blob), key);
  if (!plain || plain.length !== 72) return null;
  const d = plain.readBigUInt64LE(0).toString();
  const n = plain.subarray(8, 40).toString('hex');
  const s = plain.subarray(40, 72).toString('hex');
  return { d, n, s, v: 4 };
}

/**
 * Re-derive nullifier/secret for note `index` within a v5 batch from its seed.
 * Domain-separated SHA-256, mod BN254 field — identical to the web derivation.
 */
function deriveNoteFromSeed(seed, index) {
  const nInput = Buffer.concat([Buffer.from('zerok:v5:nullifier'), Buffer.from(seed), Buffer.from([index])]);
  const sInput = Buffer.concat([Buffer.from('zerok:v5:secret'), Buffer.from(seed), Buffer.from([index])]);
  const nHash = crypto.createHash('sha256').update(nInput).digest();
  const sHash = crypto.createHash('sha256').update(sInput).digest();
  const nullifier = BigInt('0x' + nHash.toString('hex')) % BN254_P;
  const secret = BigInt('0x' + sHash.toString('hex')) % BN254_P;
  return { nullifier, secret };
}

/**
 * Decrypt a v5 batch-seed memo → array of { d, n, s, v:5 } (one per batch note).
 * Plaintext: [32B seed][1B count][4B programId prefix][count × 8B denom LE].
 * The program prefix is informational here (mirrors web: not enforced on read).
 */
function tryDecryptV5SeedMemo(memo, key) {
  const blob = blobAfter(memo, MEMO_PREFIX_V5);
  const plain = aesGcmDecrypt(safeBase64(blob), key);
  if (!plain || plain.length < 37) return null;
  const seed = plain.subarray(0, 32);
  const count = plain[32];
  if (plain.length < 37 + count * 8) return null;

  const results = [];
  for (let i = 0; i < count; i++) {
    const denom = plain.readBigUInt64LE(37 + i * 8).toString();
    const { nullifier, secret } = deriveNoteFromSeed(seed, i);
    results.push({ d: denom, n: bigToHex32(nullifier), s: bigToHex32(secret), v: 5 });
  }
  return results;
}

/** Base64 → Buffer, tolerant of malformed input (returns null). */
function safeBase64(blob) {
  try {
    return Buffer.from(blob, 'base64');
  } catch {
    return null;
  }
}

/** True if a (cleaned) memo string carries any ZeroK note format. */
function isZerokMemo(memo) {
  return (
    memo.includes(MEMO_PREFIX_V3) ||
    memo.includes(MEMO_PREFIX_V4) ||
    memo.includes(MEMO_PREFIX_V5)
  );
}

/**
 * Version-detecting dispatcher. Always returns an ARRAY of {d,n,s,v} payloads
 * (v3/v4 → 0 or 1 element, v5 → 0..count). Wrong-key/foreign memos → [].
 */
function decodeMemo(memo, key) {
  if (memo.includes(MEMO_PREFIX_V5)) {
    return tryDecryptV5SeedMemo(memo, key) || [];
  }
  if (memo.includes(MEMO_PREFIX_V4)) {
    const p = tryDecryptV4BinaryMemo(memo, key);
    return p ? [p] : [];
  }
  if (memo.includes(MEMO_PREFIX_V3)) {
    const p = tryDecryptV3Memo(memo, key);
    return p ? [p] : [];
  }
  return [];
}

module.exports = {
  MEMO_PREFIX_V3,
  MEMO_PREFIX_V4,
  MEMO_PREFIX_V5,
  BN254_P,
  tryDecryptV3Memo,
  tryDecryptV4BinaryMemo,
  tryDecryptV5SeedMemo,
  deriveNoteFromSeed,
  decodeMemo,
  isZerokMemo,
};
