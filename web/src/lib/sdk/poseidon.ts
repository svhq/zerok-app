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
 * Compute v2 commitment: Poseidon(amount, nullifier, secret)
 * v2 encodes the amount in the commitment (unlike v1 which uses Poseidon(nullifier, secret)).
 */
export async function computeV2CommitmentFromBigInts(
  amountBigInt: bigint,
  nullifierBigInt: bigint,
  secretBigInt: bigint,
): Promise<{ commitment: Uint8Array; nullifierHash: Uint8Array }> {
  const poseidon = await initPoseidon();

  // Commitment = Poseidon(amount, nullifier, secret)
  const commitmentField = poseidon([amountBigInt, nullifierBigInt, secretBigInt]);
  const commitment = fieldToBytesBE(poseidon.F.toObject(commitmentField));

  // NullifierHash = Poseidon(nullifier) — same as v1
  const nullifierHashField = poseidon([nullifierBigInt]);
  const nullifierHash = fieldToBytesBE(poseidon.F.toObject(nullifierHashField));

  return { commitment, nullifierHash };
}

// ─── v2 pool state constants (mirrors sdk/v2/canonical.js) ──────────────────

// V2: root history at offset 848, 256 entries (in 131,920-byte state)
// V3: root history at offset 720, 256 entries (in 8,992-byte state)
// Auto-detected by account size in isRootInHistory() below.
const V2_ROOT_HISTORY_OFFSET = 848;
const V3_ROOT_HISTORY_OFFSET = 720;
const ROOT_HISTORY_COUNT     = 256;
const V2_TREE_DEPTH          = 20;

/**
 * Check if a note's Merkle root is still accepted by the pool.
 * The pool keeps the last 256 roots in a ring buffer at offset 848.
 *
 * If this returns true, the note's stored `pathElements` + `pathIndices` can be
 * used directly in the JoinSplit proof — no event scanning or tree rebuild needed.
 *
 * @param noteRootHex  - hex string of the note's Merkle root (with or without "0x")
 * @param poolDataBytes - raw bytes of the v2 pool state account
 */
export function isRootInHistory(noteRootHex: string, poolDataBytes: Uint8Array): boolean {
  // Auto-detect V3 (8,992 bytes) vs V2 (131,920 bytes)
  const isV3 = poolDataBytes.length <= 9000;
  const historyOffset = isV3 ? V3_ROOT_HISTORY_OFFSET : V2_ROOT_HISTORY_OFFSET;
  const clean = noteRootHex.replace('0x', '').toLowerCase().padStart(64, '0');
  for (let i = 0; i < ROOT_HISTORY_COUNT; i++) {
    const off = historyOffset + i * 32;
    let slot = '';
    for (let j = 0; j < 32; j++) {
      slot += poolDataBytes[off + j].toString(16).padStart(2, '0');
    }
    if (slot === clean) return true;
  }
  return false;
}

/**
 * Read the current Merkle root from v2 pool state (offset 808, 32 bytes).
 */
export function readCurrentRootFromState(poolDataBytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < 32; i++) {
    hex += poolDataBytes[816 + i].toString(16).padStart(2, '0'); // shifted +8 by denomination field
  }
  return hex;
}

/**
 * Read the current leaf count from pool state.
 * V3 state layout: leaf_count at offset 8980 (u32 LE). See sdk/v3/canonical.js STATE_OFFSETS.
 * V2 state layout: leaf_count at offset 168 (u32 LE).
 * Auto-detects based on account size: V3 = 8992 bytes, V2 = 131920 bytes.
 */
export function readLeafCountFromState(poolDataBytes: Uint8Array): number {
  const dv = new DataView(poolDataBytes.buffer, poolDataBytes.byteOffset);
  // V3 state is 8992 bytes; V2 is 131920 bytes
  const offset = poolDataBytes.length <= 9000 ? 8980 : 168;
  return dv.getUint32(offset, true);
}

// Re-export depth constant for callers that need it
export const MERKLE_TREE_DEPTH = V2_TREE_DEPTH;

// ─── v2 zero chain (lazy-computed from Poseidon, matches on-chain ZERO_CHAIN) ──

let _zeroChain: bigint[] | null = null;

/**
 * Compute the zero-value chain for an empty Merkle tree.
 * zeroChain[0] = 0 (empty leaf), zeroChain[i] = Poseidon(zeroChain[i-1], zeroChain[i-1])
 * Matches on-chain ZERO_CHAIN in constants.rs (BigEndian).
 */
