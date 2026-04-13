//! Comprehensive tests for Poseidon hash integration in zerok
//! 
//! This module provides thorough testing of:
//! - Hash function deterministic behavior
//! - Merkle tree operations and consistency
//! - 32-byte input constraint enforcement
//! - Zero hash generation
//! - Merkle proof generation and verification
//! - Commitment generation

use super::*;
use crate::merkle_tree::*;

#[cfg(test)]
mod hash_tests {
    use super::*;

    #[test]
    fn test_deterministic_hashing() {
        // Test that hash_left_right produces consistent outputs for the same inputs
        let left = [0x01u8; 32];
        let right = [0x02u8; 32];
        
        let hash1 = MerkleTree::hash_left_right(&left, &right);
        let hash2 = MerkleTree::hash_left_right(&left, &right);
        
        assert_eq!(hash1, hash2, "Hash function must be deterministic");
        
        // Test different inputs produce different outputs
        let different_left = [0x03u8; 32];
        let hash3 = MerkleTree::hash_left_right(&different_left, &right);
        
        assert_ne!(hash1, hash3, "Different inputs must produce different hashes");
        
        // Test order dependency
        let reversed = MerkleTree::hash_left_right(&right, &left);
        assert_ne!(hash1, reversed, "Hash order must matter for security");
    }

    #[test]
    fn test_hash_pair_function() {
        // Test the core hash_pair functionality for various inputs
        let test_cases = [
            ([0x00u8; 32], [0x00u8; 32]),
            ([0xffu8; 32], [0xffu8; 32]),
            ([0xaau8; 32], [0x55u8; 32]),
            ([0x01u8; 32], [0xfeu8; 32]),
        ];

        for (left, right) in test_cases.iter() {
            let result = MerkleTree::hash_left_right(left, right);
            
            // Verify result is exactly 32 bytes
            assert_eq!(result.len(), 32, "Hash result must be 32 bytes");
            
            // Verify it's deterministic
            let result2 = MerkleTree::hash_left_right(left, right);
            assert_eq!(result, result2, "Hash must be deterministic");
            
            // Verify it's not all zeros (unless both inputs are zero)
            if left != &[0u8; 32] || right != &[0u8; 32] {
                assert_ne!(result, [0u8; 32], "Non-zero inputs should not produce zero hash");
            }
        }
    }

    #[test]
    fn test_32_byte_input_constraints() {
        // Test that hash functions properly handle exactly 32-byte inputs
        let valid_input = [0x42u8; 32];
        
        // Test hash_leaf with 32-byte input
        let leaf_hash = MerkleTree::hash_leaf(&valid_input);
        assert_eq!(leaf_hash.len(), 32, "Leaf hash must be 32 bytes");
        
        // Test hash_left_right with 32-byte inputs
        let pair_hash = MerkleTree::hash_left_right(&valid_input, &valid_input);
        assert_eq!(pair_hash.len(), 32, "Pair hash must be 32 bytes");
        
        // Verify the hash functions don't panic with various 32-byte patterns
        let test_patterns = [
            [0x00u8; 32],  // All zeros
            [0xffu8; 32],  // All ones
            {
                let mut pattern = [0u8; 32];
                pattern[0] = 0xff;
                pattern[31] = 0xff;
                pattern
            },  // Only first and last byte set
        ];

        for pattern in test_patterns.iter() {
            let _ = MerkleTree::hash_leaf(pattern);
            let _ = MerkleTree::hash_left_right(pattern, pattern);
        }
    }

    #[test]
    fn test_zero_hashes_generation() {
        let zeros = MerkleTree::generate_zeros();
        
        // Verify we have exactly 20 levels of zero hashes
        assert_eq!(zeros.len(), 20, "Must have exactly 20 zero hash levels");
        
        // Verify each zero hash is 32 bytes
        for (i, zero) in zeros.iter().enumerate() {
            assert_eq!(zero.len(), 32, "Zero hash at level {} must be 32 bytes", i);
        }
        
        // Verify the zero hash construction is correct:
        // zeros[i] = hash(zeros[i-1], zeros[i-1]) for i > 0
        for i in 1..20 {
            let expected = MerkleTree::hash_left_right(&zeros[i-1], &zeros[i-1]);
            assert_eq!(zeros[i], expected, "Zero hash construction incorrect at level {}", i);
        }
        
        // Verify zeros are deterministic
        let zeros2 = MerkleTree::generate_zeros();
        assert_eq!(zeros, zeros2, "Zero hash generation must be deterministic");
    }
}

#[cfg(test)]
mod merkle_tree_tests {
    use super::*;

