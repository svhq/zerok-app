/**
 * Note Encryption
 *
 * Enables wallet-recoverable note storage without file downloads.
 * Technique adapted from Privacy Cash: wallet signature → deterministic AES key.
 *
 * Derivation chain:
 *   wallet.signMessage("zerok-note-recovery-v1")  ← deterministic Ed25519
 *   → SHA-256(signature) → 32-byte AES-256-GCM key
 *
 * The signature is deterministic: same wallet always produces the same key.
 * Recovery works from any device by re-signing the same message.
 *
 * Uses only Web Crypto (native in all browsers) — zero external dependencies.
 */

import { Note } from '@/types/note';

export const RECOVERY_SIGN_MESSAGE = 'zerok-note-recovery-v1';

/** Copy Uint8Array into a fresh ArrayBuffer (satisfies strict Web Crypto BufferSource typing). */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(u8.byteLength);
  new Uint8Array(buf).set(u8);
  return buf;
}

// Module-level key cache: survives React re-renders, cleared on page reload.
// Keyed by wallet public key string.
const keyCache = new Map<string, CryptoKey>();

/**
 * Derive AES-256-GCM key from wallet signature.
 * Caches the result for the session to avoid repeat popups.
 *
 * @param walletPubkey - Used as cache key
 * @param signMessage  - wallet.signMessage from useWallet()
 */
export async function deriveNoteEncryptionKey(
  walletPubkey: string,
  signMessage: (msg: Uint8Array) => Promise<Uint8Array>
): Promise<CryptoKey> {
  const cached = keyCache.get(walletPubkey);
  if (cached) return cached;

  const msgBytes = new TextEncoder().encode(RECOVERY_SIGN_MESSAGE);
  const signature = await signMessage(msgBytes);

  // SHA-256(signature) → 32-byte key material (Web Crypto native, no deps)
  const keyMaterial = await crypto.subtle.digest('SHA-256', toArrayBuffer(signature));

  const key = await crypto.subtle.importKey(
    'raw',
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  keyCache.set(walletPubkey, key);
  return key;
}

/** Returns true if the key is already cached (no popup needed this session). */
export function isKeyCached(walletPubkey: string): boolean {
  return keyCache.has(walletPubkey);
}

/** Get the cached key, or undefined if not yet derived. */
export function getCachedKey(walletPubkey: string): CryptoKey | undefined {
  return keyCache.get(walletPubkey);
}

/** Clear cached key (e.g., on wallet disconnect). */
export function clearCachedKey(walletPubkey: string): void {
  keyCache.delete(walletPubkey);
}

/**
 * Encrypt the minimal fields needed to regenerate a full Note.
 *
 * We only store: nullifierSecret, noteSecret, leafIndex, depositTx,
 * poolId, commitment, nullifierHash, createdAt.
 *
 * The Merkle path (siblings/positions) is NOT stored — it can always be
 * re-fetched from the depositTx via parseDepositEvent().
 *
 * Format: base64( IV[12] || AES-GCM-ciphertext )
 */
export async function encryptNote(note: Note, key: CryptoKey): Promise<string> {
  const payload = JSON.stringify({
    nullifierSecret: note.nullifierSecret,
    noteSecret: note.noteSecret,
    leafIndex: note.leafIndex,
    depositTx: note.depositTx,
    poolId: note.poolId,
    commitment: note.commitment,
    nullifierHash: note.nullifierHash,
    createdAt: note.createdAt,
  });

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    toArrayBuffer(new TextEncoder().encode(payload))
  );

  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), 12);
  return btoa(String.fromCharCode(...combined));
}

/**
 * Compact payload format for Memo-embedded note recovery.
 *
 * This is the on-chain format stored as a Solana Memo instruction.
 * Compact field names keep total memo size under the ~566-char Solana limit.
 * The Merkle path (siblings) is intentionally omitted — re-derived from
 * the same deposit tx's event logs at recovery time.
 */
export interface CompactMemoPayload {
  n: string;  // nullifier hex (62 chars, padStart)
  s: string;  // secret hex (62 chars, padStart)
  c: string;  // commitment hex (64 chars)
  h: string;  // nullifierHash hex (64 chars)
  p: string;  // poolId e.g. "devnet-0p100000001sol-v2c"
  d: string;  // denomination in lamports as string
}

export const MEMO_PREFIX = 'zerok:v1:';
export const MEMO_PREFIX_V2 = 'zerok:v2:';
export const MEMO_PREFIX_BATCH = 'zerok:v2:b:';
export const MEMO_PREFIX_V3 = 'zerok:v3:';
export const MEMO_PREFIX_V4 = 'zerok:v4:';
export const MEMO_PREFIX_V5 = 'zerok:v5:';

