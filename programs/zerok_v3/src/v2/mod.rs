// ===== WORKING PATH: Native Poseidon Syscall =====
// Using solana-poseidon syscall for ~1.8k CU/hash (vs 70k manual)
pub mod poseidon_helpers; // ZERO_CHAIN_BE constant
pub mod verify_withdrawal; // Withdrawal proof verification helper

// Export ZERO_CHAIN_BE for merkle tree operations
pub use poseidon_helpers::ZERO_CHAIN_BE;
pub use verify_withdrawal::verify_withdrawal_proof;

// ===== UTILITY FUNCTIONS =====

/// BN254 field modulus in canonical 32-byte big-endian format
/// p = 21888242871839275222246405745257275088696311157297823662689037894645226208583
pub const BN254_P_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
    0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d,
    0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47
];

/// Check if a 32-byte BE value is a canonical field element (< p)
/// Following consultant's brief exactly
#[inline]
pub fn is_canonical_field_element(x: &[u8; 32]) -> bool {
    x < &BN254_P_BE
}

/// Convert u64 to 32-byte big-endian
/// Following consultant's brief for fee/refund encoding
#[inline]
pub fn u64_to_be32(x: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&x.to_be_bytes());
    out
}

/// Prepare public inputs for v2 (all BE encoded)
pub fn prepare_public_inputs_v2(
    root: &[u8; 32],
    nullifier_hash: &[u8; 32],
    recipient: &anchor_lang::prelude::Pubkey,
    relayer: &Option<anchor_lang::prelude::Pubkey>,
    fee: u64,
    refund: u64,
) -> [[u8; 32]; 8] {
    let relayer_key = relayer.unwrap_or_default();

    // Split 32-byte addresses into two 16-byte parts
    let recipient_bytes = recipient.to_bytes();
    let relayer_bytes = relayer_key.to_bytes();

    let mut recipient_high = [0u8; 32];
    let mut recipient_low = [0u8; 32];
    let mut relayer_high = [0u8; 32];
    let mut relayer_low = [0u8; 32];

    // Copy high and low parts (16 bytes each) into 32-byte arrays
    recipient_high[16..].copy_from_slice(&recipient_bytes[0..16]);
    recipient_low[16..].copy_from_slice(&recipient_bytes[16..32]);
    relayer_high[16..].copy_from_slice(&relayer_bytes[0..16]);
    relayer_low[16..].copy_from_slice(&relayer_bytes[16..32]);

    [
        *root,
        *nullifier_hash,
        recipient_high,
        recipient_low,
        relayer_high,
        relayer_low,
        u64_to_be32(fee),
        u64_to_be32(refund),
    ]
}

/// Validate all public inputs are canonical (< p)
pub fn validate_public_inputs(inputs: &[[u8; 32]; 8]) -> anchor_lang::Result<()> {
    use anchor_lang::prelude::*;

    for (i, input) in inputs.iter().enumerate() {
        require!(
            is_canonical_field_element(input),
            crate::ZerokError::PublicInputGreaterThanFieldSize
        );
    }
    Ok(())
}