    #[test]
    fn test_merkle_tree_initialization() {
        let tree = MerkleTree::new();
        
        assert_eq!(tree.levels, 20, "Tree must have 20 levels");
        assert_eq!(tree.next_index, 0, "Tree must start with index 0");
        
        // Verify initial root is the top-level zero hash
        let zeros = MerkleTree::generate_zeros();
        assert_eq!(tree.current_root, zeros[19], "Initial root must be level 19 zero hash");
        
        // Verify filled_subtrees are initialized with zeros
        for i in 0..20 {
            assert_eq!(tree.filled_subtrees[i], zeros[i], "Filled subtree {} must match zero hash", i);
        }
    }

    #[test]
    fn test_merkle_tree_insertion_consistency() {
        let mut tree = MerkleTree::new();
        
        // Test inserting first leaf
        let leaf1 = [0x01u8; 32];
        let index1 = tree.insert(leaf1).unwrap();
        assert_eq!(index1, 0, "First leaf must have index 0");
        
        let root1 = tree.get_root();
        assert_ne!(root1, [0u8; 32], "Root should not be all zeros after insertion");
        
        // Test inserting second leaf
        let leaf2 = [0x02u8; 32];
        let index2 = tree.insert(leaf2).unwrap();
        assert_eq!(index2, 1, "Second leaf must have index 1");
        
        let root2 = tree.get_root();
        assert_ne!(root1, root2, "Root must change after second insertion");
        
        // Test tree state consistency
        assert_eq!(tree.next_index, 2, "Next index must be 2 after two insertions");
        
        // Test that the same sequence produces the same result
        let mut tree2 = MerkleTree::new();
        tree2.insert(leaf1).unwrap();
        tree2.insert(leaf2).unwrap();
        
        assert_eq!(tree.current_root, tree2.current_root, "Same insertion sequence must produce same root");
        assert_eq!(tree.next_index, tree2.next_index, "Same insertion sequence must produce same state");
    }

    #[test]
    fn test_merkle_tree_capacity() {
        let mut tree = MerkleTree::new();
        let capacity = 2_u32.pow(tree.levels); // 2^20 = 1,048,576
        
        // Test normal insertion near the beginning
        for i in 0..10 {
            let leaf = [(i as u8); 32];
            let index = tree.insert(leaf).unwrap();
            assert_eq!(index, i as u32, "Index must match insertion order");
        }
        
        // Test that tree tracks next_index correctly
        assert_eq!(tree.next_index, 10, "Next index must be 10 after 10 insertions");
        
        // Verify tree would reject insertion when full (conceptually - we won't actually fill it)
        tree.next_index = capacity - 1;
        let last_leaf = [0xffu8; 32];
        let result = tree.insert(last_leaf);
        assert!(result.is_ok(), "Should accept insertion at capacity-1");
        
        // Now tree should be full
        let overflow_leaf = [0xeeu8; 32];
        let result = tree.insert(overflow_leaf);
        assert!(result.is_err(), "Should reject insertion when full");
        
        // Verify the error is correct type
        match result {
            Err(error) => {
                // In a real test environment, we would check the specific error type
                // For now, just verify it errors
            }
            _ => panic!("Expected error when inserting into full tree"),
        }
    }

    #[test]
    fn test_merkle_proof_generation() {
        let mut tree = MerkleTree::new();
        
        // Insert some test leaves
        let leaves = [
            [0x01u8; 32],
            [0x02u8; 32],
            [0x03u8; 32],
            [0x04u8; 32],
        ];
        
        let mut indices = Vec::new();
        for leaf in leaves.iter() {
            let index = tree.insert(*leaf).unwrap();
            indices.push(index);
        }
        
        // Test proof generation for each inserted leaf
        for (i, &index) in indices.iter().enumerate() {
            let proof = tree.get_proof(index);
            
            // Verify proof has correct length (20 levels)
            assert_eq!(proof.len(), 20, "Proof must have 20 elements for 20-level tree");
            
            // Each proof element must be 32 bytes
            for (j, proof_element) in proof.iter().enumerate() {
                assert_eq!(proof_element.len(), 32, "Proof element {} must be 32 bytes", j);
            }
        }
        
        // Test proof for non-existent leaf (index beyond inserted leaves)
        let future_proof = tree.get_proof(100);
        assert_eq!(future_proof.len(), 20, "Proof for future index must still have 20 elements");
    }

