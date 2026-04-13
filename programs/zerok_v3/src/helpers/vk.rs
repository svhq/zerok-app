use anchor_lang::prelude::*;
use sha2::{Digest, Sha256};
use crate::{ZerokError, VerifyingKeyAccount};

/// Compute SHA256 hash of raw bytes
/// Internal helper for the canonical hash function
pub fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);

    let hash_result = hasher.finalize();
    let mut hash_bytes = [0u8; 32];
    hash_bytes.copy_from_slice(&hash_result);

    hash_bytes
}

/// Single source of truth for VK hashing
/// Always hashes exactly vk_account.data[..length]
///
/// This is THE canonical function used in:
/// - finalize_vk: to store the hash
/// - withdraw: to verify the hash
///
/// # First Principles
/// - One function, one truth
/// - Hash the actual VK data, not metadata
/// - Explicit about which bytes are hashed
pub fn vk_hash_data_field(vk: &VerifyingKeyAccount) -> [u8; 32] {
    sha256_bytes(&vk.data_as_slice()[..vk.length as usize])
}