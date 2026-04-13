//! Debug instructions for Merkle tree verification
//! Feature-gated, never deployed to mainnet

use anchor_lang::prelude::*;
use crate::state_v2_clean::*;
use crate::v2::poseidon_helpers::ZERO_CHAIN_BE;
use crate::ZerokError;
use solana_poseidon::{hashv, Parameters, Endianness};

/// Debug instruction to log Merkle computation step-by-step
/// Helps identify endianness/encoding mismatches with off-chain tools
#[cfg(feature = "debug-merkle")]
#[derive(Accounts)]
pub struct DebugMerkleComputation<'info> {
    /// CHECK: State PDA - validated in handler
    pub pool_state: UncheckedAccount<'info>,
}

#[cfg(feature = "debug-merkle")]
pub fn handler_debug_merkle_computation(
    ctx: Context<DebugMerkleComputation>,
    commitment_be: [u8; 32],
    leaf_index: u32,
) -> Result<()> {
    msg!("🔍 DEBUG: Merkle Computation for leaf index {}", leaf_index);
    msg!("Commitment (BE): {:?}", hex::encode(&commitment_be));

    // Load state
    let account_data = ctx.accounts.pool_state.try_borrow_data()?;
    let discriminator = <ZerokStateV2Clean as anchor_lang::Discriminator>::DISCRIMINATOR;
    require!(
        account_data.len() >= 8 + ZerokStateV2Clean::SIZE && &account_data[0..8] == discriminator,
        ZerokError::InvalidStateAccount
    );

    let state: &ZerokStateV2Clean = bytemuck::from_bytes(&account_data[8..8 + ZerokStateV2Clean::SIZE]);

    msg!("Current root: {:?}", hex::encode(&state.current_root));
    msg!("Leaf count: {}", state.leaf_count);
    msg!("");

    // Recompute Merkle path from commitment
    let mut node_be = commitment_be;
    let mut idx = leaf_index;

    msg!("Computing path from leaf {} to root:", leaf_index);

    for level in 0..20 {
        let (left, right) = if (idx & 1) == 0 {
            // Left child, sibling is right
            (node_be, ZERO_CHAIN_BE[level])
        } else {
            // Right child, sibling is left (from frontier)
            (state.merkle_frontier[level], node_be)
        };

        // Log inputs
        msg!("  Level {}: idx={}, position={}",
            level,
            idx,
            if (idx & 1) == 0 { "LEFT" } else { "RIGHT" }
        );
        msg!("    left:  {:?}", hex::encode(&left));
        msg!("    right: {:?}", hex::encode(&right));

        // Hash with same syscall as deposit
        node_be = hashv(
            Parameters::Bn254X5,
            Endianness::BigEndian,
            &[&left, &right]
        )
        .map_err(|_| ZerokError::PoseidonHashError)?
        .to_bytes();

        msg!("    hash:  {:?}", hex::encode(&node_be));
        msg!("");

        idx >>= 1;
    }

    msg!("Final computed root: {:?}", hex::encode(&node_be));
    msg!("On-chain root:       {:?}", hex::encode(&state.current_root));
    msg!("Match: {}", if node_be == state.current_root { "✅" } else { "❌" });

    Ok(())
}

// Stub for when feature is disabled
#[cfg(not(feature = "debug-merkle"))]
#[derive(Accounts)]
pub struct DebugMerkleComputation<'info> {
    /// CHECK: Not used
    pub pool_state: UncheckedAccount<'info>,
}

#[cfg(not(feature = "debug-merkle"))]
pub fn handler_debug_merkle_computation(
    _ctx: Context<DebugMerkleComputation>,
    _commitment_be: [u8; 32],
    _leaf_index: u32,
) -> Result<()> {
    Err(ZerokError::Deprecated.into())
}
