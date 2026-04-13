#[cfg(test)]
mod hash_parity_tests {
    use crate::merkle_tree::MerkleTree;
    use solana_poseidon::{hashv, Parameters, Endianness};

    #[test]
    fn test_anza_test_vectors() {
        // Test vector 1: Two inputs [1u8; 32] + [2u8; 32], BigEndian
        let input1 = [1u8; 32];
        let input2 = [2u8; 32];
        
        let result = hashv(Parameters::Bn254X5, Endianness::BigEndian, &[&input1, &input2]).unwrap();
        let expected = [13,84,225,147,143,138,140,28,125,235,94,3,85,242,99,25,32,123,132,254,156,162,206,27,38,231,53,200,41,130,25,144];
        
        assert_eq!(result.to_bytes(), expected, "Two-input hash must match Anza test vector");
        
        // Test with our implementation
        let our_result = MerkleTree::hash_left_right(&input1, &input2);
        assert_eq!(our_result, expected, "Our implementation must match test vector");
    }

    #[test]
    fn test_single_input_parity() {
        // Test vector: Single input [1u8; 32], BigEndian
        let input = [1u8; 32];
        
        let result = hashv(Parameters::Bn254X5, Endianness::BigEndian, &[&input]).unwrap();
        let expected = [5,191,172,229,129,238,97,119,204,25,198,197,99,99,166,136,130,241,30,132,7,172,99,157,185,145,224,210,127,27,117,230];
        
        assert_eq!(result.to_bytes(), expected, "Single-input hash must match Anza test vector");
        
        // Test with our implementation
        let our_result = MerkleTree::hash_leaf(&input);
        assert_eq!(our_result, expected, "Our leaf hash must match test vector");
    }

    /// Test Merkle tree consistency across operations
    ///
    /// ⚠️ REQUIRES BPF ENVIRONMENT: This test uses Poseidon syscalls which return
    /// zeros in native environment. Run with `cargo test-sbf` instead.
    ///
    /// See: tests/README.md#known-test-environment-limitations
    #[test]
    #[ignore = "Requires BPF environment for Poseidon syscall"]
    fn test_merkle_tree_consistency() {
        // Test that Merkle tree operations produce consistent results
        let mut tree = MerkleTree::new();
        
        let leaf1 = [1u8; 32];
        let leaf2 = [2u8; 32];
        
        // Insert first leaf
        let index1 = tree.insert(leaf1).unwrap();
        let root1 = tree.get_root();
        
        // Insert second leaf  
        let index2 = tree.insert(leaf2).unwrap();
        let root2 = tree.get_root();
        
        // Roots should be different and deterministic
        assert_ne!(root1, root2, "Roots should change with new insertions");
        assert_eq!(index1, 0, "First leaf should have index 0");
        assert_eq!(index2, 1, "Second leaf should have index 1");
        
        // Test deterministic behavior - create identical tree
        let mut tree2 = MerkleTree::new();
        tree2.insert(leaf1).unwrap();
        tree2.insert(leaf2).unwrap();
        
        assert_eq!(tree.get_root(), tree2.get_root(), "Identical operations must produce identical roots");
    }

    #[test]
    fn test_zero_values_consistency() {
        // Test that our zero chain is still valid
        let zero_level_0 = MerkleTree::hash_leaf(&[0u8; 32]);
        let zero_level_1 = MerkleTree::hash_left_right(&zero_level_0, &zero_level_0);
        
        // Should not be all zeros
        assert_ne!(zero_level_0, [0u8; 32], "Hash of zero should not be zero");
        assert_ne!(zero_level_1, [0u8; 32], "Hash of zero pair should not be zero");
        
        // Should be deterministic
        let zero_level_0_repeat = MerkleTree::hash_leaf(&[0u8; 32]);
        assert_eq!(zero_level_0, zero_level_0_repeat, "Hashing must be deterministic");
    }

