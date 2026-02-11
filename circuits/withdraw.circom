pragma circom 2.1.5;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "./light_protocol/light_leaf_hash.circom";

// Elegant Merkle tree verification matching our Rust implementation
template MerkleTreeChecker(levels) {
    signal input leaf;
    signal input root;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component hashers[levels];
    component indexBits[levels];

    signal currentHash[levels + 1];
    currentHash[0] <== leaf;

    // Intermediate signals for quadratic constraints
    signal left[levels];
    signal right[levels];

    for (var i = 0; i < levels; i++) {
        // Convert index to bit for path selection
        indexBits[i] = Num2Bits(1);
        indexBits[i].in <== pathIndices[i];

        // Compute left and right inputs using quadratic constraints
        // When pathIndices[i] = 0: left = currentHash[i], right = pathElements[i]
        // When pathIndices[i] = 1: left = pathElements[i], right = currentHash[i]
        left[i] <== (pathElements[i] - currentHash[i]) * indexBits[i].out[0] + currentHash[i];
        right[i] <== (currentHash[i] - pathElements[i]) * indexBits[i].out[0] + pathElements[i];

        // Hash with Poseidon matching Light Protocol's new_circom(2)
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== left[i];
        hashers[i].inputs[1] <== right[i];

        currentHash[i + 1] <== hashers[i].out;
    }

    // Verify the computed root matches
    root === currentHash[levels];
}

// Main withdrawal circuit - elegant and minimal
template Withdraw(levels) {
    // Public inputs (what the contract sees)
    // Solana addresses split into high/low parts to fit BN254 field (32 bytes > 254 bits)
    signal input root;
    signal input nullifierHash;
    signal input recipientHigh;  // Bytes 0-15 of recipient pubkey (padded to 32 bytes)
    signal input recipientLow;   // Bytes 16-31 of recipient pubkey (padded to 32 bytes)
    signal input feePayerHigh;   // Bytes 0-15 of fee payer pubkey (padded to 32 bytes)
    signal input feePayerLow;    // Bytes 16-31 of fee payer pubkey (padded to 32 bytes)
    signal input fee;
    signal input refund;

    // Light Protocol compressed account metadata (public)
    signal input owner_hash;      // hash_to_bn254_field_size_be(owner_pubkey)
    signal input tree_hash;       // hash_to_bn254_field_size_be(tree_pubkey)
    signal input leaf_index;      // u32 leaf index in the tree
    signal input discriminator[8]; // 8-byte account discriminator

    // Private inputs (user's secrets)
    signal input nullifier;
    signal input secret;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // Compute commitment = Poseidon(nullifier, secret)
    component commitmentHasher = Poseidon(2);
    commitmentHasher.inputs[0] <== nullifier;
    commitmentHasher.inputs[1] <== secret;

    // Compute nullifier hash = Poseidon(nullifier)
    // Using Poseidon(1) to match Light Protocol's new_circom(1)
    component nullifierHasher = Poseidon(1);
    nullifierHasher.inputs[0] <== nullifier;
    nullifierHasher.out === nullifierHash;

    // Compute Light Protocol leaf hash from commitment
    // This wraps the commitment with compressed account metadata
    component lightLeafHasher = LightLeafHash();
    lightLeafHasher.owner_hash <== owner_hash;
    lightLeafHasher.tree_hash <== tree_hash;
    lightLeafHasher.leaf_index <== leaf_index;
    for (var i = 0; i < 8; i++) {
        lightLeafHasher.discriminator[i] <== discriminator[i];
    }
    lightLeafHasher.commitment <== commitmentHasher.out;

    // Verify merkle proof using Light Protocol leaf
    component tree = MerkleTreeChecker(levels);
    tree.leaf <== lightLeafHasher.leaf;  // Use Light Protocol leaf instead of raw commitment
    tree.root <== root;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }

    // Add dummy constraints to prevent tampering with address parts
    signal recipientHighSquare;
    signal recipientLowSquare;
    signal feePayerHighSquare;
    signal feePayerLowSquare;
    signal feeSquare;
    signal refundSquare;

    recipientHighSquare <== recipientHigh * recipientHigh;
    recipientLowSquare <== recipientLow * recipientLow;
    feePayerHighSquare <== feePayerHigh * feePayerHigh;
    feePayerLowSquare <== feePayerLow * feePayerLow;
    feeSquare <== fee * fee;
    refundSquare <== refund * refund;
}

// Instantiate with 20 levels matching our Rust Merkle tree
// Public inputs (12): root, nullifierHash, recipientHigh, recipientLow, feePayerHigh, feePayerLow, fee, refund,
//                      owner_hash, tree_hash, leaf_index, discriminator[8]
component main {public [root, nullifierHash, recipientHigh, recipientLow, feePayerHigh, feePayerLow, fee, refund, owner_hash, tree_hash, leaf_index, discriminator]} = Withdraw(20);
