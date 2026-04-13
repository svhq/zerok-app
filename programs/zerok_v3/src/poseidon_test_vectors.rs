//! Poseidon Test Vector Generation
//! Generate reference outputs for circuit parity verification

#[cfg(test)]
mod poseidon_test_vectors {
    use solana_poseidon::{hashv, Parameters, Endianness};

    #[test]
    fn generate_poseidon_test_vectors() {
        println!("\n═══════════════════════════════════════════════════");
        println!("   POSEIDON TEST VECTORS - Solana Syscall");
        println!("═══════════════════════════════════════════════════\n");

        // Test Vector 1: (0, 0)
        let zero = [0u8; 32];
        let result_0_0 = hashv(
            Parameters::Bn254X5,
            Endianness::BigEndian,
            &[&zero, &zero]
        ).unwrap().to_bytes();

        println!("Test Vector 1: poseidon(0, 0)");
        println!("  Input Left:  0x{}", hex::encode(&zero));
        println!("  Input Right: 0x{}", hex::encode(&zero));
        println!("  Output:      0x{}", hex::encode(&result_0_0));
        println!();

        // Test Vector 2: (1, 2)
        let mut one = [0u8; 32];
        one[31] = 1;
        let mut two = [0u8; 32];
        two[31] = 2;

        let result_1_2 = hashv(
            Parameters::Bn254X5,
            Endianness::BigEndian,
            &[&one, &two]
        ).unwrap().to_bytes();

        println!("Test Vector 2: poseidon(1, 2)");
        println!("  Input Left:  0x{}", hex::encode(&one));
        println!("  Input Right: 0x{}", hex::encode(&two));
        println!("  Output:      0x{}", hex::encode(&result_1_2));
        println!();

        // Test Vector 3: Random values (smaller than modulus)
        let left = [
            0x00, 0x00, 0x00, 0x00, 0x12, 0x34, 0x56, 0x78,
            0x9a, 0xbc, 0xde, 0xf0, 0x11, 0x22, 0x33, 0x44,
            0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc,
            0xdd, 0xee, 0xff, 0x00, 0x01, 0x23, 0x45, 0x67
        ];
        let right = [
            0x00, 0x00, 0x00, 0x00, 0xfe, 0xdc, 0xba, 0x98,
            0x76, 0x54, 0x32, 0x10, 0xf0, 0xe1, 0xd2, 0xc3,
            0xb4, 0xa5, 0x96, 0x87, 0x78, 0x69, 0x5a, 0x4b,
            0x3c, 0x2d, 0x1e, 0x0f, 0x00, 0x11, 0x22, 0x33
        ];

        let result_random = hashv(
            Parameters::Bn254X5,
            Endianness::BigEndian,
            &[&left, &right]
        ).unwrap().to_bytes();

        println!("Test Vector 3: poseidon(random, random)");
        println!("  Input Left:  0x{}", hex::encode(&left));
        println!("  Input Right: 0x{}", hex::encode(&right));
        println!("  Output:      0x{}", hex::encode(&result_random));
        println!();

        println!("═══════════════════════════════════════════════════");
        println!("   Circuit team: Run these EXACT inputs through");
        println!("   your Poseidon and compare outputs");
        println!("═══════════════════════════════════════════════════\n");

        // Also test that our current implementation uses these
        // (smoke test)
        assert_eq!(result_0_0.len(), 32, "Output must be 32 bytes");
        assert_eq!(result_1_2.len(), 32, "Output must be 32 bytes");
        assert_eq!(result_random.len(), 32, "Output must be 32 bytes");

        // Outputs should be different
        assert_ne!(result_0_0, result_1_2, "Different inputs produce different outputs");
        assert_ne!(result_1_2, result_random, "Different inputs produce different outputs");
    }

    #[test]
    fn generate_commitment_test_vector() {
        println!("\n═══════════════════════════════════════════════════");
        println!("   COMMITMENT TEST VECTOR");
        println!("═══════════════════════════════════════════════════\n");

        // Simulate a commitment: poseidon(nullifier, secret)
        let nullifier = [
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05
        ]; // nullifier = 5

        let secret = [
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a
        ]; // secret = 10

        let commitment = hashv(
            Parameters::Bn254X5,
            Endianness::BigEndian,
            &[&nullifier, &secret]
        ).unwrap().to_bytes();

        println!("Commitment = poseidon(nullifier, secret)");
        println!("  Nullifier: 0x{}", hex::encode(&nullifier));
        println!("  Secret:    0x{}", hex::encode(&secret));
        println!("  Commitment: 0x{}", hex::encode(&commitment));
        println!();

        // Now hash with zero (simulate merkle tree level 0)
        let zero = [0u8; 32];
        let level_0_hash = hashv(
            Parameters::Bn254X5,
            Endianness::BigEndian,
            &[&commitment, &zero]
        ).unwrap().to_bytes();

        println!("Merkle Level 0 = poseidon(commitment, ZERO[0])");
        println!("  Left (commitment): 0x{}", hex::encode(&commitment));
        println!("  Right (ZERO[0]):   0x{}", hex::encode(&zero));
        println!("  Output:            0x{}", hex::encode(&level_0_hash));
        println!();

        println!("═══════════════════════════════════════════════════\n");
    }
}
