use anchor_lang::prelude::*;

/// RootRing: LEGACY ring buffer of K=128 recent Merkle roots (localnet only)
///
/// IMPORTANT: This is the LEGACY_ROOT_RING, used only for localnet backward compatibility.
/// For devnet/mainnet, use the SHARDED_ROOT_RING (20 shards × 128 = 2560 capacity).
///
/// Purpose: Enable withdrawals against any of the last K roots, eliminating
/// dependency on indexer synchronization. Users can withdraw as long as their
/// deposit is within the K-root window (~days of validity).
///
/// Architecture: Fixed-size ring buffer (no reallocs), circular head pointer
/// wraps at capacity. Slots provide temporal ordering for root expiry tracking.
#[account(zero_copy)]
#[repr(C)]
pub struct RootRing {
    /// Schema version for future upgrades
    pub version: u64,              // 8 bytes

    /// Ring capacity (K = 128) - legacy ring, localnet only
    /// Note: Devnet/mainnet use sharded ring (20 × 128 = 2560)
    pub capacity: u32,             // 4 bytes

    /// Next write index (wraps at capacity)
    pub head: u32,                 // 4 bytes

    /// Alignment padding to ensure entries starts at 8-byte boundary
    pub _padding: [u8; 8],         // 8 bytes (12 + 8 = 20, but aligned to 24)

    /// Ring buffer of root entries (capacity = 128)
    pub entries: [RootEntry; 128], // 5120 bytes (40 * 128)
}

/// Single entry in the RootRing
#[zero_copy]
#[derive(Default, Debug, PartialEq)]
pub struct RootEntry {
    /// Merkle root (32 bytes)
    pub root: [u8; 32],

    /// Slot when this root was inserted (for temporal tracking)
    pub slot: u64,
}

impl RootRing {
    /// Total size of RootRing struct
    /// 8 (version) + 4 (capacity) + 4 (head) + 8 (padding) + (40 * 128) (entries) = 5144 bytes
    /// + 8 bytes discriminator = 5152 bytes total (well under 10KB CPI limit)
    /// Note: K=128 gives ~18 days withdrawal validity at 7 deposits/day mainnet rate
    pub const LEN: usize = 8 + 4 + 4 + 8 + (40 * 128);

    /// Push a new root into the ring buffer
    ///
    /// # Arguments
    /// * `root` - 32-byte Merkle root to store
    /// * `slot` - Current slot number (for temporal tracking)
    ///
    /// # Behavior
    /// - Overwrites oldest entry when ring is full (circular buffer)
    /// - Head pointer wraps at capacity using modulo arithmetic
    /// - Monotonic slot requirement prevents out-of-order insertions
    pub fn push(&mut self, root: [u8; 32], slot: u64) -> Result<()> {
        // Anti-footgun: Ensure slot is monotonically increasing
        // This prevents out-of-order insertions that could break witness fast-forwarding
        if self.head > 0 {
            let prev_idx = ((self.head - 1) as usize) % (self.capacity as usize);
            let prev_slot = self.entries[prev_idx].slot;
            require!(
                slot >= prev_slot,
                crate::ZerokError::SlotNotMonotonic
            );
        }

        // Write to ring buffer (circular)
        let idx = (self.head as usize) % (self.capacity as usize);
        self.entries[idx] = RootEntry { root, slot };

        // Advance head with wrapping
        self.head = self.head.wrapping_add(1);

        Ok(())
    }

    /// Check if a root exists in the ring buffer
    ///
    /// # Arguments
    /// * `target_root` - Root to search for
    ///
    /// # Returns
    /// `true` if root found and slot > 0 (valid entry), `false` otherwise
    ///
    /// # Note
    /// slot > 0 check filters out zero-initialized entries (unwritten slots)
    pub fn contains_root(&self, target_root: &[u8; 32]) -> bool {
        for entry in &self.entries {
            // Skip zero-initialized entries (slot == 0 means unwritten)
            if entry.slot > 0 && entry.root == *target_root {
                return true;
            }
        }
        false
    }

