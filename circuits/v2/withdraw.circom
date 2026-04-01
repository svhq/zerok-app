pragma circom 2.1.5;

// ZeroK v2 JoinSplit Withdrawal Circuit
// Architecture reference: Tornado Cash Nova (ISC License)
// Original: https://github.com/tornadocash/tornado-nova
// Key adaptations from Nova:
//   - Poseidon(amount, nullifier, secret) commitment instead of keypair-based
//   - pathIndices[levels] array instead of packed scalar
//   - 1-in-1-out JoinSplit with explicit protocol fee
//   - No Light Protocol — raw commitment is the Merkle leaf

include "../../node_modules/circomlib/circuits/poseidon.circom";
include "../../node_modules/circomlib/circuits/bitify.circom";

// Reused verbatim from circuits/withdraw.circom — identical quadratic constraint pattern
template MerkleTreeChecker(levels) {
    signal input leaf;
    signal input root;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component hashers[levels];
    component indexBits[levels];

    signal currentHash[levels + 1];
    currentHash[0] <== leaf;

    signal left[levels];
    signal right[levels];

    for (var i = 0; i < levels; i++) {
        indexBits[i] = Num2Bits(1);
        indexBits[i].in <== pathIndices[i];

        left[i] <== (pathElements[i] - currentHash[i]) * indexBits[i].out[0] + currentHash[i];
        right[i] <== (currentHash[i] - pathElements[i]) * indexBits[i].out[0] + pathElements[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== left[i];
        hashers[i].inputs[1] <== right[i];

        currentHash[i + 1] <== hashers[i].out;
    }

    root === currentHash[levels];
}

// JoinSplit withdrawal: spend one input note, create one change note
// Proves: inAmount === publicWithdrawalAmount + outAmount
// Fee is deducted from recipient payout on-chain (not from vault balance)
template JoinSplitWithdraw(levels) {
    // === PUBLIC inputs ===
    signal input root;
    signal input nullifierHash;
    signal input publicWithdrawalAmount;
    signal input feeAmount;
    signal input outCommitment;
    signal input recipientHigh;
    signal input recipientLow;
    signal input relayerHigh;
    signal input relayerLow;

    // === PRIVATE inputs: input note ===
    signal input inAmount;
    signal input inNullifier;
    signal input inSecret;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // === PRIVATE inputs: change note ===
    signal input outAmount;
    signal input outNullifier;
    signal input outSecret;

    // --- Constraint 1: Compute input commitment ---
    component inHasher = Poseidon(3);
    inHasher.inputs[0] <== inAmount;
    inHasher.inputs[1] <== inNullifier;
    inHasher.inputs[2] <== inSecret;

    // --- Constraint 2: Input note exists in Merkle tree ---
    component merkle = MerkleTreeChecker(levels);
    merkle.leaf <== inHasher.out;
    merkle.root <== root;
    for (var i = 0; i < levels; i++) {
        merkle.pathElements[i] <== pathElements[i];
        merkle.pathIndices[i] <== pathIndices[i];
    }

    // --- Constraint 3: Nullifier hash ---
    component nullHasher = Poseidon(1);
    nullHasher.inputs[0] <== inNullifier;
    nullHasher.out === nullifierHash;

    // --- Constraint 4: Change note commitment ---
    component outHasher = Poseidon(3);
    outHasher.inputs[0] <== outAmount;
    outHasher.inputs[1] <== outNullifier;
    outHasher.inputs[2] <== outSecret;
    outHasher.out === outCommitment;

    // --- Constraint 5: JoinSplit balance invariant ---
    inAmount === publicWithdrawalAmount + outAmount;

    // --- Constraint 6: Range checks (64-bit) ---
    component inRange  = Num2Bits(64); inRange.in  <== inAmount;
    component outRange = Num2Bits(64); outRange.in <== outAmount;
    component wRange   = Num2Bits(64); wRange.in   <== publicWithdrawalAmount;
    component fRange   = Num2Bits(64); fRange.in   <== feeAmount;

    // --- Constraint 7: Recipient/relayer binding ---
    signal recipientHighSquare <== recipientHigh * recipientHigh;
    signal recipientLowSquare  <== recipientLow  * recipientLow;
    signal relayerHighSquare   <== relayerHigh   * relayerHigh;
    signal relayerLowSquare    <== relayerLow    * relayerLow;
}

component main {public [root, nullifierHash, publicWithdrawalAmount, feeAmount, outCommitment,
                         recipientHigh, recipientLow, relayerHigh, relayerLow]}
    = JoinSplitWithdraw(20);
