//! Enhanced Merkle Tree implementation with Poseidon hash support
//! 
//! This module provides a Merkle tree implementation that can use either
//! Keccak256 (for compatibility) or Poseidon (for ZK efficiency) as the hash function.

use anchor_lang::prelude::*;
use crate::poseidon_hash::PoseidonHasher;
use sha3::{Digest, Keccak256};

/// Hash algorithm selection for Merkle tree operations
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum HashAlgorithm {
    Keccak256,
    Poseidon,
}

/// Enhanced Merkle tree supporting both Keccak256 and Poseidon hashing
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct EnhancedMerkleTree {
    pub levels: u32,
    pub filled_subtrees: [[u8; 32]; 20],
    pub zeros: [[u8; 32]; 20],
    pub current_root: [u8; 32],
    pub next_index: u32,
    pub hash_algorithm: u8, // 0 = Keccak256, 1 = Poseidon
}

impl EnhancedMerkleTree {
    pub const SIZE: usize = 4 + (32 * 20) + (32 * 20) + 32 + 4 + 1;
    
    /// Create new Merkle tree with specified hash algorithm
    pub fn new(algorithm: HashAlgorithm) -> Self {
        let zeros = match algorithm {
            HashAlgorithm::Keccak256 => Self::generate_keccak_zeros(),
            HashAlgorithm::Poseidon => PoseidonHasher::generate_zero_values(),
        };
        
        let mut filled_subtrees = [[0u8; 32]; 20];
        for i in 0..20 {
            filled_subtrees[i] = zeros[i];
        }
        
        Self {
            levels: 20,
            filled_subtrees,
            zeros,
            current_root: zeros[19],
            next_index: 0,
            hash_algorithm: match algorithm {
                HashAlgorithm::Keccak256 => 0,
                HashAlgorithm::Poseidon => 1,
            },
        }
    }

    /// Create new Poseidon-based Merkle tree (recommended for ZK proofs)
    pub fn new_poseidon() -> Self {
        Self::new(HashAlgorithm::Poseidon)
    }

    /// Create new Keccak256-based Merkle tree (for compatibility)  
    pub fn new_keccak() -> Self {
        Self::new(HashAlgorithm::Keccak256)
    }

    /// Get the hash algorithm being used
    pub fn get_hash_algorithm(&self) -> HashAlgorithm {
        match self.hash_algorithm {
            0 => HashAlgorithm::Keccak256,
            _ => HashAlgorithm::Poseidon,
        }
    }

    /// Insert a leaf into the Merkle tree
    pub fn insert(&mut self, leaf: [u8; 32]) -> Result<u32> {
        require!(
            self.next_index < 2_u32.pow(self.levels),
            crate::ZerokError::MerkleTreeFull
        );
        
        let mut current_index = self.next_index;
        let mut current_level_hash = leaf;
        let mut left;
        let mut right;
        
        for i in 0..self.levels as usize {
            if current_index % 2 == 0 {
                left = current_level_hash;
                right = self.zeros[i];
                self.filled_subtrees[i] = current_level_hash;
            } else {
                left = self.filled_subtrees[i];
                right = current_level_hash;
            }
            
            current_level_hash = self.hash_pair(&left, &right);
            current_index /= 2;
        }
        
        self.current_root = current_level_hash;
        let inserted_index = self.next_index;
        self.next_index += 1;
        
        Ok(inserted_index)
    }

    /// Get the current Merkle root
    pub fn get_root(&self) -> [u8; 32] {
        self.current_root
    }

    /// Hash two nodes using the configured algorithm
    pub fn hash_pair(&self, left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
        match self.get_hash_algorithm() {
            HashAlgorithm::Keccak256 => Self::keccak_hash_pair(left, right),
            HashAlgorithm::Poseidon => PoseidonHasher::hash_pair(left, right),
        }
    }

    /// Hash a single value using the configured algorithm
    pub fn hash_single(&self, input: &[u8; 32]) -> [u8; 32] {
        match self.get_hash_algorithm() {
            HashAlgorithm::Keccak256 => Self::keccak_hash_single(input),
            HashAlgorithm::Poseidon => PoseidonHasher::hash_single(input),
        }
    }

    /// Generate Merkle proof for a given leaf index
    pub fn get_proof(&self, leaf_index: u32) -> Vec<[u8; 32]> {
        let mut proof = Vec::new();
        let mut index = leaf_index;
        
        for i in 0..self.levels as usize {
            if index % 2 == 0 {
                // Right sibling
                proof.push(self.zeros[i]);
            } else {
                // Left sibling
                proof.push(self.filled_subtrees[i]);
            }
            index /= 2;
        }
        
        proof
    }

