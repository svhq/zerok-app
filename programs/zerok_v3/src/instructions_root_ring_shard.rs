use anchor_lang::prelude::*;
use crate::state_root_ring_shard::{RootRingMetadata, RootRingShard};

/// Initialize the sharded root ring metadata coordinator
///
/// Creates the metadata PDA that tracks all 20 shards for the K=2,560 ring.
/// Shards are lazily allocated on first use to minimize upfront rent cost.
#[derive(Accounts)]
pub struct InitRootRingV2Sharded<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + RootRingMetadata::LEN,
        seeds = [b"root_ring_metadata", pool_state.key().as_ref()],
        bump
    )]
    pub root_ring_metadata: AccountLoader<'info, RootRingMetadata>,

    /// CHECK: Pool state account (for seed derivation)
    pub pool_state: AccountInfo<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn init_root_ring_v2_sharded(ctx: Context<InitRootRingV2Sharded>) -> Result<()> {
    let metadata = &mut ctx.accounts.root_ring_metadata.load_init()?;

    metadata.version = 1;
    metadata.total_capacity = 2560;  // 20 shards × 128 entries
    metadata.shard_capacity = 128;
    metadata.num_shards = 20;
    metadata.global_head = 0;
    metadata.active_shard_index = 0;

    // Initialize all shard PDAs to Pubkey::default() (unallocated)
    // Shards will be lazy allocated on first deposit targeting them
    metadata.shard_pdas = [Pubkey::default(); 20];

    msg!(
        "RootRingMetadata initialized: total_capacity={}, shard_capacity={}, num_shards={}, version={}",
        metadata.total_capacity,
        metadata.shard_capacity,
        metadata.num_shards,
        metadata.version
    );

    Ok(())
}

/// Lazy allocate a specific shard PDA
///
/// Called automatically when a deposit targets an unallocated shard.
/// Updates metadata to record the new shard PDA address.
#[derive(Accounts)]
#[instruction(shard_index: u32)]
pub struct InitShard<'info> {
    #[account(
        mut,
        seeds = [b"root_ring_metadata", pool_state.key().as_ref()],
        bump
    )]
    pub root_ring_metadata: AccountLoader<'info, RootRingMetadata>,

    #[account(
        init,
        payer = authority,
        space = 8 + RootRingShard::LEN,
        seeds = [b"root_ring_shard", pool_state.key().as_ref(), &shard_index.to_le_bytes()],
        bump
    )]
    pub shard: AccountLoader<'info, RootRingShard>,

    /// CHECK: Pool state account (for seed derivation)
    pub pool_state: AccountInfo<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn init_shard(ctx: Context<InitShard>, shard_index: u32) -> Result<()> {
    let metadata = &mut ctx.accounts.root_ring_metadata.load_mut()?;

    // Validate shard index
    require!(
        shard_index < metadata.num_shards,
        crate::ZerokError::InvalidRootIndex
    );

    // Check that shard hasn't been allocated yet
    require!(
        metadata.shard_pdas[shard_index as usize] == Pubkey::default(),
        crate::ZerokError::AlreadyInitialized
    );

    // Initialize shard data
    let shard = &mut ctx.accounts.shard.load_init()?;
    shard.version = 1;
    shard.shard_index = shard_index;
    shard.local_head = 0;

    // Update metadata with new shard PDA address
    metadata.shard_pdas[shard_index as usize] = ctx.accounts.shard.key();

    msg!(
        "Shard {} initialized: PDA={}, version={}",
        shard_index,
        ctx.accounts.shard.key(),
        shard.version
    );

    Ok(())
}

/// Advance to next shard when current is full (wrap-around)
///
/// Called by deposit orchestrator when shard fills up (local_head >= shard_capacity).
/// This instruction updates the active_shard_index in metadata using modulo arithmetic
/// to implement wrap-around: (active_shard_index + 1) % num_shards
///
/// After calling this, the next deposit will write to the new active shard.
#[derive(Accounts)]
pub struct AdvanceActiveShard<'info> {
    #[account(
        mut,
        seeds = [b"root_ring_metadata", pool_state.key().as_ref()],
        bump
    )]
    pub root_ring_metadata: AccountLoader<'info, RootRingMetadata>,

    /// The current active shard (to verify it's full)
    /// CHECK: PDA validated in handler
    pub current_shard: AccountInfo<'info>,

    /// CHECK: Pool state account (for seed derivation)
    pub pool_state: AccountInfo<'info>,

    /// Authority - anyone can call this (permissionless, validated by shard state)
    #[account(mut)]
    pub authority: Signer<'info>,
}

pub fn advance_active_shard(ctx: Context<AdvanceActiveShard>) -> Result<()> {
    let metadata = &mut ctx.accounts.root_ring_metadata.load_mut()?;

    // Validate current_shard PDA matches the active shard
    let shard_index_bytes = metadata.active_shard_index.to_le_bytes();
    let (expected_shard_pda, _) = Pubkey::find_program_address(
        &[b"root_ring_shard", ctx.accounts.pool_state.key().as_ref(), &shard_index_bytes],
        ctx.program_id
    );
    require_keys_eq!(
        ctx.accounts.current_shard.key(),
        expected_shard_pda,
        crate::ZerokError::InvalidOwner
    );

    // Load current shard to verify it's actually full
    let shard_data = ctx.accounts.current_shard.try_borrow_data()?;
    let shard_discriminator = <RootRingShard as anchor_lang::Discriminator>::DISCRIMINATOR;
    require!(
        shard_data.len() >= 8 + RootRingShard::LEN &&
        &shard_data[0..8] == shard_discriminator,
        crate::ZerokError::InvalidOwner
    );

    let shard: &RootRingShard =
        bytemuck::from_bytes(&shard_data[8..8 + RootRingShard::LEN]);

    // Only advance if shard is actually full
    require!(
        shard.local_head >= metadata.shard_capacity,
        crate::ZerokError::ShardNotFull
    );

    // Advance to next shard with wrap-around
    let old_index = metadata.active_shard_index;
    metadata.active_shard_index = (metadata.active_shard_index + 1) % metadata.num_shards;
    let new_index = metadata.active_shard_index;

    msg!("✓ Advanced active shard: {} -> {} (wrap-around at {})",
        old_index, new_index, metadata.num_shards);

    Ok(())
}
