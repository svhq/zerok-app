/// Canonical field element to byte conversion
///
/// This module provides THE single source of truth for converting
/// BN254 field elements to 32-byte seeds for PDA derivation.
///
/// CRITICAL: This conversion must be IDENTICAL between Rust and JavaScript
/// to ensure PDAs match on both sides.

use ark_bn254::Fr;
use ark_ff::PrimeField;

/// Convert a BN254 field element to 32 bytes in little-endian format
///
/// This is the canonical conversion used for:
/// - Nullifier PDA seeds
/// - Commitment representations
/// - Any field element that needs byte representation
///
/// # Implementation Details
///
/// The BN254 field element is represented as 4 x u64 limbs.
/// We serialize each limb as 8 bytes in little-endian format,
/// producing exactly 32 bytes total.
///
/// # Example
/// ```
/// let nullifier_fe = Fr::from(12345u64);
/// let seed_bytes = fr_to_seed_bytes_le(nullifier_fe);
/// // seed_bytes can now be used for PDA derivation
/// ```
pub fn fr_to_seed_bytes_le(fr: Fr) -> [u8; 32] {
    let limbs = fr.into_bigint().0; // Get the 4 x u64 limbs
    let mut out = [0u8; 32];

    // Serialize each limb as little-endian bytes
    for (i, limb) in limbs.iter().enumerate() {
        out[i * 8..(i + 1) * 8].copy_from_slice(&limb.to_le_bytes());
    }

    out
}

/// Convert 32 bytes (little-endian) back to a field element
///
/// Inverse of fr_to_seed_bytes_le for verification purposes
pub fn seed_bytes_le_to_fr(bytes: &[u8; 32]) -> Fr {
    let mut limbs = [0u64; 4];

    for i in 0..4 {
        let mut limb_bytes = [0u8; 8];
        limb_bytes.copy_from_slice(&bytes[i * 8..(i + 1) * 8]);
        limbs[i] = u64::from_le_bytes(limb_bytes);
    }

    Fr::from_bigint(ark_ff::BigInt(limbs)).expect("Invalid field element bytes")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fr_to_bytes_roundtrip() {
        // Test with a known value
        let fr = Fr::from(12345u64);
        let bytes = fr_to_seed_bytes_le(fr);
        let recovered = seed_bytes_le_to_fr(&bytes);
        assert_eq!(fr, recovered, "Roundtrip conversion failed");
    }

    #[test]
    fn test_known_vectors() {
        // Test vector 1: Small number
        let fr1 = Fr::from(1u64);
        let bytes1 = fr_to_seed_bytes_le(fr1);
        let expected1 = [
            1, 0, 0, 0, 0, 0, 0, 0,  // First limb = 1
            0, 0, 0, 0, 0, 0, 0, 0,  // Second limb = 0
            0, 0, 0, 0, 0, 0, 0, 0,  // Third limb = 0
            0, 0, 0, 0, 0, 0, 0, 0,  // Fourth limb = 0
        ];
        assert_eq!(bytes1, expected1, "Vector 1 failed");

        // Test vector 2: Larger number (0x3039 = 12345)
        let fr2 = Fr::from(12345u64);
        let bytes2 = fr_to_seed_bytes_le(fr2);
        assert_eq!(bytes2[0], 0x39);
        assert_eq!(bytes2[1], 0x30);
        assert_eq!(bytes2[2], 0x00);
        // Rest should be zeros
        for i in 3..32 {
            assert_eq!(bytes2[i], 0x00);
        }
    }

    #[test]
    fn test_max_field_element() {
        // Test with field modulus - 1 (max valid element)
        // BN254 modulus = 21888242871839275222246405745257275088548364400416034343698204186575808495617
        let fr_max = Fr::from(-1i64); // This gives us modulus - 1
        let bytes = fr_to_seed_bytes_le(fr_max);
        let recovered = seed_bytes_le_to_fr(&bytes);
        assert_eq!(fr_max, recovered, "Max element roundtrip failed");
    }
}