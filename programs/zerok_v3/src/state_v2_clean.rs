//! Clean v2 state with NO contamination from old implementations
//! Uses frontier-based merkle tree for efficiency

use anchor_lang::prelude::*;
use bytemuck::{Pod, Zeroable};
use crate::constants::EMPTY_ROOT;

/// Clean PDA seeds - Multi-pool by denomination design
/// Each pool (denomination) has its own PDAs → separate anonymity sets
pub const ZEROK_STATE_SEED: &[u8] = b"zerok_v1";
pub const VAULT_V2_CLEAN_SEED: &[u8] = b"vault";
pub const COMMITMENT_V2_CLEAN_SEED: &[u8] = b"commitment_v2_clean";
pub const NULLIFIER_V2_CLEAN_SEED: &[u8] = b"nullifier";
pub const VK_V2_CLEAN_SEED: &[u8] = b"vk";

/// VK size constants for chunked upload
/// VK format: nr_pubinputs (4) + alpha_g1 (64) + beta_g2 (128) + gamma_g2 (128) + delta_g2 (128) + IC array ((n+1) * 64)
/// For 8 public inputs: 4 + 64 + 384 + (9 * 64) = 4 + 448 + 576 = 1028 bytes
/// For 9 public inputs (groth16-solana reference): 4 + 64 + 384 + (10 * 64) = 4 + 448 + 640 = 1092 bytes
pub const VK_TOTAL_BYTES: u16 = 1028; // Exact size for withdraw circuit (8 inputs)
pub const MAX_VK_CHUNK: u16 = 900;

/// VK account layout constants (System Program account with manual state management)
/// Layout: 8-byte discriminator + 32-byte authority + 8-byte vk_uploaded_bytes + 1-byte vk_finalized + VK data
pub const VK_HEADER_BYTES: u16 = 49; // 8 + 32 + 8 + 1
pub const VK_ACCOUNT_SIZE: u16 = VK_HEADER_BYTES + VK_TOTAL_BYTES; // 49 + 1028 = 1077

/// Cooldown PDA seeds
pub const COOLDOWN_CONFIG_SEED: &[u8] = b"cooldown_config";
pub const USER_COOLDOWN_SEED: &[u8] = b"user_cooldown";

/// Clean v2 state account
/// Zero-copy to avoid stack overflow
/// Uses repr(C) with explicit padding for Pod compatibility and IDL generation
#[account(zero_copy)]
#[repr(C)]
pub struct ZerokStateV2Clean {
    /// Denomination in lamports (8-byte aligned)
    pub denomination: u64,

    /// Authority who can update the pool (32 bytes)
    pub authority: Pubkey,

    /// Merkle tree frontier (not levels!) - stores rightmost path
    /// This is more efficient than storing all levels
    pub merkle_frontier: [[u8; 32]; 20],

    /// Current merkle root
    pub current_root: [u8; 32],

    /// Rolling history of roots (for withdrawal proofs)
    /// Extended to 256 for ~21 minute withdrawal window (vs 30 = ~2.5 minutes)
    pub root_history: [[u8; 32]; 256],

    /// VK account PDA (stores 1040-byte verifying key)
    pub vk_account: Pubkey,

    /// SHA256 hash of verifying_key for integrity verification
    pub vk_hash: [u8; 32],

    /// Current index in root history (circular buffer, 4-byte aligned)
    pub root_index: u32,

    /// Total number of deposits (4-byte aligned)
    pub leaf_count: u32,

    /// Maximum fee in basis points (e.g., 100 = 1%, 2-byte aligned)
    pub max_fee_bps: u16,

    /// Tracks VK upload progress (chunked upload, 2-byte aligned)
    pub vk_uploaded_bytes: u16,

    /// Version identifier (always 2, 1-byte aligned)
    pub version: u8,

    /// Whether VK has been finalized (0 = not finalized, non-zero = finalized)
    pub vk_finalized: u8,

    /// Emergency pause flag (authority only)
    /// 0 = unpaused, non-zero = paused
    pub paused: u8,

    /// Explicit padding to ensure 8-byte alignment for Pod compatibility
    /// This is initialized padding (Pod-safe), not compiler-inserted padding
    pub _padding: [u8; 1],
}

