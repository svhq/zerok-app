#[cfg(test)]
mod poseidon_consistency_tests {
    use solana_poseidon::{hashv, Parameters, Endianness};
    
    #[test]
    fn test_poseidon_consistency() {
        println!("\n🔬 Rust Poseidon Test Results:\n");
        
        // Test 1: Hash two elements (Merkle tree nodes)
        println!("Test 1: Poseidon(2) - Merkle tree hashing");
        let left: [u8; 32] = [
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1
        ];
        let right: [u8; 32] = [
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2
        ];
        
        let hash2 = hashv(Parameters::Bn254X5, Endianness::BigEndian, &[&left, &right]).unwrap().to_bytes();
        println!("  Rust Output: 0x{}", hex::encode(hash2));
        println!("  JS Expected: 0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a");
        
        // Verify match
        let expected_hash2 = hex::decode("115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a").unwrap();
        assert_eq!(hash2, expected_hash2.as_slice(), "Test 1 FAILED: Hashes don't match!");
        println!("  ✅ Test 1 PASSED: Hashes match!\n");
        
        // Test 2: Hash single element (nullifier)
        println!("Test 2: Poseidon(1) - Nullifier hashing");
        let nullifier: [u8; 32] = [
            0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef,
            0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef,
            0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef,
            0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef
        ];
        
        let hash1 = hashv(Parameters::Bn254X5, Endianness::BigEndian, &[&nullifier]).unwrap().to_bytes();
        println!("  Rust Output: 0x{}", hex::encode(hash1));
        println!("  JS Expected: 0x239edbf1e6b4f5646471d24e63b1ab7992897e0ecefa6b565302f64fe1e49117");
        
        // Verify match
        let expected_hash1 = hex::decode("239edbf1e6b4f5646471d24e63b1ab7992897e0ecefa6b565302f64fe1e49117").unwrap();
        assert_eq!(hash1, expected_hash1.as_slice(), "Test 2 FAILED: Hashes don't match!");
        println!("  ✅ Test 2 PASSED: Hashes match!\n");
        
        // Test 3: Commitment (nullifier + secret)
        println!("Test 3: Commitment - Poseidon(nullifier, secret)");
        let test_nullifier: [u8; 32] = [
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x23
        ];
        let test_secret: [u8; 32] = [
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x04, 0x56
        ];
        
        let commitment = hashv(Parameters::Bn254X5, Endianness::BigEndian, &[&test_nullifier, &test_secret]).unwrap().to_bytes();
        println!("  Rust Output: 0x{}", hex::encode(commitment));
        println!("  JS Expected: 0x0e7a333190bcbb4f654dbefca544b4a2b0644d05dce3fdc11e6df0b6e4fa57d4");
        
        // Verify match
        let expected_commitment = hex::decode("0e7a333190bcbb4f654dbefca544b4a2b0644d05dce3fdc11e6df0b6e4fa57d4").unwrap();
        assert_eq!(commitment, expected_commitment.as_slice(), "Test 3 FAILED: Hashes don't match!");
        println!("  ✅ Test 3 PASSED: Hashes match!\n");
        
        println!("🎉 ALL TESTS PASSED! JS and Rust Poseidon implementations are consistent!");
        println!("✅ The system is ready for groth16 integration.");
    }
}