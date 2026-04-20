/**
 * ZeroK v2-core — Witness Builders
 *
 * Pure math witness construction for JoinSplit and Re-denomination circuits.
 * Takes poseidon as a parameter. No snarkjs, no file I/O.
 */

'use strict';

const { FIELD_MODULUS, TREE_DEPTH } = require('./constants.js');
const { splitAddress } = require('./field.js');
const { computeCommitment, computeNullifierHash, generateNote } = require('./note.js');
const { computeRoot } = require('./merkle.js');

// ─────────────────────────────────────────────────────────────────────────────
// JoinSplit Witness
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the full witness for the JoinSplit circuit (withdrawal).
 *
 * Input note (private):   { amount, nullifier, secret, pathElements, pathIndices }
 * Change note (private):  { amount, nullifier, secret } — generated fresh
 * Public:                 { root, withdrawal_amount, fee_amount, recipient, relayer }
 *
 * @param {Object} poseidon - circomlibjs poseidon instance
 * @param {Object} params
 * @param {Object}      params.inputNote         - The note being spent
 * @param {string}      params.merkleRoot        - Root the proof is computed against (hex)
 * @param {bigint}      params.withdrawalAmount  - Lamports being withdrawn (public)
 * @param {bigint}      params.feeAmount         - Protocol fee (public)
 * @param {Uint8Array}  params.recipientBytes    - 32-byte recipient pubkey
 * @param {Uint8Array}  params.relayerBytes      - 32-byte relayer pubkey
 * @returns {{ witness: Object, changeNote: Object, nullifierHash: bigint, outCommitment: bigint }}
 */
