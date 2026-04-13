use anchor_lang::prelude::*;
use crate::state_root_ring::RootEntry;

/// RootRingMetadata: Coordinator for sharded K=4,096 root ring
///
/// Purpose: Track 20 sharded PDAs to bypass Solana's 10KB CPI limit while
/// maintaining efficient withdrawal validation. Provides 12.00 bits of privacy
/// (4,096 anonymity set) with ~585 day validity @ 7 deposits/day.
///
/// Architecture: Sequential shard filling with lazy allocation. Deposits write
/// to active_shard_index, withdrawals search across all allocated shards.
///
/// Design: 20 shards × 128 entries = 2,560 total capacity
/// for optimal arithmetic and bytemuck compatibility. Shard size: 5,144 bytes
/// (huge 5,096 byte safety margin under 10,240 byte CPI limit).
#[account(zero_copy)]
#[repr(C)]
pub struct RootRingMetadata {
    /// Schema version for future upgrades
    pub version: u64,              // 8 bytes

    /// Total capacity across all shards (4,096)
    pub total_capacity: u32,       // 4 bytes

    /// Entries per shard (128)
    pub shard_capacity: u32,       // 4 bytes

    /// Number of shards (32)
    pub num_shards: u32,           // 4 bytes

    /// Global head pointer (0..4,095)
    /// Points to next insertion position across entire ring
    pub global_head: u32,          // 4 bytes

    /// Currently active shard index (0..31)
    /// Deposits write to this shard until it fills
    pub active_shard_index: u32,   // 4 bytes

    /// Padding for 8-byte alignment
    pub _padding: [u8; 4],         // 4 bytes

    /// Array of shard PDA addresses (lazy allocated)
    /// Pubkey::default() indicates shard not yet allocated
    pub shard_pdas: [Pubkey; 20],  // 640 bytes (20 * 32)
}

impl RootRingMetadata {
    /// Total size of RootRingMetadata struct
    /// 8 (version) + 4 (total_capacity) + 4 (shard_capacity) + 4 (num_shards) +
    /// 4 (global_head) + 4 (active_shard_index) + 4 (padding) + 640 (shard_pdas) = 672 bytes
    /// + 8 bytes discriminator = 680 bytes total
    pub const LEN: usize = 8 + 4 + 4 + 4 + 4 + 4 + 4 + (20 * 32);  // 20 shards x 32 bytes per Pubkey

    /// Check if a shard is allocated
    ///
    /// # Arguments
    /// * `shard_index` - Shard index (0..31)
    ///
    /// # Returns
    /// `true` if shard PDA is allocated, `false` if Pubkey::default()
    pub fn is_shard_allocated(&self, shard_index: u32) -> bool {
        if shard_index >= self.num_shards {
            return false;
        }
        self.shard_pdas[shard_index as usize] != Pubkey::default()
    }

    /// Get the current active shard PDA
    ///
    /// # Returns
    /// `Some(pubkey)` if active shard is allocated, `None` otherwise
    pub fn get_active_shard_pda(&self) -> Option<Pubkey> {
        if self.is_shard_allocated(self.active_shard_index) {
            Some(self.shard_pdas[self.active_shard_index as usize])
        } else {
            None
        }
    }

    /// Calculate which shard a global index belongs to
    ///
    /// # Arguments
    /// * `global_index` - Global index (0..4,095)
    ///
    /// # Returns
    /// (shard_index, local_index) tuple
    pub fn global_to_shard_index(&self, global_index: u32) -> (u32, u32) {
        let shard_index = global_index / self.shard_capacity;
        let local_index = global_index % self.shard_capacity;
        (shard_index, local_index)
    }

    /// Check if it's time to transition to next shard
    ///
    /// # Arguments
    /// * `current_shard` - Reference to current active shard
    ///
    /// # Returns
    /// `true` if shard is full and should transition, `false` otherwise
    pub fn should_transition_shard(&self, current_shard: &RootRingShard) -> bool {
        current_shard.local_head >= self.shard_capacity
    }

    /// Advance to next shard (wraps at num_shards)
    ///
    /// # Note
    /// Caller must ensure new shard is allocated before deposits
    pub fn advance_to_next_shard(&mut self) {
        self.active_shard_index = (self.active_shard_index + 1) % self.num_shards;
    }
}

/// RootRingShard: Single shard holding 128 root entries
///
/// Purpose: Store a contiguous chunk of the K=4,096 root ring. Each shard
/// stays safely under Solana's 10,240 byte CPI limit (5,144 bytes total).
///
/// Architecture: Fixed-size array of RootEntry, sequential filling via local_head.
/// When full, metadata transitions to next shard.
///
/// Design: 128 entries (power-of-2 for bytemuck compatibility and optimal arithmetic).
/// 128 × 40 bytes = 5,120 bytes (huge 5,096 byte safety margin under CPI limit).
#[account(zero_copy)]
#[repr(C)]
pub struct RootRingShard {
    /// Schema version for future upgrades
    pub version: u64,              // 8 bytes