/**
 * Encrypt a compact note payload for embedding in a Solana Memo instruction.
 *
 * Same AES-256-GCM scheme as encryptNote, but only stores the secrets needed
 * to re-derive the full note at recovery time.
 *
 * Format: "zerok:v1:" + base64( IV[12] || AES-GCM-ciphertext )
 */
export async function encryptCompactMemoPayload(
  payload: CompactMemoPayload,
  key: CryptoKey
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    toArrayBuffer(new TextEncoder().encode(JSON.stringify(payload)))
  );
  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), 12);
  return MEMO_PREFIX + btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt an encrypted note blob.
 * Returns null silently if decryption fails (wrong key or corrupt data).
 * This is correct: wrong-key failure is the privacy mechanism.
 */
export async function decryptNote(blob: string, key: CryptoKey): Promise<Partial<Note> | null> {
  try {
    const bytes = Uint8Array.from(atob(blob), c => c.charCodeAt(0));
    const iv = bytes.slice(0, 12);
    const ciphertext = bytes.slice(12);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
}

/**
 * V3 memo payload shape from sdk/v3/deposit.js.
 * d = denomination, n = nullifier hex, s = secret hex, v = version (3).
 */
export interface V3MemoPayload {
  d: string;   // denomination in lamports
  n: string;   // nullifier hex (62-char, padStart)
  s: string;   // secret hex (62-char, padStart)
  v: number;   // version (3)
}

/**
 * Try to decrypt a V3 memo string (with or without prefix).
 * Returns the parsed payload on success, or null if the key is wrong / data is corrupt.
 * This is the core of the "scan pool, try-decrypt" recovery approach —
 * only the depositor's wallet-derived key will produce valid JSON.
 */
export async function tryDecryptV3Memo(memo: string, key: CryptoKey): Promise<V3MemoPayload | null> {
  const blob = memo.startsWith(MEMO_PREFIX_V3) ? memo.slice(MEMO_PREFIX_V3.length) : memo;
  try {
    const bytes = Uint8Array.from(atob(blob), c => c.charCodeAt(0));
    const iv = bytes.slice(0, 12);
    const ciphertext = bytes.slice(12);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );
    const parsed = JSON.parse(new TextDecoder().decode(plaintext));
    // Sanity check: must have nullifier and secret fields
    if (parsed && parsed.n && parsed.s) return parsed as V3MemoPayload;
    return null;
  } catch {
    return null; // wrong key or corrupt — expected for other users' notes
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// V4 Binary Memo: compact encoding — 145 bytes vs V3's 256 bytes (44% smaller)
//
// Plaintext: [denom u64 LE (8)] [nullifier BE (32)] [secret BE (32)] = 72 bytes
// Wire:      "zerok:v4:" + base64( IV(12) + AES-GCM(72 bytes) + tag(16) ) = 145 bytes
// ─────────────────────────────────────────────────────────────────────────────

/** Convert a bigint to a 32-byte big-endian Uint8Array (zero-padded). */
function bigintToBE32(val: bigint): Uint8Array {
  const hex = val.toString(16).padStart(64, '0');
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Read a 32-byte big-endian Uint8Array as a hex string (for V3MemoPayload compat). */
function be32ToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < 32; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

/**
 * Encrypt a V4 binary memo: 72-byte plaintext → 145-byte memo string.
 * 44% smaller than V3 JSON encoding (256 bytes).
 */
export async function encryptV4BinaryMemo(
  key: CryptoKey,
  denom: bigint,
  nullifier: bigint,
  secret: bigint,
): Promise<string> {
  // Build 72-byte plaintext: [8B denom LE] [32B nullifier BE] [32B secret BE]
  const plaintext = new Uint8Array(72);
  const view = new DataView(plaintext.buffer);
  view.setBigUint64(0, denom, true); // little-endian
  plaintext.set(bigintToBE32(nullifier), 8);
  plaintext.set(bigintToBE32(secret), 40);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext.buffer as ArrayBuffer,
  );
  const combined = new Uint8Array(12 + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), 12);
  return MEMO_PREFIX_V4 + btoa(String.fromCharCode(...combined));
}

/**
 * Try to decrypt a V4 binary memo. Returns V3MemoPayload shape for compatibility.
 * Returns null silently on wrong key or corrupt data.
 */
export async function tryDecryptV4BinaryMemo(memo: string, key: CryptoKey): Promise<V3MemoPayload | null> {
  const blob = memo.startsWith(MEMO_PREFIX_V4) ? memo.slice(MEMO_PREFIX_V4.length) : memo;
  try {
    const bytes = Uint8Array.from(atob(blob), c => c.charCodeAt(0));
    const iv = bytes.slice(0, 12);
    const ciphertext = bytes.slice(12);
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    const plain = new Uint8Array(plainBuf);
    if (plain.length !== 72) return null; // sanity: must be exactly 72 bytes
    const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    const d = view.getBigUint64(0, true).toString();
    const n = be32ToHex(plain.slice(8, 40));
    const s = be32ToHex(plain.slice(40, 72));
    return { d, n, s, v: 4 };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// V5 Seed Memo: one seed per batch → derive all note secrets deterministically
//
// Instead of encrypting N separate note payloads (V4: 145 bytes each),
// store ONE batch seed + denomination list. Recovery re-derives secrets.
//
// Plaintext: [32B batchSeed] [1B count] [count × 8B denom LE] = 33 + 8N bytes
// Wire:      "zerok:v5:" + base64(IV(12) + AES-GCM(plaintext) + tag(16))
//
// For 6 notes: 81B plain → 109B enc → 148B b64 → 157B wire (vs 6 × 145 = 870B with V4)
// ─────────────────────────────────────────────────────────────────────────────

const BN254_P = BigInt('21888242871839275222246405745257275088696311157297823662689037894645226208583');

/** 32-byte BE → BigInt */
function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return BigInt('0x' + hex);
}

/**
 * Derive nullifier and secret for note at `index` from a batch seed.
 * Uses Web Crypto SHA-256 with versioned domain tags for unambiguous derivation.
 *
 * Domain tags: "zerok:v5:nullifier" and "zerok:v5:secret" — versioned so
 * derivation namespace remains unambiguous if V6 ever changes the scheme.
 *
 * @param seed  - 32 bytes, random per BATCH (not per deposit)
 * @param index - 0-based note index WITHIN this batch (always 0..count-1)
 */
export async function deriveNoteFromSeed(
  seed: Uint8Array,
  index: number,
): Promise<{ nullifier: bigint; secret: bigint }> {
  const nTag = new TextEncoder().encode('zerok:v5:nullifier');
  const nInput = new Uint8Array(nTag.length + 32 + 1);
  nInput.set(nTag, 0);
  nInput.set(seed, nTag.length);
  nInput[nTag.length + 32] = index;
  const nHash = new Uint8Array(await crypto.subtle.digest('SHA-256', nInput));

  const sTag = new TextEncoder().encode('zerok:v5:secret');
  const sInput = new Uint8Array(sTag.length + 32 + 1);
  sInput.set(sTag, 0);
  sInput.set(seed, sTag.length);
  sInput[sTag.length + 32] = index;
  const sHash = new Uint8Array(await crypto.subtle.digest('SHA-256', sInput));

  const nullifier = bytesToBigIntBE(nHash) % BN254_P;
  const secret = bytesToBigIntBE(sHash) % BN254_P;
  return { nullifier, secret };
}

/**
 * Encrypt a V5 seed memo: ONE memo per batch, any number of notes.
 * Each batch generates its own independent seed — no cross-batch coupling.
 *
 * Plaintext layout:
 *   [32B batchSeed] [1B count] [4B programId prefix] [count × 8B denom LE]
 *   = 37 + 8N bytes
 *
 * The 4-byte programId prefix binds the memo to a specific program/environment,
 * preventing cross-program recovery confusion (devnet vs mainnet, old vs new program).
 *
 * IMPORTANT: Batch note order is the original greedySplit order and MUST NEVER be
 * re-sorted. Index 0,1,2... is part of the cryptographic derivation identity.
 */
export async function encryptV5SeedMemo(
  key: CryptoKey,
  seed: Uint8Array,
  denominations: bigint[],
  programIdBytes: Uint8Array,
): Promise<string> {
  const count = denominations.length;
  const plaintext = new Uint8Array(37 + count * 8);
  plaintext.set(seed, 0);
  plaintext[32] = count;
  plaintext.set(programIdBytes.slice(0, 4), 33); // first 4 bytes of programId
  const view = new DataView(plaintext.buffer);
  for (let i = 0; i < count; i++) {
    view.setBigUint64(37 + i * 8, denominations[i], true);
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext.buffer as ArrayBuffer,
  );
  const combined = new Uint8Array(12 + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), 12);
  return MEMO_PREFIX_V5 + btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a V5 seed memo → array of V3MemoPayload-compatible entries.
 * Re-derives nullifier/secret from seed using batch-local indices (0..count-1).
 *
 * If expectedProgramPrefix is provided, verifies the memo's context matches.
 * Returns null silently on wrong key, corrupt data, or context mismatch.
 */
export async function tryDecryptV5SeedMemo(
  memo: string,
  key: CryptoKey,
  expectedProgramPrefix?: Uint8Array,
): Promise<Array<{ d: string; n: string; s: string; v: number }> | null> {
  const blob = memo.startsWith(MEMO_PREFIX_V5) ? memo.slice(MEMO_PREFIX_V5.length) : memo;
  try {
    const bytes = Uint8Array.from(atob(blob), c => c.charCodeAt(0));
    const iv = bytes.slice(0, 12);
    const ciphertext = bytes.slice(12);
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    const plain = new Uint8Array(plainBuf);
    if (plain.length < 37) return null;

    const seed = plain.slice(0, 32);
    const count = plain[32];
    const progPrefix = plain.slice(33, 37);
    if (plain.length < 37 + count * 8) return null;

    // Verify context if expected prefix provided
    if (expectedProgramPrefix) {
      const expected = expectedProgramPrefix.slice(0, 4);
      if (progPrefix[0] !== expected[0] || progPrefix[1] !== expected[1] ||
          progPrefix[2] !== expected[2] || progPrefix[3] !== expected[3]) {
        return null; // context mismatch — wrong program
      }
    }

    const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    const results: Array<{ d: string; n: string; s: string; v: number }> = [];

    for (let i = 0; i < count; i++) {
      const denom = view.getBigUint64(37 + i * 8, true).toString();
      const { nullifier, secret } = await deriveNoteFromSeed(seed, i);
      results.push({
        d: denom,
        n: bigintToBE32(nullifier).reduce((h: string, b: number) => h + b.toString(16).padStart(2, '0'), ''),
        s: bigintToBE32(secret).reduce((h: string, b: number) => h + b.toString(16).padStart(2, '0'), ''),
        v: 5,
      });
    }
    return results;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch re-denomination memo support (zerok:v2:b: prefix)
//
// When a re-denomination creates 10 new notes, they're encrypted as a single
// binary blob in a Solana Memo instruction. This allows the browser to recover
// all 10 notes from one transaction.
//
// Binary format (v2): count(1) + targetDenom(8 LE) + [nullifier(32 BE) + secret(32 BE) + leafIndex(4 LE)] × count
// Binary format (v1): count(1) + targetDenom(8 LE) + [nullifier(32 BE) + secret(32 BE)] × count
// ─────────────────────────────────────────────────────────────────────────────

export interface BatchMemoNote {
  amount: string;
  nullifier: string;
  secret: string;
  leafIndex: number;
}

export interface BatchMemoResult {
  notes: BatchMemoNote[];
  isBatch: true;
}

/**
 * Decrypt and parse a batch re-denomination memo.
 *
 * @param encryptedMemo - Full memo string including prefix (e.g., "zerok:v2:b:...")
 * @param key - AES-256-GCM key derived from wallet signature
 * @returns Parsed batch notes or null if decryption fails
 */
export async function decryptBatchMemo(encryptedMemo: string, key: CryptoKey): Promise<BatchMemoResult | null> {
  if (!encryptedMemo.startsWith(MEMO_PREFIX_BATCH)) return null;

  try {
    const blob = encryptedMemo.slice(MEMO_PREFIX_BATCH.length);
    const bytes = Uint8Array.from(atob(blob), c => c.charCodeAt(0));
    const iv = bytes.slice(0, 12);
    const ciphertext = bytes.slice(12);

    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );

    const buf = new Uint8Array(plainBuf);
    return parseBatchPayload(buf);
  } catch {
    return null;
  }
}

/**
 * Parse the decrypted binary payload of a batch redenom memo.
 * Auto-detects v1 (64 bytes/note) vs v2 (68 bytes/note with leafIndex).
 */
function parseBatchPayload(buf: Uint8Array): BatchMemoResult | null {
  if (buf.length < 9) return null;

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = buf[0];
  const targetDenom = view.getBigUint64(1, true).toString(); // LE

  // Detect format: v2 (68 bytes/note) or v1 (64 bytes/note)
  const PER_NOTE_V2 = 68;
  const PER_NOTE_V1 = 64;
  const isV2 = buf.length >= 9 + count * PER_NOTE_V2;
  const perNote = isV2 ? PER_NOTE_V2 : PER_NOTE_V1;

  if (buf.length < 9 + count * perNote) return null;

  const notes: BatchMemoNote[] = [];
  for (let i = 0; i < count; i++) {
    const off = 9 + i * perNote;

    // nullifier: 32 bytes BE → hex → BigInt string
    let nullHex = '';
    for (let j = 0; j < 32; j++) nullHex += buf[off + j].toString(16).padStart(2, '0');
    const nullifier = BigInt('0x' + nullHex).toString();

    // secret: 32 bytes BE → hex → BigInt string
    let secHex = '';
    for (let j = 0; j < 32; j++) secHex += buf[off + 32 + j].toString(16).padStart(2, '0');
    const secret = BigInt('0x' + secHex).toString();

    // leafIndex: 4 bytes LE (v2 only)
    const leafIndex = isV2 ? view.getInt32(off + 64, true) : -1;

    notes.push({ amount: targetDenom, nullifier, secret, leafIndex });
  }

  return { notes, isBatch: true };
}
