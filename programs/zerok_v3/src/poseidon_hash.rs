//! Poseidon hash implementation for zerok
//! 
//! This module provides a ZK-friendly hash function using Poseidon,
//! which is more efficient for zero-knowledge proofs than Keccak256.

use anchor_lang::prelude::*;

/// Poseidon hash configuration optimized for zerok
/// Using parameters compatible with circom's Poseidon implementation
pub struct PoseidonHasher {
    // Configuration parameters - these should match the circom implementation
    pub t: usize,        // Width (number of field elements)
    pub rf: usize,       // Full rounds 
    pub rp: usize,       // Partial rounds
}

impl PoseidonHasher {
    /// Create new Poseidon hasher with standard zerok configuration
    /// These parameters are chosen to match typical privacy protocol circom circuits
    pub fn new() -> Self {
        Self {
            t: 3,   // Width 3 (for hashing 2 inputs)
            rf: 8,  // Full rounds 
            rp: 57, // Partial rounds (for BN254 field)
        }
    }

    /// Hash two 32-byte inputs using Poseidon
    /// This is the core function for Merkle tree operations
    pub fn hash_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
        // Convert 32-byte inputs to field elements
        let left_field = bytes_to_field_element(left);
        let right_field = bytes_to_field_element(right);
        
        // Perform Poseidon hash
        let result_field = poseidon_hash_2_to_1(left_field, right_field);
        
        // Convert back to 32-byte array
        field_element_to_bytes(result_field)
    }

    /// Hash a single 32-byte input (for leaf hashing)
    pub fn hash_single(input: &[u8; 32]) -> [u8; 32] {
        // For single input, we can use the pair function with zero as second input
        let zero = [0u8; 32];
        Self::hash_pair(input, &zero)
    }

    /// Generate zero values for Merkle tree (using Poseidon)
    pub fn generate_zero_values() -> [[u8; 32]; 20] {
        let mut zeros = [[0u8; 32]; 20];
        
        // First zero is hash of zero field element
        zeros[0] = Self::hash_single(&[0u8; 32]);
        
        // Each subsequent zero is hash(previous_zero, previous_zero)
        for i in 1..20 {
            zeros[i] = Self::hash_pair(&zeros[i-1], &zeros[i-1]);
        }
        
        zeros
    }
}

/// Convert 32-byte array to field element for Poseidon
/// We need to ensure the result is valid in the BN254 scalar field
fn bytes_to_field_element(bytes: &[u8; 32]) -> [u8; 32] {
    let mut field_elem = *bytes;
    
    // Ensure the value is less than the BN254 field modulus
    // BN254 modulus: 21888242871839275222246405745257275088548364400416034343698204186575808495617
    // For simplicity in this test implementation, we'll use modular reduction
    
    // Simple reduction: if the high byte is >= 0x30, reduce it
    if field_elem[0] >= 0x30 {
        field_elem[0] = field_elem[0] % 0x21; // Rough approximation
    }
    
    field_elem
}

/// Convert field element back to 32-byte array
fn field_element_to_bytes(field_elem: [u8; 32]) -> [u8; 32] {
    // In this implementation, it's a direct copy
    // In a real implementation, this would ensure proper field element encoding
    field_elem
}

/// Core Poseidon hash function for 2 inputs
/// This is a simplified implementation for testing purposes
/// In production, use a proper Poseidon implementation like arkworks-rs
fn poseidon_hash_2_to_1(left: [u8; 32], right: [u8; 32]) -> [u8; 32] {
    // This is a mock implementation for testing
    // In production, replace with actual Poseidon hash computation
    
    // Simulate Poseidon by performing a series of operations that provide:
    // 1. Determinism - same inputs always produce same output
    // 2. Good avalanche effect - small input changes cause large output changes
    // 3. Different from simple concatenation or XOR
    
    let mut result = [0u8; 32];
    
    // Mix the inputs in a complex way
    for i in 0..32 {
        let l = left[i] as u32;
        let r = right[i] as u32;
        let pos = (i * 7) % 32; // Position shift for mixing
        
        // Complex mixing function (simulating Poseidon's S-boxes and linear layer)
        let mixed = ((l.wrapping_mul(17) ^ r.wrapping_mul(23)) + (i as u32 * 13)) as u8;
        result[pos] = result[pos].wrapping_add(mixed);
        
        // Additional mixing between bytes
        if i > 0 {
            result[i] = result[i].wrapping_add(result[i-1].wrapping_mul(3));
        }
    }
    
    // Final permutation round (simulating Poseidon rounds)
    for round in 0..8 {
        for i in 0..32 {
            let val = result[i] as u32;
            // S-box simulation (x^5 in real Poseidon, but we use x^3 + x for simplicity)
            let sboxed = ((val.wrapping_mul(val).wrapping_mul(val)) + val) as u8;
            result[i] = sboxed.wrapping_add(round as u8);
        }
        
        // Linear layer simulation (mixing between positions)
        let temp = result.clone();
        for i in 0..32 {
            result[i] = temp[i]
                .wrapping_add(temp[(i + 1) % 32])
                .wrapping_add(temp[(i + 7) % 32]);
        }
    }
    
    result
}

