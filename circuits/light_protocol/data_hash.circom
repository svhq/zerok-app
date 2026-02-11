pragma circom 2.1.5;

include "../../node_modules/circomlib/circuits/poseidon.circom";

/**
 * DataHash Gadget
 *
 * Computes data_hash = Poseidon(commitment) matching Light Protocol's
 * CompressedAccountData.data_hash field.
 *
 * Light Protocol pre-hashes the commitment before including it in the leaf.
 * This is a critical wrapper - the leaf does NOT contain the raw commitment.
 */
template DataHash() {
    signal input commitment;   // Field element (Poseidon output from nullifier+secret)
    signal output data_hash;   // Field element (Poseidon hash of commitment)

    // Simple single-input Poseidon hash
    component hasher = Poseidon(1);
    hasher.inputs[0] <== commitment;

    data_hash <== hasher.out;
}