async function getZeroChain(): Promise<bigint[]> {
  if (_zeroChain) return _zeroChain;
  const poseidon = await initPoseidon();
  const chain: bigint[] = new Array(V2_TREE_DEPTH);
  let zero = 0n;
  for (let i = 0; i < V2_TREE_DEPTH; i++) {
    chain[i] = zero;
    const h = poseidon([zero, zero]);
    zero = poseidon.F.toObject(h) as bigint;
  }
  _zeroChain = chain;
  return chain;
}

/**
 * Compute Merkle path for a specific leaf by rebuilding the tree from all commitments.
 *
 * Uses memoized recursive traversal — efficient for batch path computation.
 * The computed root matches the pool's current root (reflects all commitments).
 *
 * @param commitments - All pool commitments in leaf order (index = leafIndex)
 * @param leafIndex   - Which leaf to compute the path for
 * @param treeDepth   - Tree depth (default 20)
 * @returns pathElements (hex strings), pathIndices, computedRoot (hex)
 */
export async function computeMerklePathFromCommitments(
  commitments: bigint[],
  leafIndex: number,
  treeDepth: number = V2_TREE_DEPTH,
): Promise<{ pathElements: string[]; pathIndices: number[]; computedRoot: string }> {
  const poseidon = await initPoseidon();
  const zeroChain = await getZeroChain();
  const memo = new Map<string, bigint>();

  function node(level: number, idx: number): bigint {
    const key = `${level}:${idx}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let val: bigint;
    if (level === 0) {
      val = idx < commitments.length ? commitments[idx] : zeroChain[0];
    } else {
      const l = node(level - 1, idx * 2);
      const r = node(level - 1, idx * 2 + 1);
      val = poseidon.F.toObject(poseidon([l, r])) as bigint;
    }
    memo.set(key, val);
    return val;
  }

  const pathElements: string[] = [];
  const pathIndices: number[] = [];
  let idx = leafIndex;

  for (let level = 0; level < treeDepth; level++) {
    const isRight = idx & 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    pathIndices.push(isRight);
    const sib = node(level, siblingIdx);
    pathElements.push(sib.toString());
    idx = Math.floor(idx / 2);
  }

  const root = node(treeDepth, 0);
  return {
    pathElements,
    pathIndices,
    computedRoot: root.toString(16).padStart(64, '0'),
  };
}

// ─── Frontier-based path computation (matches sdk/v2/canonical.js exactly) ────

/**
 * Read the Merkle frontier from pool state account data.
 * V3: offset 48 (see sdk/v3/canonical.js STATE_OFFSETS.FRONTIER).
 * V2: offset 176.
 * Auto-detects based on account size.
 */
export function readFrontierFromState(stateData: Uint8Array): string[] {
  const frontierOffset = stateData.length <= 9000 ? 48 : 176;
  const frontier: string[] = [];
  for (let i = 0; i < V2_TREE_DEPTH; i++) {
    const off = frontierOffset + i * 32;
    let hex = '';
    for (let j = 0; j < 32; j++) hex += stateData[off + j].toString(16).padStart(2, '0');
    frontier.push(hex);
  }
  return frontier;
}

/**
 * Compute Merkle path for a leaf using the pool's frontier (no full tree needed).
 * This is the lightweight path computation — matches sdk/v2/canonical.js:computeMerklePath().
 *
 * IMPORTANT: This only gives a correct path for the LATEST leaf (where right siblings
 * are guaranteed to be zero-chain). For batch-inserted leaves, use computeBatchMerklePaths.
 * For arbitrary leaves, the path must be fetched from the relay or computed from all commitments.
 */
export async function computeMerklePathFromFrontier(
  leafIndex: number,
  frontier: string[],
): Promise<{ pathElements: string[]; pathIndices: number[] }> {
  const zeroChain = await getZeroChain();
  const pathElements: string[] = [];
  const pathIndices: number[] = [];
  let idx = leafIndex;

  for (let level = 0; level < V2_TREE_DEPTH; level++) {
    if ((idx & 1) === 0) {
      // Left child: sibling is zero chain (right placeholder)
      pathElements.push(zeroChain[level].toString());
      pathIndices.push(0);
    } else {
      // Right child: sibling is from frontier
      pathElements.push(bytesToFieldBE(frontier[level]).toString());
      pathIndices.push(1);
    }
    idx = Math.floor(idx / 2);
  }

  return { pathElements, pathIndices };
}

/**
 * Compute Merkle root from leaf + path (for verification).
 */
export async function computeRootFromPath(
  commitment: bigint,
  pathElements: string[],
  pathIndices: number[],
): Promise<string> {
  const poseidon = await initPoseidon();
  let cur = commitment;
  for (let i = 0; i < V2_TREE_DEPTH; i++) {
    const sibling = BigInt(pathElements[i]);
    const left  = pathIndices[i] === 0 ? cur : sibling;
    const right = pathIndices[i] === 0 ? sibling : cur;
    cur = poseidon.F.toObject(poseidon([left, right])) as bigint;
  }
  return cur.toString(16).padStart(64, '0');
}

/**
 * Batch check whether v2 notes are spent by checking nullifier PDA existence.
 *
 * @param connection - Solana connection
 * @param notes      - Array of notes with nullifier field (decimal string)
 * @param programId  - v2 program public key
 * @returns Array of booleans (true = spent)
 */
export async function batchCheckV2NotesSpent(
  connection: import('@solana/web3.js').Connection,
  notes: Array<{ nullifier: string }>,
  programId: import('@solana/web3.js').PublicKey,
): Promise<boolean[]> {
  const { PublicKey } = await import('@solana/web3.js');
  const poseidon = await initPoseidon();

  // Derive nullifier PDAs
  const pdas: import('@solana/web3.js').PublicKey[] = [];
  for (const note of notes) {
    const nullBigInt = BigInt(note.nullifier);
    const hashField = poseidon([nullBigInt]);
    const hashBytes = fieldToBytesBE(poseidon.F.toObject(hashField) as bigint);
    const [pda] = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('nullifier_v2'), hashBytes],
      programId,
    );
    pdas.push(pda);
  }

  // Batch RPC call
  const BATCH = 100;
  const results: boolean[] = new Array(notes.length).fill(false);
  for (let b = 0; b < pdas.length; b += BATCH) {
    const chunk = pdas.slice(b, b + BATCH);
    const infos = await connection.getMultipleAccountsInfo(chunk);
    for (let i = 0; i < chunk.length; i++) {
      results[b + i] = infos[i] !== null;
    }
  }
  return results;
}

/**
 * Batch check whether V3 notes are spent by checking nullifier PDA existence.
 * V3 nullifier PDA seeds: ["nullifier", statePda, nullifierHashBE]
 * (Different from V2 which uses ["nullifier_v2", hashBytes])
 *
 * @param connection - Solana connection
 * @param notes      - Array of notes with nullifier and amount fields
 * @param programId  - V3 program public key (same as V2 — HVcTokFF...)
 * @returns Array of booleans (true = spent)
 */
export async function batchCheckV3NotesSpent(
  connection: import('@solana/web3.js').Connection,
  notes: Array<{ nullifier: string; amount: string }>,
  programId: import('@solana/web3.js').PublicKey,
): Promise<boolean[]> {
  const { PublicKey } = await import('@solana/web3.js');
  const { getPoolConfig, getDeployedPools } = await import('@/lib/pool-config');
  const poseidon = await initPoseidon();

  // Resolve statePda per denomination (cache to avoid repeated lookups)
  const statePdaCache = new Map<string, import('@solana/web3.js').PublicKey>();
  function getStatePda(denomination: bigint): import('@solana/web3.js').PublicKey | null {
    const key = denomination.toString();
    if (statePdaCache.has(key)) return statePdaCache.get(key)!;
    for (const { id } of getDeployedPools()) {
      const pc = getPoolConfig(id);
      if (BigInt(pc.denominationLamports) === denomination) {
        const pda = new PublicKey(pc.statePda);
        statePdaCache.set(key, pda);
        return pda;
      }
    }
    return null;
  }

  // Derive V3 nullifier PDAs
  const pdas: import('@solana/web3.js').PublicKey[] = [];
  const validIndices: number[] = [];
  for (let i = 0; i < notes.length; i++) {
    const statePda = getStatePda(BigInt(notes[i].amount));
    if (!statePda) continue; // not a V3 pool

    const nullBigInt = BigInt(notes[i].nullifier);
    const hashField = poseidon([nullBigInt]);
    const hashBytes = fieldToBytesBE(poseidon.F.toObject(hashField) as bigint);
    const [pda] = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('nullifier'), statePda.toBuffer(), hashBytes],
      programId,
    );
    pdas.push(pda);
    validIndices.push(i);
  }

  // Batch RPC call
  const results: boolean[] = new Array(notes.length).fill(false);
  const BATCH = 100;
  for (let b = 0; b < pdas.length; b += BATCH) {
    const chunk = pdas.slice(b, b + BATCH);
    const infos = await connection.getMultipleAccountsInfo(chunk);
    for (let j = 0; j < chunk.length; j++) {
      results[validIndices[b + j]] = infos[j] !== null;
    }
  }
  return results;
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
