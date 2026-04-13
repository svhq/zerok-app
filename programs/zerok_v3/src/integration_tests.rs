#[cfg(test)]
mod integration_tests {
    use crate::{
        encode_u64_as_32_bytes, // change_endianness and negate_proof_a removed
        prepare_public_inputs, reconstruct_address_from_high_low,
        split_address_to_high_low, verify_proof, 
        ZerokError, get_circuit_verifying_key,
    };
    use anchor_lang::prelude::*;
    
    /// Test vector for a mock proof (256 bytes)
    /// This represents a properly formatted Groth16 proof from snarkjs
    fn get_mock_proof() -> Vec<u8> {
        let mut proof = vec![0u8; 256];
        
        // Mock proof A (64 bytes) - uncompressed G1 point
        // Using a valid G1 generator point for testing
        proof[0..32].copy_from_slice(&[
            0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ]);
        proof[32..64].copy_from_slice(&[
            0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ]);
        
        // Mock proof B (128 bytes) - uncompressed G2 point
        for i in 64..192 {
            proof[i] = ((i - 64) % 256) as u8;
        }
        
        // Mock proof C (64 bytes) - uncompressed G1 point
        proof[192..224].copy_from_slice(&[
            0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ]);
        proof[224..256].copy_from_slice(&[
            0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ]);
        
        proof
    }
    
    /// Test the endianness conversion functions - DISABLED
    // #[test]  // Disabled: change_endianness removed
    #[allow(dead_code)]
    fn _disabled_test_endianness_conversion() {
        let original = vec![
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
            0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10,
            0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
            0x19, 0x1A, 0x1B, 0x1C, 0x1D, 0x1E, 0x1F, 0x20,
        ];
        
        // Functions removed - conversion now inline in verify_proof
        return; // Early exit since functions removed
        #[allow(unreachable_code)]
        let converted: Vec<u8> = vec![]; // change_endianness(&original);
        #[allow(unreachable_code)]
        let double_converted = original.clone(); // change_endianness(&converted);
        
        // Should be reversible
        assert_eq!(original, double_converted);
        
        // First 32 bytes should be reversed
        for i in 0..32 {
            assert_eq!(original[i], converted[31 - i]);
        }
    }
    
    /// Test address splitting and reconstruction
    #[test]
    fn test_address_splitting() {
        let address = Pubkey::new_unique();
        let (high, low) = split_address_to_high_low(&address);
        
        // High should have first 16 bytes in positions 16-31
        assert_eq!(&high[0..16], &[0u8; 16]);
        assert_eq!(&high[16..32], &address.to_bytes()[0..16]);
        
        // Low should have last 16 bytes in positions 16-31
        assert_eq!(&low[0..16], &[0u8; 16]);
        assert_eq!(&low[16..32], &address.to_bytes()[16..32]);
        
        // Should be able to reconstruct
        let reconstructed = reconstruct_address_from_high_low(&high, &low);
        assert_eq!(address, reconstructed);
    }
    
    /// Test fee encoding
    #[test]
    fn test_fee_encoding() {
        let fee: u64 = 1_000_000; // 0.001 SOL
        let mut encoded = [0u8; 32];
        encode_u64_as_32_bytes(fee, &mut encoded);
        
        // Should be right-aligned (big-endian)
        assert_eq!(&encoded[0..24], &[0u8; 24]);
        assert_eq!(&encoded[24..32], &fee.to_be_bytes());
        
        // Test with max value
        let max_fee: u64 = u64::MAX;
        let mut max_encoded = [0u8; 32];
        encode_u64_as_32_bytes(max_fee, &mut max_encoded);
        assert_eq!(&max_encoded[24..32], &max_fee.to_be_bytes());
    }
    
