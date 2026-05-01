/**
 * V3 Deposit Module
 *
 * CRITICAL INVARIANT: Every deposit MUST:
 * 1. Save note secrets to disk BEFORE sending the transaction
 * 2. Include an encrypted memo instruction in the transaction
 * 3. Save complete note after confirmation
 * NO EXCEPTIONS. See CRITICAL_INVARIANTS.md Invariant #1.
 *
 * Based on V1 deposit.js with mandatory memo encryption added.
 */

'use strict';

const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} = require("@solana/web3.js");
const { buildPoseidon } = require("circomlibjs");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  PROGRAM_ID,
  SEEDS,
  STATE_OFFSETS,
  FIELD_MODULUS,
  TREE_DEPTH,
  MEMO_PREFIX_V3,
  MEMO_PROGRAM_ID,
  fieldToBytesBE,
  readFrontier,
  readRoot,
  readLeafCount,
  derivePDAs,
  deriveShardPda,
  discriminator,
} = require("./canonical.js");

// Module-level Poseidon cache
let _poseidonPromise = null;
function getCachedPoseidon() {
  if (!_poseidonPromise) _poseidonPromise = buildPoseidon();
  return _poseidonPromise;
}

const DEFAULT_COMPUTE_UNITS = 200_000; // Extra CU budget for memo program
const DEFAULT_NOTES_BASE_DIR = path.join(process.cwd(), "notes");

// =============================================================================
// MEMO ENCRYPTION (CLI version — uses Node.js crypto)
// =============================================================================

/**
 * Encrypt note data for memo using AES-256-GCM.
 * Key must be provided (derived from wallet signature externally).
 * @param {Buffer} encryptionKey - 32-byte AES key
 * @param {Object} notePayload - { d, n, s, v }
 * @returns {string} "zerok:v3:<base64(iv + ciphertext + tag)>"
 */
function encryptMemo(encryptionKey, notePayload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const plaintext = JSON.stringify(notePayload);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, encrypted, tag]);
  return MEMO_PREFIX_V3 + combined.toString('base64');
}

/**
 * Build a Memo program instruction with encrypted note data.
 * Keys: [] (no signer required — avoids MissingRequiredSignature).
 */
function buildMemoInstruction(memoText) {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],  // No accounts — matches V2 fix
    data: Buffer.from(memoText, 'utf8'),
  });
}

// =============================================================================
// DEPOSIT FUNCTION
// =============================================================================

/**
 * Make a deposit to a V3 pool with mandatory note saving and memo encryption.
 *
 * @param {Object} params
 * @param {Connection} params.connection - Solana connection
 * @param {bigint} params.denomination - Pool denomination in lamports
 * @param {Keypair} params.wallet - Payer wallet
 * @param {Object} params.options
 * @param {Buffer} [params.options.encryptionKey] - 32-byte AES key for memo encryption
 * @param {string} [params.options.notesDir] - Directory to save notes
 * @param {string} [params.options.poolId] - Pool identifier
 * @param {string} [params.options.network] - Network name
 * @param {boolean} [params.options.skipMemo] - NEVER set this in production. Only for localnet unit tests.
 * @returns {Promise<{leafIndex, txSignature, notePath, commitment}>}
 */
