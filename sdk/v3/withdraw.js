/**
 * V3 Withdraw Module (CLI)
 *
 * Generates Groth16 proof and submits withdrawal to the protocol relay.
 * The relay pays all network fees — recipient never needs SOL.
 *
 * Based on V1 withdraw.js adapted for V3 canonical constants.
 * Circuit: 8 public inputs (no Light Protocol fields).
 */

'use strict';

const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} = require("@solana/web3.js");
const { buildPoseidon } = require("circomlibjs");
const snarkjs = require("snarkjs");
const fs = require("fs");
const path = require("path");

const {
  PROGRAM_ID,
  STATE_OFFSETS,
  FIELD_MODULUS,
  TREE_DEPTH,
  NUM_SHARDS,
  fieldToBytesBE,
  hexToFr,
  readRoot,
  readLeafCount,
  derivePDAs,
  deriveShardPda,
  deriveAllShardPdas,
  deriveNullifierPda,
  discriminator,
  splitAddress,
  serializeProof,
  isRootInShardRing,
} = require("./canonical.js");

const { buildV3Witness } = require("../v2-core/v3-witness.js");

// =============================================================================
// CONFIGURATION
// =============================================================================

// V1 circuit artifacts (8 public inputs, no Light Protocol)
const CIRCUIT_WASM = path.join(__dirname, "../../circuits/build/withdraw_fixed_js/withdraw_fixed.wasm");
const CIRCUIT_ZKEY = path.join(__dirname, "../../circuits/build/withdraw_final.zkey");
const DEFAULT_COMPUTE_UNITS = 400_000;

let _poseidonPromise = null;
function getPoseidon() {
  if (!_poseidonPromise) _poseidonPromise = buildPoseidon();
  return _poseidonPromise;
}

// =============================================================================
// PRE-FLIGHT CHECK
// =============================================================================

/**
 * Check if a V3 note is withdrawable.
 * Checks: nullifier not spent, root exists in state history or shard ring.
 */
async function checkNote(connection, note) {
  const required = ["nullifier", "secret", "leafIndex", "currentRoot", "pathElements", "pathIndices"];
  const missing = required.filter(f => note[f] === undefined || note[f] === null);
  if (missing.length > 0) {
    return { withdrawable: false, reason: `Missing fields: ${missing.join(", ")}` };
  }

  const denomination = BigInt(note.denomination);
  const pdas = derivePDAs(denomination);

  // Check nullifier not spent
  const poseidon = await getPoseidon();
  const nullifier = hexToFr(note.nullifier);
  const nullifierHash = poseidon.F.toObject(poseidon([nullifier]));
  const nullifierHashBE = fieldToBytesBE(nullifierHash);
  const nullifierPda = deriveNullifierPda(pdas.statePda, nullifierHashBE);

  const nullifierAccount = await connection.getAccountInfo(nullifierPda);
  if (nullifierAccount) {
    return { withdrawable: false, reason: "Nullifier already spent" };
  }

  // Check root in shard ring
  const rootBytes = Buffer.from(note.currentRoot, "hex");
  const { found, shardIndex } = await isRootInShardRing(connection, pdas.statePda, rootBytes);

  if (!found) {
    return { withdrawable: false, reason: "Root not found in state history or shard ring (evicted)" };
  }

  return {
    withdrawable: true,
    reason: shardIndex >= 0 ? `Root in shard ${shardIndex}` : "Root in state history",
  };
}

// =============================================================================
// RELAY-BASED WITHDRAWAL
// =============================================================================

/**
 * Submit withdrawal to the protocol relay.
 * Relay pays gas + nullifier PDA rent, takes 0.3% fee.
 */
async function submitToRelay(relayUrl, withdrawalRequest) {
  const url = `${relayUrl.replace(/\/$/, "")}/v3/withdraw`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(withdrawalRequest),
    });

    const body = await response.json();

    if (response.status === 409 && attempt < 2) {
      const retryMs = parseInt(process.env.RELAY_RETRY_MS || "500");
      await new Promise(r => setTimeout(r, retryMs * (attempt + 1)));
      continue;
    }

    if (!response.ok || body.error || !body.signature) {
      throw new Error(`Relay error (${response.status}): ${body.error || body.message || JSON.stringify(body)}`);
    }

    return body;
  }
}

// =============================================================================
// DIRECT WITHDRAWAL (payer signs tx locally)
// =============================================================================

/**
 * Withdraw from a V3 pool (direct — payer signs transaction).
 * For relay-based withdrawal, use withdrawViaRelay() instead.
 */
