use borsh::{BorshDeserialize, BorshSerialize};
use light_sdk::LightDiscriminator;

/// Zerok commitment stored in Light Protocol compressed state tree
///
/// This is the minimal data structure for Zerok deposits using Light Protocol.
/// The commitment is already a Poseidon hash of (nullifier, secret),
/// so we just store the 32-byte hash directly.
///
/// Light Protocol will wrap this with compressed account metadata:
/// - owner_hash: hash_to_bn254_field_size_be(zerok_program_id)
/// - tree_hash: hash_to_bn254_field_size_be(tree_pubkey)
/// - leaf_index: u32 position in the tree
/// - discriminator: 8-byte type identifier (auto-generated)
/// - data_hash: Poseidon(borsh::serialize(this struct))
///
/// The final leaf in the Merkle tree is:
/// leaf = Poseidon([owner_hash, leaf_index, tree_hash, discriminator_field, data_hash])
#[derive(
    Clone,
    Debug,
    Default,
    PartialEq,
    BorshSerialize,
    BorshDeserialize,
    LightDiscriminator,
)]
pub struct ZerokCommitment {
    /// The commitment hash: Poseidon(nullifier, secret)
    ///
    /// This is the only data we need to store in the compressed account.
    /// The commitment is already hashed off-chain by the client, so it's
    /// ready to be inserted into the Light Protocol tree.
    pub commitment: [u8; 32],
}

impl ZerokCommitment {
    /// Create a new ZerokCommitment from a 32-byte commitment hash
    ///
    /// # Arguments
    /// * `commitment` - The Poseidon hash of (nullifier, secret)
    ///
    /// # Example
    /// ```ignore
    /// let commitment = [0u8; 32]; // From client's Poseidon(nullifier, secret)
    /// let zerok_commitment = ZerokCommitment::new(commitment);
    /// ```
    pub fn new(commitment: [u8; 32]) -> Self {
        Self { commitment }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_zerok_commitment_creation() {
        let commitment = [1u8; 32];
        let zerok_commitment = ZerokCommitment::new(commitment);
        assert_eq!(zerok_commitment.commitment, commitment);
    }

    #[test]
    fn test_borsh_serialization() {
        let commitment = [42u8; 32];
        let zerok_commitment = ZerokCommitment::new(commitment);

        // Serialize
        let serialized = zerok_commitment.try_to_vec().unwrap();

        // Should be exactly 32 bytes (just the commitment field)
        assert_eq!(serialized.len(), 32);

        // Deserialize
        let deserialized = ZerokCommitment::try_from_slice(&serialized).unwrap();

        assert_eq!(zerok_commitment, deserialized);
    }

    #[test]
    fn test_light_discriminator_exists() {
        // The LightDiscriminator derive macro should generate a DISCRIMINATOR constant
        // This is used by Light Protocol to identify the account type
        // We can't directly test the discriminator value without accessing the generated code,
        // but we can verify the struct compiles with the derive macro
        let _commitment = ZerokCommitment::default();
    }
}