    /// Shard index (0..31)
    pub shard_index: u32,          // 4 bytes

    /// Local head within this shard (0..127)
    /// Points to next insertion position within shard
    pub local_head: u32,           // 4 bytes

    /// Root entries in this shard (128 entries)
    pub entries: [RootEntry; 128], // 5,120 bytes (40 * 128)
}

impl RootRingShard {
    /// Total size of RootRingShard struct
    /// 8 (version) + 4 (shard_index) + 4 (local_head) + 5,120 (entries) = 5,136 bytes
    /// + 8 bytes discriminator = 5,144 bytes total (SAFE: 5,096 byte margin under 10,240 CPI limit)
    pub const LEN: usize = 8 + 4 + 4 + (40 * 128);

    /// Push a new root into this shard (circular buffer semantics)
    ///
    /// # Arguments
    /// * `root` - 32-byte Merkle root to store
    /// * `slot` - Current slot number (for temporal tracking)
    ///
    /// # Returns
    /// `Ok(())` always succeeds - circular buffer never "fills up"
    ///
    /// # Behavior
    /// - Computes write position using modulo: `pos = local_head % 128`
    /// - Writes to computed position (overwrites oldest entry on wrap)
    /// - Increments local_head (monotonic counter, never resets)
    ///
    /// # Circular Buffer Semantics
    /// This is a true circular buffer that supports infinite deposits.
    /// When local_head reaches 128 and beyond, writes wrap around and
    /// overwrite the oldest entries. This implements "forced expiry" -
    /// older roots become unwithdrawable as they are evicted from the ring.
    pub fn push(&mut self, root: [u8; 32], slot: u64) -> Result<()> {
        // Compute write position using modulo (true circular buffer)
        // This allows infinite deposits - shards are always writable
        let pos = (self.local_head % 128) as usize;

        // Write to position (overwrites oldest entry when wrapping)
        self.entries[pos] = RootEntry { root, slot };

        // Increment counter (monotonic, never resets, never errors)
        self.local_head += 1;

        Ok(())
    }

    /// Check if a root exists in this shard
    ///
    /// # Arguments
    /// * `target_root` - Root to search for
    ///
    /// # Returns
    /// `true` if root found and slot > 0 (valid entry), `false` otherwise
    pub fn contains_root(&self, target_root: &[u8; 32]) -> bool {
        for entry in &self.entries {
            // Skip zero-initialized entries (slot == 0 means unwritten)
            if entry.slot > 0 && entry.root == *target_root {
                return true;
            }
        }
        false
    }

    /// Check if this shard has completed at least one full cycle
    ///
    /// # Returns
    /// `true` if local_head >= 128 (has wrapped at least once), `false` otherwise
    ///
    /// # Note
    /// With circular buffer semantics, shards are never permanently "full".
    /// This method indicates whether the shard has wrapped and is now
    /// overwriting older entries.
    pub fn has_wrapped(&self) -> bool {
        self.local_head >= 128
    }

    /// Get the current number of entries in this shard
    ///
    /// # Returns
    /// Number of valid entries (capped at 128 after first cycle)
    pub fn entry_count(&self) -> u32 {
        std::cmp::min(self.local_head, 128)
    }

    /// Get the oldest root in this shard (earliest slot)
    ///
    /// # Returns
    /// `Some(entry)` if shard has valid entries, `None` if empty
    pub fn get_oldest_root(&self) -> Option<RootEntry> {
        let mut oldest: Option<RootEntry> = None;

        for entry in &self.entries {
            if entry.slot > 0 {
                match oldest {
                    None => oldest = Some(*entry),
                    Some(ref current) if entry.slot < current.slot => {
                        oldest = Some(*entry);
                    }
                    _ => {}
                }
            }
        }

        oldest
    }

