/// Zerok v2 State Structures
/// Following consultant's brief: versioned PDAs with BE configuration

use anchor_lang::prelude::*;
use crate::constants::TREE_HEIGHT;

// Use constant from lib.rs
const ROOT_HISTORY: usize = 30;

/// v2 State with version and endianness tracking
#[account]
pub struct ZerokStateV2 {
    /// Version identifier (= 2 for v2 pool)
    pub version: u8,

    /// Endianness flag (1 = BE, 0 = LE)
    pub endianness: u8,

    /// Admin authority
    pub authority: Pubkey,

    /// Stored verifying key for the circuit
    pub verifying_key: Vec<u8>,

    /// Is VK finalized flag
    pub vk_finalized: bool,

    /// Denomination in lamports
    pub denomination: u64,

    /// Number of deposits
    pub leaves_count: u32,

    /// Current root index
    pub current_root_index: u32,

    /// Merkle tree roots history
    pub roots: Vec<[u8; 32]>,

    /// Emergency pause flag
    pub emergency_paused: bool,

    /// Maximum relayer fee (basis points)
    pub max_fee_bps: u16,

    /// Daily withdrawal limit (lamports)
    pub daily_limit: u64,

    /// Daily withdrawals tracker
    pub daily_withdrawn: u64,

    /// Last reset timestamp
    pub last_reset: i64,

    /// Merkle tree levels (optimization)
    pub levels: Vec<[u8; 32]>,

    /// Reserved space for future upgrades
    pub reserved: [u8; 64],
}

impl ZerokStateV2 {
    /// Space required for v2 state account
    pub const SPACE: usize = 8 +  // discriminator
        1 +                        // version
        1 +                        // endianness
        32 +                       // authority
        4 + 2048 +                 // verifying_key (vec with max 2048 bytes)
        1 +                        // vk_finalized
        8 +                        // denomination
        4 +                        // leaves_count
        4 +                        // current_root_index
        4 + 32 * ROOT_HISTORY +    // roots vec
        1 +                        // emergency_paused
        2 +                        // max_fee_bps
        8 +                        // daily_limit
        8 +                        // daily_withdrawn
        8 +                        // last_reset
        4 + 32 * TREE_HEIGHT +     // levels vec
        64;                        // reserved

    /// Initialize new v2 state
    pub fn initialize(
        &mut self,
        authority: Pubkey,
        denomination: u64,
        max_fee_bps: u16,
        daily_limit: u64,
    ) {
        self.version = 2;
        self.endianness = 1; // BE = 1
        self.authority = authority;
        self.verifying_key = Vec::new();
        self.vk_finalized = false;
        self.denomination = denomination;
        self.leaves_count = 0;
        self.current_root_index = 0;

        // Initialize roots with zeros
        self.roots = vec![[0u8; 32]; ROOT_HISTORY];

        // Initialize security parameters
        self.emergency_paused = false;
        self.max_fee_bps = max_fee_bps;
        self.daily_limit = daily_limit;
        self.daily_withdrawn = 0;
        self.last_reset = Clock::get().unwrap().unix_timestamp;

        // Initialize tree levels with default values
        self.levels = vec![[0u8; 32]; TREE_HEIGHT];

        self.reserved = [0u8; 64];
    }

    /// Check if using big-endian
    pub fn is_big_endian(&self) -> bool {
        self.endianness == 1
    }

    /// Get the version
    pub fn get_version(&self) -> u8 {
        self.version
    }
}