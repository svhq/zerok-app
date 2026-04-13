#[cfg(test)]
mod mini_poseidon_tests {
    use solana_poseidon::{hashv, Parameters, Endianness};

    #[test]
    fn test_poseidon_zero() {
        println!("\n🧪 Testing Poseidon hash of zero (smallest unit)...");
        
        let zero = [0u8; 32];
        let hash_zero = hashv(Parameters::Bn254X5, Endianness::BigEndian, &[&zero]).unwrap().to_bytes();
        
        println!("Poseidon(0) = {}", hex::encode(&hash_zero));
        
        // Verify it's deterministic
        let hash_zero2 = hashv(Parameters::Bn254X5, Endianness::BigEndian, &[&zero]).unwrap().to_bytes();
        
        assert_eq!(hash_zero, hash_zero2, "Hash should be deterministic");
        println!("✅ Poseidon(0) is deterministic");
    }

    #[test]
    fn test_poseidon_two_inputs() {
        println!("\n🧪 Testing Poseidon hash with two inputs...");
        
        let mut one = [0u8; 32];
        one[31] = 1;
        let mut two = [0u8; 32];
        two[31] = 2;
        
        let hash = hashv(Parameters::Bn254X5, Endianness::BigEndian, &[&one, &two]).unwrap().to_bytes();
        
        println!("Poseidon(1, 2) = {}", hex::encode(&hash));
        
        // This should match the JavaScript implementation
        let expected = "115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a";
        assert_eq!(hex::encode(&hash), expected, "Hash should match JS implementation");
        
        println!("✅ Poseidon(1, 2) matches expected value!");
    }
}