    /// Get the oldest root in the ring (earliest slot)
    ///
    /// # Returns
    /// `Some((root, slot))` if ring has valid entries, `None` if empty
    pub fn get_oldest_root(&self) -> Option<(RootEntry)> {
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

    /// Get the newest root in the ring (latest slot)
    ///
    /// # Returns
    /// `Some((root, slot))` if ring has valid entries, `None` if empty
    pub fn get_newest_root(&self) -> Option<(RootEntry)> {
        if self.head == 0 {
            return None;
        }

        // Most recent entry is at (head - 1) % capacity
        let idx = ((self.head - 1) as usize) % (self.capacity as usize);
        let entry = self.entries[idx];

        if entry.slot > 0 {
            Some(entry)
        } else {
            None
        }
    }

    /// Calculate root window duration in slots
    ///
    /// # Returns
    /// `Some(window_slots)` if ring has valid entries, `None` if empty or single entry
    pub fn get_window_slots(&self) -> Option<u64> {
        let oldest = self.get_oldest_root()?;
        let newest = self.get_newest_root()?;

        if newest.slot > oldest.slot {
            Some(newest.slot - oldest.slot)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_root_ring_size() {
        // Verify struct size matches expected constant
        assert_eq!(
            std::mem::size_of::<RootRing>(),
            RootRing::LEN,
            "RootRing size mismatch"
        );
    }

    #[test]
    fn test_root_entry_size() {
        // Verify RootEntry is 40 bytes (32 + 8)
        assert_eq!(
            std::mem::size_of::<RootEntry>(),
            40,
            "RootEntry should be 40 bytes"
        );
    }

    #[test]
    fn test_push_and_contains() {
        let mut ring = RootRing {
            version: 1,
            capacity: 128,
            head: 0,
            _padding: [0; 8],
            entries: [RootEntry::default(); 128],
        };

        let root1 = [1u8; 32];
        let root2 = [2u8; 32];

        // Push two roots
        ring.push(root1, 100).unwrap();
        ring.push(root2, 200).unwrap();

        // Verify both are found
        assert!(ring.contains_root(&root1));
        assert!(ring.contains_root(&root2));

        // Verify non-existent root not found
        let root3 = [3u8; 32];
        assert!(!ring.contains_root(&root3));
    }

    #[test]
    fn test_ring_wrap_at_capacity() {
        let mut ring = RootRing {
            version: 1,
            capacity: 128,
            head: 0,
            _padding: [0; 8],
            entries: [RootEntry::default(); 128],
        };

        // Fill ring to capacity
        for i in 0..128 {
            let root = [(i % 256) as u8; 32];
            ring.push(root, (i + 1) as u64).unwrap();
        }

        assert_eq!(ring.head, 128);

        // Push one more - should wrap to index 0
        let root_overflow = [99u8; 32];
        ring.push(root_overflow, 129).unwrap();

        assert_eq!(ring.head, 129);

        // Verify wrapped entry exists
        assert!(ring.contains_root(&root_overflow));
        assert_eq!(ring.entries[0].root, root_overflow);
        assert_eq!(ring.entries[0].slot, 129);
    }

    #[test]
    fn test_get_oldest_newest() {
        let mut ring = RootRing {
            version: 1,
            capacity: 128,
            head: 0,
            _padding: [0; 8],
            entries: [RootEntry::default(); 128],
        };

        // Empty ring
        assert!(ring.get_oldest_root().is_none());
        assert!(ring.get_newest_root().is_none());

        // Add some roots
        ring.push([1u8; 32], 100).unwrap();
        ring.push([2u8; 32], 200).unwrap();
        ring.push([3u8; 32], 300).unwrap();

        let oldest = ring.get_oldest_root().unwrap();
        let newest = ring.get_newest_root().unwrap();

        assert_eq!(oldest.slot, 100);
        assert_eq!(newest.slot, 300);
    }

    #[test]
    fn test_window_slots() {
        let mut ring = RootRing {
            version: 1,
            capacity: 128,
            head: 0,
            _padding: [0; 8],
            entries: [RootEntry::default(); 128],
        };

        // Empty ring
        assert!(ring.get_window_slots().is_none());

        // Add roots
        ring.push([1u8; 32], 1000).unwrap();
        ring.push([2u8; 32], 2000).unwrap();
        ring.push([3u8; 32], 3000).unwrap();

        let window = ring.get_window_slots().unwrap();
        assert_eq!(window, 2000); // 3000 - 1000
    }
}