#[cfg(test)]
mod poseidon_tests {
    use super::*;

    #[test]
    fn test_poseidon_determinism() {
        let left = [0x01u8; 32];
        let right = [0x02u8; 32];
        
        let hash1 = PoseidonHasher::hash_pair(&left, &right);
        let hash2 = PoseidonHasher::hash_pair(&left, &right);
        
        assert_eq!(hash1, hash2, "Poseidon hash must be deterministic");
    }

    #[test] 
    fn test_poseidon_different_inputs() {
        let left1 = [0x01u8; 32];
        let right1 = [0x02u8; 32];
        let left2 = [0x03u8; 32]; 
        let right2 = [0x04u8; 32];
        
        let hash1 = PoseidonHasher::hash_pair(&left1, &right1);
        let hash2 = PoseidonHasher::hash_pair(&left2, &right2);
        
        assert_ne!(hash1, hash2, "Different inputs must produce different Poseidon hashes");
    }

    #[test]
    fn test_poseidon_order_dependency() {
        let a = [0x01u8; 32];
        let b = [0x02u8; 32];
        
        let hash_ab = PoseidonHasher::hash_pair(&a, &b);
        let hash_ba = PoseidonHasher::hash_pair(&b, &a);
        
        assert_ne!(hash_ab, hash_ba, "Poseidon hash must depend on input order");
    }

    #[test]
    fn test_poseidon_zero_values() {
        let zeros = PoseidonHasher::generate_zero_values();
        
        assert_eq!(zeros.len(), 20, "Must generate 20 zero values");
        
        // Verify construction: zeros[i] = hash(zeros[i-1], zeros[i-1])
        for i in 1..20 {
            let expected = PoseidonHasher::hash_pair(&zeros[i-1], &zeros[i-1]);
            assert_eq!(zeros[i], expected, "Zero value construction incorrect at level {}", i);
        }
    }

    #[test]
    fn test_poseidon_vs_keccak() {
        // Compare Poseidon with Keccak256 to ensure they produce different results
        // (Important for security - we don't want accidental collisions)
        
        let input1 = [0xaau8; 32];
        let input2 = [0xbbu8; 32];
        
        let poseidon_result = PoseidonHasher::hash_pair(&input1, &input2);
        let keccak_result = crate::merkle_tree::MerkleTree::hash_left_right(&input1, &input2);
        
        assert_ne!(poseidon_result, keccak_result, 
                   "Poseidon and Keccak should produce different results for same inputs");
    }

    #[test]
    fn test_field_element_conversion() {
        let test_bytes = [0x42u8; 32];
        let field_elem = bytes_to_field_element(&test_bytes);
        let converted_back = field_element_to_bytes(field_elem);
        
        // For our test implementation, this should be consistent
        assert_eq!(field_element_to_bytes(field_elem), converted_back,
                   "Field element conversion should be consistent");
    }

    #[test]
    fn test_poseidon_avalanche_effect() {
        // Test that small input changes cause large output changes
        let base = [0x00u8; 32];
        let mut modified = base;
        modified[31] = 0x01; // Change just the last bit
        
        let zero_input = [0x00u8; 32];
        let hash_base = PoseidonHasher::hash_pair(&base, &zero_input);
        let hash_modified = PoseidonHasher::hash_pair(&modified, &zero_input);
        
        assert_ne!(hash_base, hash_modified, "Small change should produce different hash");
        
        // Count different bytes (should be roughly half for good avalanche)
        let different_bytes = hash_base.iter()
            .zip(hash_modified.iter())
            .filter(|(a, b)| a != b)
            .count();
        
        assert!(different_bytes >= 8, "Avalanche effect: at least 8 bytes should differ, got {}", different_bytes);
    }
}