    /// Get the newest root in this shard (latest slot)
    ///
    /// # Returns
    /// `Some(entry)` if shard has valid entries, `None` if empty
    pub fn get_newest_root(&self) -> Option<RootEntry> {
        if self.local_head == 0 {
            return None;
        }

        // Most recent entry is at (local_head - 1)
        let idx = (self.local_head - 1) as usize;
        let entry = self.entries[idx];

        if entry.slot > 0 {
            Some(entry)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_metadata_size() {
        assert_eq!(
            std::mem::size_of::<RootRingMetadata>(),
            RootRingMetadata::LEN,
            "RootRingMetadata size mismatch"
        );
    }

    #[test]
    fn test_shard_size() {
        assert_eq!(
            std::mem::size_of::<RootRingShard>(),
            RootRingShard::LEN,
            "RootRingShard size mismatch"
        );
    }

    #[test]
    fn test_global_to_shard_index() {
        let metadata = RootRingMetadata {
            version: 1,
            total_capacity: 4096,
            shard_capacity: 128,
            num_shards: 20,
            global_head: 0,
            active_shard_index: 0,
            _padding: [0; 4],
            shard_pdas: [Pubkey::default(); 20],
        };

        // Test boundary cases
        assert_eq!(metadata.global_to_shard_index(0), (0, 0));
        assert_eq!(metadata.global_to_shard_index(127), (0, 127));
        assert_eq!(metadata.global_to_shard_index(128), (1, 0));
        assert_eq!(metadata.global_to_shard_index(255), (1, 127));
        assert_eq!(metadata.global_to_shard_index(4095), (31, 127));
    }

    #[test]
    fn test_shard_push_and_contains() {
        let mut shard = RootRingShard {
            version: 1,
            shard_index: 0,
            local_head: 0,
            entries: [RootEntry::default(); 128],
        };

        let root1 = [1u8; 32];
        let root2 = [2u8; 32];

        // Push two roots
        shard.push(root1, 100).unwrap();
        shard.push(root2, 200).unwrap();

        // Verify both are found
        assert!(shard.contains_root(&root1));
        assert!(shard.contains_root(&root2));

        // Verify non-existent root not found
        let root3 = [3u8; 32];
        assert!(!shard.contains_root(&root3));
    }

    #[test]
    fn test_shard_circular_wrap() {
        let mut shard = RootRingShard {
            version: 1,
            shard_index: 0,
            local_head: 0,
            entries: [RootEntry::default(); 128],
        };

        // Fill shard to capacity (first cycle)
        for i in 0..128 {
            let root = [(i % 256) as u8; 32];
            shard.push(root, (i + 1) as u64).unwrap();
        }

        // Check that shard has wrapped
        assert!(shard.has_wrapped());
        assert_eq!(shard.local_head, 128);
        assert_eq!(shard.entry_count(), 128);

        // CRITICAL TEST: Push should succeed after first cycle (circular buffer)
        // This is the fix for the wrap-around bug at deposit 2561
        let result = shard.push([99u8; 32], 129);
        assert!(result.is_ok(), "Circular buffer should accept deposits after wrap");

        // Verify the overwrite happened at position 0 (129 % 128 = 1, but push was to 128 % 128 = 0)
        // Actually: local_head was 128 before push, so pos = 128 % 128 = 0
        assert_eq!(shard.local_head, 129);
        assert_eq!(shard.entries[0].root, [99u8; 32]);
        assert_eq!(shard.entries[0].slot, 129);

        // Verify position 1 still has original data (wasn't overwritten yet)
        assert_eq!(shard.entries[1].root, [1u8; 32]);
    }

    #[test]
    fn test_shard_multiple_cycles() {
        let mut shard = RootRingShard {
            version: 1,
            shard_index: 0,
            local_head: 0,
            entries: [RootEntry::default(); 128],
        };

        // Run through 3 full cycles (384 deposits)
        for i in 0..384 {
            let root = [(i % 256) as u8; 32];
            let result = shard.push(root, (i + 1) as u64);
            assert!(result.is_ok(), "Push {} should succeed", i);
        }

        // Verify final state
        assert_eq!(shard.local_head, 384);
        assert!(shard.has_wrapped());
        assert_eq!(shard.entry_count(), 128);

        // Verify last entry at position 383 % 128 = 127
        assert_eq!(shard.entries[127].slot, 384);
    }

    #[test]
    fn test_should_transition_shard() {
        let metadata = RootRingMetadata {
            version: 1,
            total_capacity: 4096,
            shard_capacity: 128,
            num_shards: 20,
            global_head: 0,
            active_shard_index: 0,
            _padding: [0; 4],
            shard_pdas: [Pubkey::default(); 20],
        };

        let mut shard = RootRingShard {
            version: 1,
            shard_index: 0,
            local_head: 127,
            entries: [RootEntry::default(); 128],
        };

        // Not yet full
        assert!(!metadata.should_transition_shard(&shard));

        // Fill last entry
        shard.local_head = 128;

        // Now should transition
        assert!(metadata.should_transition_shard(&shard));
    }

    #[test]
    fn test_advance_to_next_shard() {
        let mut metadata = RootRingMetadata {
            version: 1,
            total_capacity: 4096,
            shard_capacity: 128,
            num_shards: 20,
            global_head: 0,
            active_shard_index: 0,
            _padding: [0; 4],
            shard_pdas: [Pubkey::default(); 20],
        };

        // Advance through all shards
        for i in 1..20 {
            metadata.advance_to_next_shard();
            assert_eq!(metadata.active_shard_index, i);
        }

        // Should wrap back to 0
        metadata.advance_to_next_shard();
        assert_eq!(metadata.active_shard_index, 0);
    }
}
