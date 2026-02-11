pragma circom 2.1.5;

include "../../node_modules/circomlib/circuits/poseidon.circom";
include "./data_hash.circom";
include "./discriminator_field.circom";

/**
 * LightLeafHash - Minimal Poseidon-Only Implementation
 *
 * Computes Light Protocol's leaf hash WITHOUT Keccak gadgets.
 * Treats owner_hash and tree_hash as pre-computed public inputs.
 *
 * Formula:
 *   leaf = Poseidon([
 *       owner_hash,           // Pre-computed: hash_to_bn254_field_size_be(owner_pubkey)
 *       leaf_index,           // Field element (u32 value, represents 32-byte big-endian)
 *       tree_hash,            // Pre-computed: hash_to_bn254_field_size_be(tree_pubkey)
 *       discriminator_field,  // Field element from tagged discriminator bytes
 *       data_hash             // Poseidon(commitment)
 *   ])
 *
 * Design Philosophy (from Brief 1):
 *   "You don't need to prove pubkey hashing inside the circuit. Light Protocol
 *   already enforces that owner_hash and tree_hash are correctly computed when
 *   creating compressed accounts. The circuit only needs to prove the link:
 *   (nullifier, secret) -> commitment -> data_hash -> leaf -> root"
 *
 * Security:
 *   - Attacker can't provide fake owner_hash/tree_hash and benefit, because:
 *     * They still need a valid Merkle path to the real on-chain root
 *     * The on-chain root only contains properly-formed leaves from Light Protocol
 *     * Light Protocol enforces hash_to_bn254_field_size_be at account creation
 */
template LightLeafHash() {
    // Public inputs (pre-computed off-chain)
    signal input owner_hash;           // Already hashed: hash_to_bn254_field_size_be(owner_pubkey)
    signal input tree_hash;            // Already hashed: hash_to_bn254_field_size_be(tree_pubkey)

    // Public input (varies per note)
    signal input leaf_index;           // u32 value (0 to 4294967295)

    // Constant input (same for all ZeroK accounts)
    signal input discriminator[8];     // 8-byte account type discriminator

    // Private input (user's secret)
    signal input commitment;           // Poseidon(nullifier, secret)

    // Output
    signal output leaf;                // Final Light Protocol leaf hash

    // Step 1: Compute data_hash = Poseidon(commitment)
    component dataHasher = DataHash();
    dataHasher.commitment <== commitment;
    signal data_hash;
    data_hash <== dataHasher.data_hash;

    // Step 2: Convert discriminator to field element
    // Computes: 2*256^8 + disc[0]*256^7 + ... + disc[7]*256^0
    component discConverter = DiscriminatorToField();
    for (var i = 0; i < 8; i++) {
        discConverter.discriminator[i] <== discriminator[i];
    }
    signal discriminator_field;
    discriminator_field <== discConverter.field;

    // Step 3: Note on leaf_index
    // The 32-byte big-endian encoding of a u32 in the last 4 bytes,
    // when interpreted as a field element, equals the u32 value itself.
    // Therefore, we use leaf_index directly (no conversion gadget needed).

    // Step 4: Compute final leaf hash with Poseidon(5 inputs)
    component leafHasher = Poseidon(5);
    leafHasher.inputs[0] <== owner_hash;
    leafHasher.inputs[1] <== leaf_index;           // Direct use as field element
    leafHasher.inputs[2] <== tree_hash;
    leafHasher.inputs[3] <== discriminator_field;
    leafHasher.inputs[4] <== data_hash;

    leaf <== leafHasher.out;
}
