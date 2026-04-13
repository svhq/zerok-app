//! Verification Key (VK) Account Layout
//!
//! Single source of truth for VK PDA structure to prevent offset drift.
//!
//! # Account Structure
//!
//! ```text
//! ┌─────────────────────────────────────────┐
//! │ Header (49 bytes)                       │
//! ├─────────────────────────────────────────┤
//! │ - Discriminator:      8 bytes           │
//! │ - Authority:         32 bytes (Pubkey)  │
//! │ - VK Uploaded Bytes:  8 bytes (u64)     │
//! │ - VK Finalized:       1 byte  (u8)      │
//! ├─────────────────────────────────────────┤
//! │ VK Data (1028 bytes)                    │
//! │ - Groth16 verifying key                 │
//! └─────────────────────────────────────────┘
//! Total: 1077 bytes
//! ```
//!
//! # Safety
//!
//! All VK data access MUST go through `vk_data_slice()` to ensure:
//! - Correct offset (skips 49-byte header)
//! - Length validation (account must be exactly 1077 bytes)
//! - Future-proof (centralized layout definition)

use anchor_lang::prelude::*;

/// Size of VK PDA header (discriminator + authority + metadata)
pub const VK_HEADER_BYTES: usize = 49;

/// Size of raw VK data (Groth16 verifying key)
pub const VK_DATA_BYTES: usize = 1028;

/// Total VK account size (header + data)
pub const VK_ACCOUNT_SIZE: usize = VK_HEADER_BYTES + VK_DATA_BYTES; // 1077

/// Extract VK data from VK PDA account, skipping header
///
/// # Safety
///
/// - Validates account length is exactly `VK_ACCOUNT_SIZE`
/// - Returns slice starting at `VK_HEADER_BYTES` (offset 49)
/// - Returned slice is exactly `VK_DATA_BYTES` (1028 bytes)
///
/// # Errors
///
/// Returns `ProgramError::InvalidAccountData` if account size != 1077 bytes
///
/// # Example
///
/// ```ignore
/// let vk_pda_data = ctx.accounts.vk_pda.try_borrow_data()?;
/// let vk_bytes = vk_layout::vk_data_slice(&vk_pda_data)?;
/// // vk_bytes is now exactly 1028 bytes, ready for deserialization
/// ```
#[inline]
pub fn vk_data_slice(acct_data: &[u8]) -> Result<&[u8]> {
    use crate::ZerokError;

    // Length guard: account must be exactly 1077 bytes
    if acct_data.len() != VK_ACCOUNT_SIZE {
        msg!("VK account size mismatch: expected {}, got {}", VK_ACCOUNT_SIZE, acct_data.len());
        return Err(ZerokError::InvalidVKLength.into());
    }

    // Return VK data slice (offset 49, length 1028)
    Ok(&acct_data[VK_HEADER_BYTES..VK_HEADER_BYTES + VK_DATA_BYTES])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vk_data_slice_correct_size() {
        // Create buffer: 49-byte header + 1028-byte VK
        let mut buffer = vec![0u8; VK_ACCOUNT_SIZE];

        // Mark first 4 bytes of VK data as 0x08000000 (nr_pubinputs = 8 in LE)
        buffer[VK_HEADER_BYTES] = 0x08;
        buffer[VK_HEADER_BYTES + 1] = 0x00;
        buffer[VK_HEADER_BYTES + 2] = 0x00;
        buffer[VK_HEADER_BYTES + 3] = 0x00;

        let result = vk_data_slice(&buffer);
        assert!(result.is_ok());

        let vk_slice = result.unwrap();
        assert_eq!(vk_slice.len(), VK_DATA_BYTES);
        assert_eq!(vk_slice[0], 0x08); // Verify correct offset
    }

    #[test]
    fn test_vk_data_slice_wrong_size() {
        let buffer = vec![0u8; 1076]; // Off by one
        let result = vk_data_slice(&buffer);
        assert!(result.is_err());
    }

    #[test]
    fn test_constants_sum() {
        assert_eq!(VK_ACCOUNT_SIZE, VK_HEADER_BYTES + VK_DATA_BYTES);
        assert_eq!(VK_ACCOUNT_SIZE, 1077);
        assert_eq!(VK_HEADER_BYTES, 49);
        assert_eq!(VK_DATA_BYTES, 1028);
    }
}