    /// Verify a Merkle proof using the tree's hash algorithm
    pub fn verify_proof(
        &self,
        root: &[u8; 32],
        leaf: &[u8; 32],
        proof: &[[u8; 32]],
        index: u32,
    ) -> bool {
        let mut computed_hash = *leaf;
        let mut current_index = index;
        
        for sibling in proof {
            if current_index % 2 == 0 {
                computed_hash = self.hash_pair(&computed_hash, sibling);
            } else {
                computed_hash = self.hash_pair(sibling, &computed_hash);
            }
            current_index /= 2;
        }
        
        &computed_hash == root
    }

    /// Static method to verify proof with specified algorithm
    pub fn verify_proof_with_algorithm(
        algorithm: HashAlgorithm,
        root: &[u8; 32],
        leaf: &[u8; 32], 
        proof: &[[u8; 32]],
        index: u32,
    ) -> bool {
        let mut computed_hash = *leaf;
        let mut current_index = index;
        
        for sibling in proof {
            let next_hash = match algorithm {
                HashAlgorithm::Keccak256 => {
                    if current_index % 2 == 0 {
                        Self::keccak_hash_pair(&computed_hash, sibling)
                    } else {
                        Self::keccak_hash_pair(sibling, &computed_hash)
                    }
                },
                HashAlgorithm::Poseidon => {
                    if current_index % 2 == 0 {
                        PoseidonHasher::hash_pair(&computed_hash, sibling)
                    } else {
                        PoseidonHasher::hash_pair(sibling, &computed_hash)
                    }
                },
            };
            computed_hash = next_hash;
            current_index /= 2;
        }
        
        &computed_hash == root
    }

    // Private helper methods for Keccak256
    fn keccak_hash_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
        let mut hasher = Keccak256::new();
        hasher.update(left);
        hasher.update(right);
        let result = hasher.finalize();
        
        let mut output = [0u8; 32];
        output.copy_from_slice(&result);
        output
    }

    fn keccak_hash_single(data: &[u8; 32]) -> [u8; 32] {
        let mut hasher = Keccak256::new();
        hasher.update(data);
        let result = hasher.finalize();
        
        let mut output = [0u8; 32];
        output.copy_from_slice(&result);
        output
    }

    fn generate_keccak_zeros() -> [[u8; 32]; 20] {
        let mut zeros = [[0u8; 32]; 20];
        zeros[0] = Self::keccak_hash_single(&[0u8; 32]);
        
        for i in 1..20 {
            zeros[i] = Self::keccak_hash_pair(&zeros[i - 1], &zeros[i - 1]);
        }
        
        zeros
    }

    /// Convert this tree to use a different hash algorithm
    /// WARNING: This creates a completely new tree - existing commitments won't be valid!
    pub fn convert_to_algorithm(&self, new_algorithm: HashAlgorithm) -> Self {
        if new_algorithm == self.get_hash_algorithm() {
            return self.clone(); // No conversion needed
        }
        
        // Create a new tree with the new algorithm
        // Note: This doesn't preserve the existing tree state!
        Self::new(new_algorithm)
    }
}

#[cfg(test)]
mod enhanced_merkle_tests {
    use super::*;

    #[test]
    fn test_keccak_vs_poseidon_trees() {
        let mut keccak_tree = EnhancedMerkleTree::new_keccak();
        let mut poseidon_tree = EnhancedMerkleTree::new_poseidon();
        
        // Verify different algorithms produce different zero values
        assert_ne!(keccak_tree.zeros, poseidon_tree.zeros, 
                   "Keccak and Poseidon should generate different zero values");
        
        // Insert the same leaf into both trees
        let leaf = [0x42u8; 32];
        let keccak_index = keccak_tree.insert(leaf).unwrap();
        let poseidon_index = poseidon_tree.insert(leaf).unwrap();
        
        assert_eq!(keccak_index, poseidon_index, "Both trees should assign same index");
        
        // But roots should be different
        let keccak_root = keccak_tree.get_root();
        let poseidon_root = poseidon_tree.get_root();
        assert_ne!(keccak_root, poseidon_root, 
                   "Same leaf should produce different roots with different hash algorithms");
    }