impl ZerokStateV2Clean {
    /// Struct size (excluding discriminator)
    pub const SIZE: usize = core::mem::size_of::<Self>();

    /// Space required for the account (including 8-byte discriminator)
    pub const SPACE: usize = 8 + Self::SIZE;

    /// Compile-time assertion: Verify size is exactly 8984 bytes (with 256-root history)
    /// Old size: 1752 bytes (30 roots = 960 bytes)
    /// New size: 1752 - 960 + 8192 = 8984 bytes (256 roots = 8192 bytes)
    const _SIZE_CHECK: () = assert!(Self::SIZE == 8984, "ZerokStateV2Clean size must be 8984 bytes");

    /// Compile-time assertion: Verify size is 8-byte aligned for Pod compatibility
    const _ALIGNMENT_CHECK: () = assert!(Self::SIZE % 8 == 0, "ZerokStateV2Clean must be 8-byte aligned");

    /// Check if pool is paused
    #[inline]
    pub fn is_paused(&self) -> bool {
        self.paused != 0
    }

    /// Set pause state
    #[inline]
    pub fn set_paused(&mut self, paused: bool) {
        self.paused = if paused { 1 } else { 0 };
    }

    /// Initialize clean state
    pub fn initialize(
        &mut self,
        authority: Pubkey,
        denomination: u64,
        max_fee_bps: u16,
    ) {
        self.version = 2;
        self.authority = authority;
        self.denomination = denomination;
        self.max_fee_bps = max_fee_bps;
        self.leaf_count = 0;
        self.root_index = 0;
        self.vk_account = Pubkey::default();
        self.set_vk_finalized(false);
        self.vk_hash = [0u8; 32];
        self.set_paused(false);
        self.vk_uploaded_bytes = 0;

        // Initialize with zero values
        self.merkle_frontier = [[0u8; 32]; 20];
        // Empty tree root is the 20th level of zero chain (from constants.rs)
        self.current_root = EMPTY_ROOT;

        // Initialize root history with the empty tree root
        self.root_history = [[0u8; 32]; 256];
        self.root_history[0] = self.current_root;

        // Zero explicit padding for Pod safety
        self._padding = [0];
    }
    
    /// Get next root index (circular buffer)
    pub fn next_root_index(&self) -> usize {
        ((self.root_index + 1) % 256) as usize
    }
    
    /// Check if a root exists in history
    pub fn is_known_root(&self, root: &[u8; 32]) -> bool {
        self.root_history.iter().any(|r| r == root)
    }

    /// Check if VK is finalized
    #[inline]
    pub fn is_vk_finalized(&self) -> bool {
        self.vk_finalized != 0
    }

    /// Set VK finalized state
    #[inline]
    pub fn set_vk_finalized(&mut self, finalized: bool) {
        self.vk_finalized = if finalized { 1 } else { 0 };
    }
}

/// Nullifier record for v2_clean - prevents double-spend
#[account]
pub struct NullifierV2Clean {
    /// The nullifier hash this record represents
    pub nullifier_hash: [u8; 32],

    /// Unix timestamp when this nullifier was spent
    pub spent_at: i64,

    /// Solana slot number when spent
    pub spent_slot: u64,

    /// The recipient address from the withdrawal
    pub recipient: Pubkey,

    /// Fee paid to relayer (if any)
    pub fee: u64,
}

impl NullifierV2Clean {
    /// Space required for the account
    pub const SPACE: usize = 8 +  // discriminator
        32 +                       // nullifier_hash
        8 +                        // spent_at
        8 +                        // spent_slot
        32 +                       // recipient
        8;                         // fee

    /// Initialize the nullifier record
    pub fn initialize(
        &mut self,
        nullifier_hash: [u8; 32],
        recipient: Pubkey,
        fee: u64,
        clock: &Clock,
    ) {
        self.nullifier_hash = nullifier_hash;
        self.spent_at = clock.unix_timestamp;
        self.spent_slot = clock.slot;
        self.recipient = recipient;
        self.fee = fee;
    }

