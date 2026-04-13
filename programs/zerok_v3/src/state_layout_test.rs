//! State layout regression tests
//! Ensures struct layout remains stable across changes

#[cfg(test)]
mod tests {
    use crate::state_v2_clean::ZerokStateV2Clean;
    use std::mem::{size_of, offset_of};

    #[test]
    fn test_zerok_state_v2_clean_layout() {
        // Verify total struct size (with 256-root history = 8984 bytes)
        // Old: 1752 bytes (30 roots = 960 bytes)
        // New: 8984 bytes (256 roots = 8192 bytes, +7232 difference)
        assert_eq!(
            size_of::<ZerokStateV2Clean>(),
            8984,
            "ZerokStateV2Clean struct size changed unexpectedly"
        );

        // Verify SPACE constant includes discriminator
        assert_eq!(
            ZerokStateV2Clean::SPACE,
            8992,
            "SPACE constant should be 8984 + 8 discriminator"
        );

        // Verify 8-byte alignment
        assert_eq!(
            size_of::<ZerokStateV2Clean>() % 8,
            0,
            "ZerokStateV2Clean must be 8-byte aligned for Pod compatibility"
        );
    }

    #[test]
    fn test_paused_field_layout() {
        // Verify paused field is u8 (1 byte)
        let test_state = ZerokStateV2Clean {
            denomination: 0,
            authority: anchor_lang::prelude::Pubkey::default(),
            merkle_frontier: [[0u8; 32]; 20],
            current_root: [0u8; 32],
            root_history: [[0u8; 32]; 256],
            vk_account: anchor_lang::prelude::Pubkey::default(),
            vk_hash: [0u8; 32],
            root_index: 0,
            leaf_count: 0,
            max_fee_bps: 0,
            vk_uploaded_bytes: 0,
            version: 2,
            vk_finalized: 0,  // u8, not bool
            paused: 0,  // u8, not bool
            _padding: [0],  // Explicit padding for 8-byte alignment
        };

        // Verify paused field is at expected offset (after vk_finalized)
        // Layout: denomination(8) + authority(32) + merkle_frontier(640) + current_root(32) +
        //         root_history(8192) + vk_account(32) + vk_hash(32) + root_index(4) +
        //         leaf_count(4) + max_fee_bps(2) + vk_uploaded_bytes(2) + version(1) + vk_finalized(1) + padding(2) = 8982
        // Note: 2 bytes of padding for alignment after vk_finalized
        let offset = offset_of!(ZerokStateV2Clean, paused);
        assert_eq!(
            offset,
            8982,
            "paused field offset changed unexpectedly"
        );
    }

    #[test]
    fn test_paused_helpers() {
        use anchor_lang::prelude::Pubkey;

        let mut state = ZerokStateV2Clean {
            denomination: 0,
            authority: Pubkey::default(),
            merkle_frontier: [[0u8; 32]; 20],
            current_root: [0u8; 32],
            root_history: [[0u8; 32]; 256],
            vk_account: Pubkey::default(),
            vk_hash: [0u8; 32],
            root_index: 0,
            leaf_count: 0,
            max_fee_bps: 0,
            vk_uploaded_bytes: 0,
            version: 2,
            vk_finalized: 0,  // u8, not bool
            paused: 0,  // u8, not bool
            _padding: [0],  // Explicit padding for 8-byte alignment
        };

        // Test initial state (unpaused)
        assert_eq!(state.paused, 0, "Initial paused value should be 0");
        assert_eq!(state.is_paused(), false, "is_paused() should return false");

        // Test set_paused(true)
        state.set_paused(true);
        assert_eq!(state.paused, 1, "paused should be 1 after set_paused(true)");
        assert_eq!(state.is_paused(), true, "is_paused() should return true");

        // Test set_paused(false)
        state.set_paused(false);
        assert_eq!(state.paused, 0, "paused should be 0 after set_paused(false)");
        assert_eq!(state.is_paused(), false, "is_paused() should return false");

        // Test non-zero values (belt-and-suspenders check)
        state.paused = 255;
        assert_eq!(state.is_paused(), true, "is_paused() should return true for any non-zero");

        state.paused = 42;
        assert_eq!(state.is_paused(), true, "is_paused() should return true for any non-zero");
    }
}