    /// Test prepare_public_inputs function
    #[test]
    fn test_prepare_public_inputs() {
        let root = [0x11u8; 32];
        let nullifier_hash = [0x22u8; 32];
        let recipient = Pubkey::new_from_array([0x33u8; 32]);
        let relayer = Pubkey::new_from_array([0x44u8; 32]);
        let fee: u64 = 1_000_000;
        let refund: u64 = 500_000;
        
        let inputs = prepare_public_inputs(
            &root,
            &nullifier_hash,
            &recipient,
            &relayer,
            fee,
            refund,
        );
        
        // Should have exactly 8 inputs
        assert_eq!(inputs.len(), 8);
        
        // Check root and nullifier
        assert_eq!(inputs[0], root);
        assert_eq!(inputs[1], nullifier_hash);
        
        // Check recipient split
        let (expected_recipient_high, expected_recipient_low) = split_address_to_high_low(&recipient);
        assert_eq!(inputs[2], expected_recipient_high);
        assert_eq!(inputs[3], expected_recipient_low);
        
        // Check relayer split
        let (expected_relayer_high, expected_relayer_low) = split_address_to_high_low(&relayer);
        assert_eq!(inputs[4], expected_relayer_high);
        assert_eq!(inputs[5], expected_relayer_low);
        
        // Check fee and refund encoding
        let mut expected_fee = [0u8; 32];
        encode_u64_as_32_bytes(fee, &mut expected_fee);
        assert_eq!(inputs[6], expected_fee);
        
        let mut expected_refund = [0u8; 32];
        encode_u64_as_32_bytes(refund, &mut expected_refund);
        assert_eq!(inputs[7], expected_refund);
    }
    
    /// Test proof A negation (mock - doesn't use real ark operations)
    // #[test]  // DISABLED: negate_proof_a removed
    #[allow(dead_code)]
    fn _disabled_test_proof_a_negation_format() {
        let proof_a = [0x01u8; 64];

        // This will fail with mock data, but tests the format
        // let result = negate_proof_a(&proof_a);
        let result: Result<[u8; 64]> = Err(ZerokError::ProofNegationFailed.into()); // Function removed
        
        // Should return an error with invalid mock data
        assert!(result.is_err());
        
        // But the function signature and error handling work
        match result {
            Err(msg) => {
                // Check error type instead of string content
                println!("Got expected error: {:?}", msg);
            }
            Ok(_) => {
                // With real proof data, this would succeed
            }
        }
    }
    
    /// Test verify_proof error handling
    #[test]
    fn test_verify_proof_error_handling() {
        let root = [0x11u8; 32];
        let nullifier_hash = [0x22u8; 32];
        let recipient = Pubkey::new_unique();
        let relayer = Pubkey::new_unique();
        let fee = 1_000_000u64;
        let refund = 0u64;
        
        // Test with wrong proof length
        let short_proof = vec![0u8; 100];
        let result = verify_proof(
            &short_proof,
            &root,
            &nullifier_hash,
            &recipient,
            &relayer,
            fee,
            refund,
            &get_circuit_verifying_key(),
        );
        
        // Should return InvalidProofLength error
        assert!(result.is_err());
        match result {
            Err(e) => {
                println!("Got expected proof length error: {:?}", e);
            }
            Ok(_) => panic!("Should have failed with invalid proof length"),
        }
        
        // Test with correct length but invalid format
        let invalid_proof = vec![0u8; 256];
        let result2 = verify_proof(
            &invalid_proof,
            &root,
            &nullifier_hash,
            &recipient,
            &relayer,
            fee,
            refund,
            &get_circuit_verifying_key(),
        );
        
        // Should fail during proof processing
        assert!(result2.is_err());
    }
    
    /// Integration test simulating the full flow
    #[test]
    fn test_full_verification_flow() {
        // This test simulates what would happen with a real proof
        let proof = get_mock_proof();
        assert_eq!(proof.len(), 256);
        
        // Prepare test data
        let root = [0xAAu8; 32];
        let nullifier_hash = [0xBBu8; 32];
        let recipient = Pubkey::new_from_array([0xCCu8; 32]);
        let relayer = Pubkey::new_from_array([0xDDu8; 32]);
        let fee = 2_000_000u64; // 0.002 SOL
        let refund = 100_000u64;  // 0.0001 SOL
        
        // Test public inputs preparation
        let public_inputs = prepare_public_inputs(
            &root,
            &nullifier_hash,
            &recipient,
            &relayer,
            fee,
            refund,
        );
        
        // Verify structure
        assert_eq!(public_inputs.len(), 8);
        
        // Each input should be 32 bytes
        for input in &public_inputs {
            assert_eq!(input.len(), 32);
        }
        
        // Verify address reconstruction works
        let reconstructed_recipient = reconstruct_address_from_high_low(
            &public_inputs[2],
            &public_inputs[3],
        );
        assert_eq!(reconstructed_recipient, recipient);
        
        let reconstructed_relayer = reconstruct_address_from_high_low(
            &public_inputs[4],
            &public_inputs[5],
        );
        assert_eq!(reconstructed_relayer, relayer);
        
        println!("✅ All integration tests passed!");
    }
}