    #[test]
    fn test_poseidon_tree_operations() {
        let mut tree = EnhancedMerkleTree::new_poseidon();
        
        // Test basic operations
        let leaf = [0xabu8; 32];
        let index = tree.insert(leaf).unwrap();
        assert_eq!(index, 0);
        
        let root = tree.get_root();
        let proof = tree.get_proof(index);
        
        // Verify proof works with tree's verify method
        assert!(tree.verify_proof(&root, &leaf, &proof, index));
        
        // Verify proof works with static method
        assert!(EnhancedMerkleTree::verify_proof_with_algorithm(
            HashAlgorithm::Poseidon,
            &root,
            &leaf,
            &proof,
            index
        ));
    }

    #[test]
    fn test_hash_algorithm_consistency() {
        let keccak_tree = EnhancedMerkleTree::new_keccak();
        let poseidon_tree = EnhancedMerkleTree::new_poseidon();
        
        assert_eq!(keccak_tree.get_hash_algorithm(), HashAlgorithm::Keccak256);
        assert_eq!(poseidon_tree.get_hash_algorithm(), HashAlgorithm::Poseidon);
        
        // Test serialization preserves algorithm choice
        assert_eq!(keccak_tree.hash_algorithm, 0);
        assert_eq!(poseidon_tree.hash_algorithm, 1);
    }

    #[test]
    fn test_cross_algorithm_proof_verification() {
        let mut keccak_tree = EnhancedMerkleTree::new_keccak();
        let leaf = [0xcdu8; 32];
        let index = keccak_tree.insert(leaf).unwrap();
        let keccak_root = keccak_tree.get_root();
        let keccak_proof = keccak_tree.get_proof(index);
        
        // Keccak proof should NOT validate with Poseidon algorithm
        assert!(!EnhancedMerkleTree::verify_proof_with_algorithm(
            HashAlgorithm::Poseidon,
            &keccak_root,
            &leaf,
            &keccak_proof,
            index
        ), "Keccak proof should not validate with Poseidon");
        
        // But should validate with Keccak algorithm
        assert!(EnhancedMerkleTree::verify_proof_with_algorithm(
            HashAlgorithm::Keccak256,
            &keccak_root,
            &leaf,
            &keccak_proof,
            index
        ), "Keccak proof should validate with Keccak");
    }

    #[test]
    fn test_multiple_insertions_poseidon() {
        let mut tree = EnhancedMerkleTree::new_poseidon();
        let leaves = [
            [0x11u8; 32],
            [0x22u8; 32], 
            [0x33u8; 32],
            [0x44u8; 32],
        ];
        
        let mut indices = Vec::new();
        for leaf in leaves.iter() {
            let index = tree.insert(*leaf).unwrap();
            indices.push(index);
        }
        
        let final_root = tree.get_root();
        
        // Verify all proofs work
        for (i, &leaf) in leaves.iter().enumerate() {
            let proof = tree.get_proof(indices[i]);
            assert!(tree.verify_proof(&final_root, &leaf, &proof, indices[i]),
                    "Proof {} should be valid", i);
        }
    }

    #[test]
    fn test_poseidon_determinism() {
        let mut tree1 = EnhancedMerkleTree::new_poseidon();
        let mut tree2 = EnhancedMerkleTree::new_poseidon();
        
        let test_leaves = [
            [0x01u8; 32],
            [0x02u8; 32],
            [0x03u8; 32],
        ];
        
        // Insert same sequence into both trees
        for leaf in test_leaves.iter() {
            tree1.insert(*leaf).unwrap();
            tree2.insert(*leaf).unwrap();
        }
        
        // Trees should have identical state
        assert_eq!(tree1.current_root, tree2.current_root, "Identical insertions should produce identical roots");
        assert_eq!(tree1.next_index, tree2.next_index, "Identical insertions should produce identical indices");
        assert_eq!(tree1.filled_subtrees, tree2.filled_subtrees, "Identical insertions should produce identical subtrees");
    }

    #[test]
    fn test_conversion_warning() {
        let keccak_tree = EnhancedMerkleTree::new_keccak();
        let converted = keccak_tree.convert_to_algorithm(HashAlgorithm::Poseidon);
        
        // Conversion should create a fresh tree with the new algorithm
        assert_eq!(converted.get_hash_algorithm(), HashAlgorithm::Poseidon);
        assert_eq!(converted.next_index, 0, "Converted tree should be fresh");
        
        // Same algorithm conversion should return clone
        let same_algo = keccak_tree.convert_to_algorithm(HashAlgorithm::Keccak256);
        assert_eq!(same_algo.next_index, keccak_tree.next_index);
        assert_eq!(same_algo.current_root, keccak_tree.current_root);
    }
}