async function withdraw(params) {
  const { connection, note, recipient, wallet, options = {} } = params;

  const relayer = options.relayer || recipient;
  const fee = options.fee || 0n;
  const refund = 0n;

  // Pre-flight
  if (!options.skipPreCheck) {
    const status = await checkNote(connection, note);
    if (!status.withdrawable) {
      return { success: false, error: status.reason };
    }
    console.log(`  Pre-check: ${status.reason}`);
  }

  const denomination = BigInt(note.denomination);
  const pdas = derivePDAs(denomination);
  const { statePda, vaultPda, vkPda, ringMetaPda } = pdas;
  const poseidon = await getPoseidon();

  // Parse secrets
  const nullifier = hexToFr(note.nullifier);
  const secret = hexToFr(note.secret);
  const pathElements = note.pathElements.map(hex => hexToFr(hex));

  // Build witness using shared V3 core (same code as browser uses)
  const { witness: circuitInput, nullifierHash, computedRoot } = buildV3Witness(poseidon, {
    nullifier, secret, pathElements,
    pathIndices: note.pathIndices,
    recipientBytes: recipient.toBytes(),
    relayerBytes: (fee > 0n ? relayer : recipient).toBytes(),
    fee,
  });

  // Verify root matches note's stored root
  const computedRootHex = fieldToBytesBE(computedRoot).toString("hex");
  if (computedRootHex !== note.currentRoot) {
    return { success: false, error: `Root mismatch: computed ${computedRootHex.slice(0, 16)}... vs note ${note.currentRoot.slice(0, 16)}...` };
  }

  const nullifierHashBE = fieldToBytesBE(nullifierHash);
  const nullifierPda = deriveNullifierPda(statePda, nullifierHashBE);

  // Generate proof
  console.log("  Generating ZK proof...");
  if (!fs.existsSync(CIRCUIT_WASM)) {
    return { success: false, error: `Circuit WASM not found: ${CIRCUIT_WASM}` };
  }
  if (!fs.existsSync(CIRCUIT_ZKEY)) {
    return { success: false, error: `Circuit zkey not found: ${CIRCUIT_ZKEY}` };
  }

  const { proof } = await snarkjs.groth16.fullProve(circuitInput, CIRCUIT_WASM, CIRCUIT_ZKEY);
  console.log("  Proof generated");

  const proofBytes = serializeProof(proof);

  // Build instruction
  const disc = discriminator("withdraw_v2_clean");
  const proofVec = Buffer.concat([Buffer.alloc(4), proofBytes]);
  proofVec.writeUInt32LE(proofBytes.length, 0);

  const rootBuf = Buffer.from(note.currentRoot, "hex");
  const feeBuf = Buffer.alloc(8);
  feeBuf.writeBigUInt64LE(fee, 0);
  const refundBuf = Buffer.alloc(8);
  refundBuf.writeBigUInt64LE(refund, 0);

  const instructionData = Buffer.concat([disc, nullifierHashBE, proofVec, rootBuf, feeBuf, refundBuf]);

  // All 20 shard PDAs (required for root lookup)
  const shardPdas = deriveAllShardPdas(statePda);

  const withdrawIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: statePda, isSigner: false, isWritable: true },
      { pubkey: vkPda, isSigner: false, isWritable: false },
      { pubkey: nullifierPda, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: true },
      { pubkey: relayer, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },  // legacy root_ring placeholder
      { pubkey: ringMetaPda, isSigner: false, isWritable: false },
      ...shardPdas.map(pubkey => ({ pubkey, isSigner: false, isWritable: false })),
    ],
    data: instructionData,
  });

  // Build versioned transaction (v0 for ALT support)
  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_COMPUTE_UNITS });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

  // Try to load ALT if available
  let lookupTables = [];
  if (options.altAddress) {
    try {
      const altInfo = await connection.getAddressLookupTable(new PublicKey(options.altAddress));
      if (altInfo.value) lookupTables = [altInfo.value];
    } catch (_) {}
  }

  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [computeIx, withdrawIx],
  }).compileToV0Message(lookupTables);

  const tx = new VersionedTransaction(messageV0);
  tx.sign([wallet]);

  const txSize = tx.serialize().length;
  if (txSize > 1232) {
    return { success: false, error: `Transaction too large (${txSize} bytes). Need ALT.` };
  }

  console.log(`  Sending tx (${txSize} bytes)...`);
  const signature = await connection.sendTransaction(tx, { skipPreflight: false });
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");

  return { success: true, txSignature: signature };
}

module.exports = { withdraw, checkNote, submitToRelay, getPoseidon };