    /// Test compatibility across multiple input combinations
    ///
    /// ⚠️ REQUIRES BPF ENVIRONMENT: This test uses Poseidon syscalls which return
    /// zeros in native environment. Run with `cargo test-sbf` instead.
    ///
    /// See: tests/README.md#known-test-environment-limitations
    #[test]
    #[ignore = "Requires BPF environment for Poseidon syscall"]
    fn test_multiple_inputs_compatibility() {
        // Test various input combinations to ensure broad compatibility
        let inputs = [
            ([0u8; 32], [0u8; 32]),
            ([1u8; 32], [0u8; 32]),
            ([0u8; 32], [1u8; 32]),
            ([255u8; 32], [255u8; 32]),
        ];

        for (left, right) in inputs.iter() {
            // Test with direct solana-poseidon call
            let direct_result = hashv(Parameters::Bn254X5, Endianness::BigEndian, &[left, right]).unwrap();
            
            // Test with our wrapper
            let our_result = MerkleTree::hash_left_right(left, right);
            
            assert_eq!(our_result, direct_result.to_bytes(), 
                "Wrapper must match direct call for inputs {:?}", (left[0], right[0]));
        }
    }

    #[test]
    fn test_error_handling_robustness() {
        // Test that error cases are handled gracefully
        // Note: This test primarily ensures our fallback logic works
        
        // Test normal operation first
        let result = MerkleTree::hash_left_right(&[1u8; 32], &[2u8; 32]);
        assert_ne!(result, [0u8; 32], "Normal operation should not return zeros");
        
        let leaf_result = MerkleTree::hash_leaf(&[1u8; 32]);
        assert_ne!(leaf_result, [0u8; 32], "Normal leaf operation should not return zeros");
        
        // Our implementation should be robust and never panic
        // This is more of a compilation/runtime safety test
        assert_eq!(result.len(), 32, "Result should always be 32 bytes");
        assert_eq!(leaf_result.len(), 32, "Leaf result should always be 32 bytes");
    }

    #[test]
    fn test_large_scale_consistency() {
        // Test that our implementation is consistent across many operations
        let mut tree = MerkleTree::new();
        let mut expected_roots = Vec::new();
        
        // Insert 10 different leaves
        for i in 0..10u8 {
            let mut leaf = [0u8; 32];
            leaf[31] = i; // Put the index in the last byte
            
            tree.insert(leaf).unwrap();
            expected_roots.push(tree.get_root());
        }
        
        // Verify deterministic behavior by rebuilding the same tree
        let mut tree2 = MerkleTree::new();
        for i in 0..10u8 {
            let mut leaf = [0u8; 32];
            leaf[31] = i;
            
            tree2.insert(leaf).unwrap();
            assert_eq!(tree2.get_root(), expected_roots[i as usize], 
                "Root at position {} should be deterministic", i);
        }
    }

    /// Test boundary conditions and edge cases
    ///
    /// ⚠️ REQUIRES BPF ENVIRONMENT: This test uses Poseidon syscalls which return
    /// zeros in native environment. Run with `cargo test-sbf` instead.
    ///
    /// See: tests/README.md#known-test-environment-limitations
    #[test]
    #[ignore = "Requires BPF environment for Poseidon syscall"]
    fn test_boundary_conditions() {
        // Test edge cases and boundary conditions

        // Test with max values
        let max_input = [255u8; 32];
        let min_input = [0u8; 32];
        
        // These should not panic or return invalid results
        let max_hash = MerkleTree::hash_leaf(&max_input);
        let min_hash = MerkleTree::hash_leaf(&min_input);
        let mixed_hash = MerkleTree::hash_left_right(&max_input, &min_input);
        
        assert_ne!(max_hash, [0u8; 32], "Max input hash should not be zero");
        assert_ne!(min_hash, [0u8; 32], "Min input hash should not be zero");
        assert_ne!(mixed_hash, [0u8; 32], "Mixed hash should not be zero");
        
        // Results should be different
        assert_ne!(max_hash, min_hash, "Different inputs should produce different hashes");
        assert_ne!(max_hash, mixed_hash, "Mixed should differ from max");
        assert_ne!(min_hash, mixed_hash, "Mixed should differ from min");
    }
}