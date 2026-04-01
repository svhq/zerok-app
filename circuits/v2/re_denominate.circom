pragma circom 2.1.5;

// ZeroK v2 Re-Denomination Circuit
// Privately breaks one note in a source pool into 10 notes in a target pool.
// Example: 1x10 SOL -> 10x1 SOL (one rung down the denomination ladder)
//
// Reuses the same MerkleTreeChecker and Poseidon patterns as withdraw.circom.
// No SOL leaves the system — value moves between pool vaults atomically.

include "../../node_modules/circomlib/circuits/poseidon.circom";
include "../../node_modules/circomlib/circuits/bitify.circom";

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

template ReDenominate(levels) {
    // === PUBLIC inputs ===
    signal input sourceRoot;
    signal input sourceNullifierHash;
    signal input targetCommitments[10];

    // === PRIVATE inputs: source note ===
    signal input sourceAmount;
    signal input sourceNullifier;
    signal input sourceSecret;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // === PRIVATE inputs: target notes ===
    signal input targetAmount;
    signal input targetNullifiers[10];
    signal input targetSecrets[10];

    // --- Constraint 1: Source commitment ---
    component srcHasher = Poseidon(3);
    srcHasher.inputs[0] <== sourceAmount;
    srcHasher.inputs[1] <== sourceNullifier;
    srcHasher.inputs[2] <== sourceSecret;

    // --- Constraint 2: Source note exists in source pool's Merkle tree ---
    component merkle = MerkleTreeChecker(levels);
    merkle.leaf <== srcHasher.out;
    merkle.root <== sourceRoot;
    for (var i = 0; i < levels; i++) {
        merkle.pathElements[i] <== pathElements[i];
        merkle.pathIndices[i] <== pathIndices[i];
    }

    // --- Constraint 3: Nullifier hash ---
    component nullHasher = Poseidon(1);
    nullHasher.inputs[0] <== sourceNullifier;
    nullHasher.out === sourceNullifierHash;

    // --- Constraint 4: Ratio enforcement ---
    sourceAmount === targetAmount * 10;

    // --- Constraint 5: Target commitments ---
    component targetHashers[10];
    for (var i = 0; i < 10; i++) {
        targetHashers[i] = Poseidon(3);
        targetHashers[i].inputs[0] <== targetAmount;
        targetHashers[i].inputs[1] <== targetNullifiers[i];
        targetHashers[i].inputs[2] <== targetSecrets[i];
        targetHashers[i].out === targetCommitments[i];
    }

    // --- Constraint 6: Range checks ---
    component srcRange = Num2Bits(64);
    srcRange.in <== sourceAmount;
    component tgtRange = Num2Bits(64);
    tgtRange.in <== targetAmount;
}

component main {public [sourceRoot, sourceNullifierHash, targetCommitments]}
    = ReDenominate(20);