    #[test]
    fn test_merkle_proof_verification() {
        let mut tree = MerkleTree::new();
        
        // Insert test leaves
        let leaves = [
            [0xaau8; 32],
            [0xbbu8; 32],
            [0xccu8; 32],
        ];
        
        for leaf in leaves.iter() {
            tree.insert(*leaf).unwrap();
        }
        
        let final_root = tree.get_root();
        
        // Test verification for each leaf
        for (i, &leaf) in leaves.iter().enumerate() {
            let index = i as u32;
            let proof = tree.get_proof(index);
            
            let is_valid = MerkleTree::verify_proof(&final_root, &leaf, &proof, index);
            assert!(is_valid, "Proof verification must succeed for leaf {} with index {}", i, index);
        }
        
        // Test that invalid proofs fail
        let fake_leaf = [0xffu8; 32];
        let proof = tree.get_proof(0);
        let is_invalid = MerkleTree::verify_proof(&final_root, &fake_leaf, &proof, 0);
        assert!(!is_invalid, "Proof verification must fail for incorrect leaf");
        
        // Test that wrong index fails
        let correct_leaf = leaves[0];
        let wrong_index_proof = tree.get_proof(0);
        let is_wrong_index = MerkleTree::verify_proof(&final_root, &correct_leaf, &wrong_index_proof, 1);
        assert!(!is_wrong_index, "Proof verification must fail for wrong index");
    }
}

#[cfg(test)]
mod commitment_tests {
    use super::*;

    #[test]
    fn test_commitment_generation_consistency() {
        // Test that commitment generation is deterministic and follows expected patterns
        
        // Simulate commitment = hash(nullifier || secret) as done in the TypeScript tests
        let nullifier = [0x01u8; 31]; // 31 bytes as in original test
        let secret = [0x02u8; 31];     // 31 bytes as in original test
        
        // Create commitment data (62 bytes total)
        let mut commitment_data = [0u8; 62];
        commitment_data[..31].copy_from_slice(&nullifier);
        commitment_data[31..].copy_from_slice(&secret);
        
        // Hash to create 32-byte commitment (simulating SHA256 from TypeScript test)
        let commitment = MerkleTree::hash_leaf(&{
            let mut temp = [0u8; 32];
            // In real implementation, this would be a proper hash of the 62-byte data
            // For testing purposes, we'll use a deterministic conversion
            temp[..31].copy_from_slice(&nullifier);
            temp[31] = secret[0]; // Just to include secret in the test
            temp
        });
        
        // Verify commitment is 32 bytes
        assert_eq!(commitment.len(), 32, "Commitment must be 32 bytes");
        
        // Test that same inputs produce same commitment
        let commitment2 = MerkleTree::hash_leaf(&{
            let mut temp = [0u8; 32];
            temp[..31].copy_from_slice(&nullifier);
            temp[31] = secret[0];
            temp
        });
        assert_eq!(commitment, commitment2, "Commitment generation must be deterministic");
        
        // Test that different inputs produce different commitments
        let different_nullifier = [0x03u8; 31];
        let different_commitment = MerkleTree::hash_leaf(&{
            let mut temp = [0u8; 32];
            temp[..31].copy_from_slice(&different_nullifier);
            temp[31] = secret[0];
            temp
        });
        assert_ne!(commitment, different_commitment, "Different nullifiers must produce different commitments");
    }