    /// Manually serialize nullifier data to account
    ///
    /// Used when creating nullifier account manually (not via init macro)
    /// Layout: discriminator (8) + nullifier_hash (32) + spent_at (8) +
    ///         spent_slot (8) + recipient (32) + fee (8) = 96 bytes
    pub fn serialize_into(&self, data: &mut [u8]) -> Result<()> {
        require!(
            data.len() >= Self::SPACE,
            anchor_lang::error::ErrorCode::AccountDidNotSerialize
        );

        // Write Anchor discriminator (8 bytes)
        // For NullifierV2Clean account type
        let discriminator = <NullifierV2Clean as anchor_lang::Discriminator>::DISCRIMINATOR;
        data[0..8].copy_from_slice(&discriminator);

        // Write fields
        let mut offset = 8;

        // nullifier_hash (32 bytes)
        data[offset..offset + 32].copy_from_slice(&self.nullifier_hash);
        offset += 32;

        // spent_at (8 bytes, little-endian)
        data[offset..offset + 8].copy_from_slice(&self.spent_at.to_le_bytes());
        offset += 8;

        // spent_slot (8 bytes, little-endian)
        data[offset..offset + 8].copy_from_slice(&self.spent_slot.to_le_bytes());
        offset += 8;

        // recipient (32 bytes)
        data[offset..offset + 32].copy_from_slice(&self.recipient.to_bytes());
        offset += 32;

        // fee (8 bytes, little-endian)
        data[offset..offset + 8].copy_from_slice(&self.fee.to_le_bytes());

        Ok(())
    }
}

/// Per-user deposit cooldown tracking
/// Minimal state: just the last deposit slot
#[account]
pub struct UserDepositCooldown {
    /// Slot number of last successful deposit
    /// 0 = never deposited (first deposit always succeeds)
    pub last_slot: u64,
}

impl UserDepositCooldown {
    /// Space required for the account (8-byte discriminator + 8-byte last_slot)
    pub const SPACE: usize = 8 + 8;

    /// Initialize with zero slot (first deposit)
    pub fn initialize(&mut self) {
        self.last_slot = 0;
    }

    /// Update last deposit slot
    pub fn update_slot(&mut self, slot: u64) {
        self.last_slot = slot;
    }

    /// Check if cooldown period has elapsed
    pub fn is_ready(&self, current_slot: u64, cooldown_slots: u64) -> bool {
        if self.last_slot == 0 {
            // First deposit always ready
            return true;
        }

        let slots_elapsed = current_slot.saturating_sub(self.last_slot);
        slots_elapsed >= cooldown_slots
    }

    /// Get remaining cooldown slots
    pub fn remaining_slots(&self, current_slot: u64, cooldown_slots: u64) -> u64 {
        if self.last_slot == 0 {
            return 0;
        }

        let slots_elapsed = current_slot.saturating_sub(self.last_slot);
        if slots_elapsed >= cooldown_slots {
            0
        } else {
            cooldown_slots - slots_elapsed
        }
    }
}

/// Pool-level cooldown configuration
/// Authority-controlled, tunable without redeploy
#[account]
pub struct PoolCooldownConfig {
    /// Authority who can update the config
    pub authority: Pubkey,

    /// Number of slots to wait between deposits
    /// 3 slots ≈ 1.2 seconds on Solana mainnet (~400ms/slot)
    /// Set to 0 to disable cooldown
    pub cooldown_slots: u64,

    /// Whether cooldown is enabled
    /// Allows disabling without changing cooldown_slots
    pub enabled: bool,
}

impl PoolCooldownConfig {
    /// Space required for the account
    pub const SPACE: usize = 8 +  // discriminator
        32 +                       // authority
        8 +                        // cooldown_slots
        1;                         // enabled (bool)

    /// Initialize config with default settings
    pub fn initialize(&mut self, authority: Pubkey, cooldown_slots: u64) {
        self.authority = authority;
        self.cooldown_slots = cooldown_slots;
        self.enabled = true;
    }

    /// Update cooldown settings
    pub fn update(&mut self, cooldown_slots: Option<u64>, enabled: Option<bool>) {
        if let Some(slots) = cooldown_slots {
            self.cooldown_slots = slots;
        }
        if let Some(enable) = enabled {
            self.enabled = enable;
        }
    }

    /// Check if cooldown is active
    pub fn is_active(&self) -> bool {
        self.enabled && self.cooldown_slots > 0
    }
}