function buildJoinSplitWitness(poseidon, params) {
  const { inputNote, merkleRoot, withdrawalAmount, feeAmount, recipientBytes, relayerBytes } = params;

  const inAmount    = BigInt(inputNote.amount);
  const inNullifier = BigInt(inputNote.nullifier);
  const inSecret    = BigInt(inputNote.secret);

  // JoinSplit balance: inAmount = withdrawal + change
  // Fee is deducted from recipient payout on-chain, not from vault balance.
  const outAmount = inAmount - BigInt(withdrawalAmount);
  if (outAmount < 0n) {
    throw new Error(`JoinSplit balance error: inAmount(${inAmount}) < withdrawal(${withdrawalAmount})`);
  }

  // Generate fresh change note
  const changeRaw = generateNote(outAmount);
  const outNullifier = changeRaw.nullifier;
  const outSecret    = changeRaw.secret;

  // Compute commitments
  const nullifierHash = computeNullifierHash(poseidon, inNullifier);
  const outCommitment = computeCommitment(poseidon, outAmount, outNullifier, outSecret);

  // Verify the claimed root matches the Merkle path
  const pathElements = inputNote.pathElements.map(e => BigInt(e));
  const pathIndices  = inputNote.pathIndices;
  const inCommitment = computeCommitment(poseidon, inAmount, inNullifier, inSecret);
  const computedRoot = computeRoot(poseidon, inCommitment, pathElements, pathIndices);

  const rootFromHex = BigInt('0x' + merkleRoot.replace('0x', ''));
  if ((computedRoot % FIELD_MODULUS) !== (rootFromHex % FIELD_MODULUS)) {
    throw new Error(
      `Merkle root mismatch. Note root: ${computedRoot.toString(16).slice(0, 16)}... ` +
      `Pool root: ${merkleRoot.slice(0, 16)}...`
    );
  }

  // Split recipient and relayer into high/low for circuit binding
  const recipientSplit = splitAddress(recipientBytes);
  const relayerSplit   = splitAddress(relayerBytes);

  // Build circom witness (all values as decimal strings — snarkjs requirement)
  const witness = {
    root:                    rootFromHex.toString(),
    nullifierHash:           nullifierHash.toString(),
    publicWithdrawalAmount:  withdrawalAmount.toString(),
    feeAmount:               feeAmount.toString(),
    outCommitment:           outCommitment.toString(),
    recipientHigh:           recipientSplit.high.toString(),
    recipientLow:            recipientSplit.low.toString(),
    relayerHigh:             relayerSplit.high.toString(),
    relayerLow:              relayerSplit.low.toString(),

    inAmount:       inAmount.toString(),
    inNullifier:    inNullifier.toString(),
    inSecret:       inSecret.toString(),
    pathElements:   pathElements.map(e => e.toString()),
    pathIndices:    pathIndices.map(i => i.toString()),

    outAmount:      outAmount.toString(),
    outNullifier:   outNullifier.toString(),
    outSecret:      outSecret.toString(),
  };

  return {
    witness,
    changeNote: {
      version:    'v2',
      amount:     outAmount.toString(),
      nullifier:  outNullifier.toString(),
      secret:     outSecret.toString(),
      spent: false,
    },
    nullifierHash,
    outCommitment,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-denomination Witness
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the witness for the re-denomination circuit (1 source → 10 target).
 *
 * @param {Object} poseidon
 * @param {Object} params
 * @param {Object}   params.inputNote     - Source note being broken
 * @param {bigint}   params.sourceDenom   - Source denomination in lamports
 * @param {bigint}   params.targetDenom   - Target denomination (sourceDenom / 10)
 * @param {string}   params.merkleRoot    - Source pool Merkle root (hex)
 * @param {bigint[]} params.pathElements  - Source note Merkle path
 * @param {number[]} params.pathIndices   - Source note Merkle indices
 * @returns {{
 *   witness: Object,
 *   targetNotes: Object[],
 *   targetCommitments: bigint[],
 *   nullifierHash: bigint,
 * }}
 */
function buildReDenomWitness(poseidon, params) {
  const { inputNote, sourceDenom, targetDenom, merkleRoot, pathElements, pathIndices } = params;

  const srcDenom = BigInt(sourceDenom);
  const tgtDenom = BigInt(targetDenom);

  if (srcDenom !== tgtDenom * 10n) {
    throw new Error(`Invalid re-denomination ratio: ${srcDenom} != ${tgtDenom} × 10`);
  }

  // Generate 10 target notes
  const targetNotes = [];
  const targetCommitments = [];
  const targetNullifiers = [];
  const targetSecrets = [];

  for (let i = 0; i < 10; i++) {
    const note = generateNote(tgtDenom);
    const commitment = computeCommitment(poseidon, tgtDenom, note.nullifier, note.secret);

    targetNotes.push({
      version: 'v2',
      amount: tgtDenom.toString(),
      nullifier: note.nullifier.toString(),
      secret: note.secret.toString(),
      commitment: commitment.toString(),
      nullifierHash: computeNullifierHash(poseidon, note.nullifier).toString(),
      leafIndex: -1,
      merkleRoot: '',
      pathElements: [],
      pathIndices: [],
      spent: false,
    });

    targetCommitments.push(commitment);
    targetNullifiers.push(note.nullifier);
    targetSecrets.push(note.secret);
  }

  // Compute source nullifier hash
  const nullifierHash = computeNullifierHash(poseidon, BigInt(inputNote.nullifier));

  // Build circom witness
  const witness = {
    sourceRoot: BigInt('0x' + merkleRoot).toString(),
    sourceNullifierHash: nullifierHash.toString(),
    targetCommitments: targetCommitments.map(c => c.toString()),
    sourceAmount: srcDenom.toString(),
    sourceNullifier: inputNote.nullifier.toString(),
    sourceSecret: inputNote.secret.toString(),
    pathElements: pathElements.map(e => e.toString()),
    pathIndices: pathIndices.map(i => Number(i)),
    targetAmount: tgtDenom.toString(),
    targetNullifiers: targetNullifiers.map(n => n.toString()),
    targetSecrets: targetSecrets.map(s => s.toString()),
  };

  return {
    witness,
    targetNotes,
    targetCommitments,
    nullifierHash,
  };
}

module.exports = { buildJoinSplitWitness, buildReDenomWitness };