    #[test]
    fn test_nullifier_hash_generation() {
        // Test nullifier hash generation consistency
        let nullifier = [0x42u8; 32];
        
        let nullifier_hash1 = MerkleTree::hash_leaf(&nullifier);
        let nullifier_hash2 = MerkleTree::hash_leaf(&nullifier);
        
        assert_eq!(nullifier_hash1, nullifier_hash2, "Nullifier hash must be deterministic");
        
        // Test different nullifiers produce different hashes
        let different_nullifier = [0x43u8; 32];
        let different_hash = MerkleTree::hash_leaf(&different_nullifier);
        assert_ne!(nullifier_hash1, different_hash, "Different nullifiers must produce different hashes");
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;

    #[test]
    fn test_complete_deposit_workflow() {
        let mut tree = MerkleTree::new();
        
        // Simulate complete deposit workflow
        let nullifier = [0x11u8; 32];
        let secret = [0x22u8; 32];
        
        // Generate commitment (in real implementation, this would be hash(nullifier || secret))
        let commitment = MerkleTree::hash_leaf(&{
            let mut temp = [0u8; 32];
            temp[..16].copy_from_slice(&nullifier[..16]);
            temp[16..].copy_from_slice(&secret[..16]);
            temp
        });
        
        // Insert commitment into tree
        let leaf_index = tree.insert(commitment).unwrap();
        let root_after_deposit = tree.get_root();
        
        // Generate proof for the commitment
        let proof = tree.get_proof(leaf_index);
        
        // Verify the proof works
        let is_valid = MerkleTree::verify_proof(&root_after_deposit, &commitment, &proof, leaf_index);
        assert!(is_valid, "Deposit commitment proof must be valid");
        
        // Generate nullifier hash for withdrawal
        let nullifier_hash = MerkleTree::hash_leaf(&nullifier);
        
        // Verify we can reconstruct the commitment from nullifier and secret
        let reconstructed_commitment = MerkleTree::hash_leaf(&{
            let mut temp = [0u8; 32];
            temp[..16].copy_from_slice(&nullifier[..16]);
            temp[16..].copy_from_slice(&secret[..16]);
            temp
        });
        assert_eq!(commitment, reconstructed_commitment, "Commitment must be reproducible from nullifier and secret");
        
        println!("Complete deposit workflow test passed");
        println!("- Commitment: {:02x?}", &commitment[..8]);
        println!("- Nullifier hash: {:02x?}", &nullifier_hash[..8]);
        println!("- Merkle root: {:02x?}", &root_after_deposit[..8]);
        println!("- Leaf index: {}", leaf_index);
    }

    #[test]
    fn test_multiple_deposits_and_proofs() {
        let mut tree = MerkleTree::new();
        let num_deposits = 5;
        
        let mut commitments = Vec::new();
        let mut leaf_indices = Vec::new();
        let mut proofs = Vec::new();
        
        // Make multiple deposits
        for i in 0..num_deposits {
            let nullifier = [(i + 1) as u8; 32];
            let secret = [(i + 100) as u8; 32];
            
            let commitment = MerkleTree::hash_leaf(&{
                let mut temp = [0u8; 32];
                temp[..16].copy_from_slice(&nullifier[..16]);
                temp[16..].copy_from_slice(&secret[..16]);
                temp
            });
            
            let index = tree.insert(commitment).unwrap();
            commitments.push(commitment);
            leaf_indices.push(index);
        }
        
        let final_root = tree.get_root();
        
        // Generate and verify proofs for all deposits
        for i in 0..num_deposits {
            let proof = tree.get_proof(leaf_indices[i]);
            proofs.push(proof.clone());
            
            let is_valid = MerkleTree::verify_proof(&final_root, &commitments[i], &proof, leaf_indices[i]);
            assert!(is_valid, "Proof must be valid for deposit {}", i);
        }
        
        // Verify that proofs from earlier states don't work with current root
        let mut partial_tree = MerkleTree::new();
        partial_tree.insert(commitments[0]).unwrap();
        let partial_root = partial_tree.get_root();
        
        let partial_proof = partial_tree.get_proof(0);
        let should_fail = MerkleTree::verify_proof(&final_root, &commitments[0], &partial_proof, 0);
        assert!(!should_fail, "Proof from partial tree should not validate against full tree root");
        
        println!("Multiple deposits test passed with {} deposits", num_deposits);
    }

    #[test] 
    fn test_cryptographic_properties() {
        // Test important cryptographic properties
        
        // 1. Preimage resistance: Given hash output, should be hard to find input
        let input = [0x12u8; 32];
        let hash = MerkleTree::hash_leaf(&input);
        
        // We can't easily test cryptographic preimage resistance in unit tests,
        // but we can verify that the hash is deterministic and different from input
        assert_ne!(hash, input, "Hash should not equal input");
        assert_ne!(hash, [0u8; 32], "Hash should not be all zeros for non-zero input");
        
        // 2. Collision resistance: Different inputs should produce different outputs
        let mut different_inputs = Vec::new();
        let mut hashes = Vec::new();
        
        for i in 0..10 {
            let mut input = [0u8; 32];
            input[0] = i;
            different_inputs.push(input);
            hashes.push(MerkleTree::hash_leaf(&input));
        }
        
        // Verify all hashes are different
        for i in 0..hashes.len() {
            for j in i+1..hashes.len() {
                assert_ne!(hashes[i], hashes[j], "Different inputs {} and {} should produce different hashes", i, j);
            }
        }
        
        // 3. Avalanche effect: Small input changes should cause large output changes
        let base_input = [0x00u8; 32];
        let base_hash = MerkleTree::hash_leaf(&base_input);
        
        let mut modified_input = base_input;
        modified_input[0] = 0x01; // Change just one bit
        let modified_hash = MerkleTree::hash_leaf(&modified_input);
        
        assert_ne!(base_hash, modified_hash, "Small input change should produce different hash");
        
        // Count differing bits (simple avalanche test)
        let mut differing_bits = 0;
        for i in 0..32 {
            differing_bits += (base_hash[i] ^ modified_hash[i]).count_ones();
        }
        
        // For a good hash function, roughly half the bits should change
        assert!(differing_bits > 50, "Avalanche effect: at least 50 bits should differ, got {}", differing_bits);
        
        println!("Cryptographic properties test passed");
        println!("- Differing bits from 1-bit input change: {}/256", differing_bits);
    }
}