async function deposit(params) {
  const { connection, denomination, wallet, options = {} } = params;

  // =========================================================================
  // INVARIANT CHECK: Memo encryption key must be provided
  // =========================================================================
  if (!options.encryptionKey && !options.skipMemo) {
    throw new Error(
      'CRITICAL: encryptionKey is required for deposits. ' +
      'Every deposit MUST include an encrypted memo for recovery. ' +
      'Derive key from wallet.signMessage("zerok-note-recovery-v1") → SHA-256. ' +
      'See CRITICAL_INVARIANTS.md Invariant #1.'
    );
  }

  const denomLabel = (Number(denomination) / 1e9).toString().replace(".", "p");
  const notesDir = options.notesDir || path.join(DEFAULT_NOTES_BASE_DIR, denomLabel);
  if (!fs.existsSync(notesDir)) {
    fs.mkdirSync(notesDir, { recursive: true });
  }

  const network = options.network || "devnet";
  const poolId = options.poolId || `${network}-${denomLabel}sol-v3`;

  // =========================================================================
  // BALANCE GUARD: Check wallet has enough SOL
  // =========================================================================
  const balance = await connection.getBalance(wallet.publicKey);
  const depositAmount = Number(denomination);
  const buffer = 10_000_000; // 0.01 SOL for fees
  if (balance < depositAmount + buffer) {
    throw new Error(
      `Insufficient balance: ${balance / 1e9} SOL. ` +
      `Need ${(depositAmount + buffer) / 1e9} SOL (${depositAmount / 1e9} deposit + 0.01 buffer).`
    );
  }

  const poseidon = await getCachedPoseidon();
  const pdas = derivePDAs(denomination);
  const { statePda, vaultPda, ringMetaPda } = pdas;

  // Read state + ring metadata
  const [stateAccount, ringMeta] = await Promise.all([
    connection.getAccountInfo(statePda),
    connection.getAccountInfo(ringMetaPda),
  ]);
  if (!stateAccount) throw new Error("Pool state not found. Is the pool initialized?");
  if (!ringMeta) throw new Error("Ring metadata not found. Is the pool fully initialized?");

  const currentLeafCount = readLeafCount(stateAccount.data);
  const expectedLeafIndex = currentLeafCount;
  const frontierBefore = readFrontier(stateAccount.data);
  const activeShardIndex = ringMeta.data.readUInt32LE(32);
  const activeShardPda = deriveShardPda(statePda, activeShardIndex);

  // Generate secrets
  const nullifierBytes = crypto.randomBytes(31);
  const secretBytes = crypto.randomBytes(31);
  const nullifier = BigInt("0x" + nullifierBytes.toString("hex")) % FIELD_MODULUS;
  const secret = BigInt("0x" + secretBytes.toString("hex")) % FIELD_MODULUS;

  // V1 commitment = Poseidon(nullifier, secret) — no amount
  const commitmentField = poseidon([nullifier, secret]);
  const commitment = poseidon.F.toObject(commitmentField);
  const commitmentBE = fieldToBytesBE(commitment);

  const nullifierHashField = poseidon([nullifier]);
  const nullifierHash = poseidon.F.toObject(nullifierHashField);
  const nullifierHashBE = fieldToBytesBE(nullifierHash);

  // =========================================================================
  // CRITICAL: Save PENDING note to disk BEFORE sending transaction
  // =========================================================================
  const pendingNote = {
    status: "pending",
    version: 3,
    poolId,
    network,
    programId: PROGRAM_ID.toBase58(),
    denomination: denomination.toString(),
    nullifier: nullifier.toString(16).padStart(62, "0"),
    secret: secret.toString(16).padStart(62, "0"),
    commitment: commitmentBE.toString("hex"),
    nullifierHash: nullifierHashBE.toString("hex"),
    expectedLeafIndex,
    frontierBefore,
    shardIndex: activeShardIndex,
    createdAt: new Date().toISOString(),
  };

  const pendingFilename = `pending_${String(expectedLeafIndex).padStart(5, "0")}_${Date.now()}.json`;
  const pendingPath = path.join(notesDir, pendingFilename);
  fs.writeFileSync(pendingPath, JSON.stringify(pendingNote, null, 2));
  console.log(`  [V3] Pending note saved: ${pendingPath}`);

  // =========================================================================
  // Build transaction: ComputeBudget + Deposit + Memo
  // =========================================================================
  // Exact V1 deposit data format (proven working):
  // disc(8) + commitment_be(32) + light_enabled(1) + light_proof_len(4) + output_tree_idx(1) + light_offset(1) = 47 bytes
  const depositDisc = discriminator("deposit_v2_clean");
  const depositData = Buffer.concat([
    depositDisc,           // 8 bytes
    commitmentBE,          // 32 bytes
    Buffer.alloc(7),       // light_enabled=0, light_proof_bytes=[], output_tree_index=0, light_accounts_offset=0
  ]);

  // Exact V1 account order (9 accounts — proven working):
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_COMPUTE_UNITS }))
    .add({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: statePda, isSigner: false, isWritable: true },             // 0: pool_state
        { pubkey: vaultPda, isSigner: false, isWritable: true },             // 1: vault
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },      // 2: depositor
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 3: system_program
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },          // 4: cooldown_config (skip)
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },          // 5: user_cooldown (skip)
        { pubkey: pdas.rootRingPda, isSigner: false, isWritable: true },     // 6: root_ring (legacy, writable)
        { pubkey: pdas.ringMetaPda, isSigner: false, isWritable: true },     // 7: root_ring_metadata
        { pubkey: activeShardPda, isSigner: false, isWritable: true },       // 8: active_shard
      ],
      data: depositData,
    });

  // Add encrypted memo instruction (MANDATORY)
  if (options.encryptionKey) {
    const memoPayload = {
      d: denomination.toString(),
      n: nullifier.toString(16).padStart(62, "0"),
      s: secret.toString(16).padStart(62, "0"),
      v: 3,
    };
    const memoText = encryptMemo(options.encryptionKey, memoPayload);
    tx.add(buildMemoInstruction(memoText));
  }

  // Send transaction
  console.log(`  [V3] Sending deposit tx (leaf=${expectedLeafIndex}, denom=${denomLabel} SOL)...`);
  const depositTx = await sendAndConfirmTransaction(connection, tx, [wallet], {
    commitment: "confirmed",
  });
  console.log(`  [V3] Deposit confirmed: ${depositTx}`);

  // =========================================================================
  // Finalize note: parse deposit event for authoritative pathElements
  // =========================================================================
  const txInfo = await connection.getTransaction(depositTx, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });

  let leafIndex = expectedLeafIndex;
  let pathElements = [];
  let pathIndices = [];
  let merkleRoot = "";

  if (txInfo?.meta?.logMessages) {
    // Parse DepositProofData event from logs
    // Layout: disc(8) + leaf_index(4) + root_after(32) + siblings_be(20×32=640) + positions(20) = 704 bytes
    const DPD_DISC = crypto.createHash("sha256").update("event:DepositProofData").digest().slice(0, 8);
    for (const log of txInfo.meta.logMessages) {
      if (!log.startsWith("Program data: ")) continue;
      const buf = Buffer.from(log.slice("Program data: ".length), "base64");
      if (buf.length < 704 || !buf.slice(0, 8).equals(DPD_DISC)) continue;

      // Canonical parsing (matches tools/parse-deposit-event.js and sdk/deposit-finalize.js)
      let off = 8;
      leafIndex = buf.readUInt32LE(off); off += 4;           // offset 8: leaf_index (u32 LE)
      merkleRoot = buf.slice(off, off + 32).toString("hex"); off += 32; // offset 12: root_after (32 bytes BE)
      for (let i = 0; i < 20; i++) {                         // offset 44: siblings_be (20 × 32 bytes BE)
        pathElements.push(buf.slice(off, off + 32).toString("hex"));
        off += 32;
      }
      for (let i = 0; i < 20; i++) {                         // offset 684: positions (20 × u8)
        pathIndices.push(buf.readUInt8(off + i));
      }
      console.log(`  [V3] Event parsed: leaf=${leafIndex}, root=${merkleRoot.slice(0, 20)}...`);
      break;
    }
  }

  // If no event found, compute from frontier (fallback)
  if (pathElements.length === 0) {
    console.warn("  [V3] WARNING: No DepositProofData event found. Computing from frontier.");
    const { computeMerklePath, computeRoot } = require("./canonical.js");
    const path = computeMerklePath(expectedLeafIndex, frontierBefore);
    pathElements = path.pathElements.map(e => fieldToBytesBE(e).toString("hex"));
    pathIndices = path.pathIndices;
    merkleRoot = computeRoot(poseidon, commitment, path.pathElements, path.pathIndices)
      .toString(16).padStart(64, "0");
  }

  // =========================================================================
  // Save complete note
  // =========================================================================
  const completeNote = {
    version: 3,
    poolId,
    network,
    programId: PROGRAM_ID.toBase58(),
    denomination: denomination.toString(),
    nullifier: nullifier.toString(16).padStart(62, "0"),
    secret: secret.toString(16).padStart(62, "0"),
    commitment: commitmentBE.toString("hex"),
    nullifierHash: nullifierHashBE.toString("hex"),
    leafIndex,
    pathElements,
    pathIndices,
    currentRoot: merkleRoot,
    shardIndex: activeShardIndex,
    depositTx,
    depositSlot: txInfo?.slot,
    depositTimestamp: new Date().toISOString(),
    status: "verified",
  };

  const noteFilename = `note_${String(leafIndex).padStart(5, "0")}.json`;
  const notePath = path.join(notesDir, noteFilename);
  fs.writeFileSync(notePath, JSON.stringify(completeNote, null, 2));
  console.log(`  [V3] Complete note saved: ${notePath}`);

  // Remove pending file
  try { fs.unlinkSync(pendingPath); } catch (_) {}

  return {
    leafIndex,
    txSignature: depositTx,
    notePath,
    commitment: commitmentBE.toString("hex"),
    shardIndex: activeShardIndex,
  };
}

module.exports = { deposit, encryptMemo, buildMemoInstruction, getCachedPoseidon };
