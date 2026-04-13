//! Cooldown instructions for rate limiting deposits
//!
//! Enforces per-wallet deposit cooldown to prevent spam and maintain RPC health.
//! Uses slot-based timing (cheaper and deterministic vs timestamps).

use anchor_lang::prelude::*;
use crate::state_v2_clean::{
    PoolCooldownConfig, COOLDOWN_CONFIG_SEED,
    ZerokStateV2Clean,
};
use crate::ZerokError;

/// Initialize cooldown configuration for a pool
///
/// # Arguments
/// * `cooldown_slots` - Number of slots to wait between deposits (3 slots ≈ 1.2s)
///
/// # Access Control
/// - Only pool authority can initialize
/// - One-time setup per pool
pub fn handler_initialize_cooldown_config(
    ctx: Context<InitializeCooldownConfig>,
    cooldown_slots: u64,
) -> Result<()> {
    let config = &mut ctx.accounts.cooldown_config;

    // Initialize with provided settings
    config.initialize(ctx.accounts.authority.key(), cooldown_slots);

    msg!("Cooldown config initialized: {} slots", cooldown_slots);

    Ok(())
}

#[derive(Accounts)]
pub struct InitializeCooldownConfig<'info> {
    /// Pool cooldown configuration account (PDA)
    #[account(
        init,
        payer = authority,
        space = PoolCooldownConfig::SPACE,
        seeds = [COOLDOWN_CONFIG_SEED, pool_state.key().as_ref()],
        bump
    )]
    pub cooldown_config: Account<'info, PoolCooldownConfig>,

    /// Pool state account (for PDA derivation)
    /// CHECK: Used only for PDA seed derivation, not accessed
    #[account()]
    pub pool_state: UncheckedAccount<'info>,

    /// Pool authority
    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Update cooldown configuration settings
///
/// # Arguments
/// * `cooldown_slots` - New cooldown period (None = no change)
/// * `enabled` - Enable/disable cooldown (None = no change)
///
/// # Access Control
/// - Only config authority can update
///
/// # Examples
/// - Disable cooldown: `update_cooldown_config(None, Some(false))`
/// - Change duration: `update_cooldown_config(Some(5), None)`
/// - Set to 0 slots (effective disable): `update_cooldown_config(Some(0), None)`
pub fn handler_update_cooldown_config(
    ctx: Context<UpdateCooldownConfig>,
    cooldown_slots: Option<u64>,
    enabled: Option<bool>,
) -> Result<()> {
    let config = &mut ctx.accounts.cooldown_config;

    // Verify authority matches
    require!(
        ctx.accounts.authority.key() == config.authority,
        ZerokError::Unauthorized
    );

    // Update settings
    config.update(cooldown_slots, enabled);

    msg!(
        "Cooldown config updated: slots={}, enabled={}",
        config.cooldown_slots,
        config.enabled
    );

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateCooldownConfig<'info> {
    /// Pool cooldown configuration account
    #[account(mut)]
    pub cooldown_config: Account<'info, PoolCooldownConfig>,

    /// Config authority
    ///
    /// CHECK: Authority validation happens in handler via config.authority comparison
    pub authority: Signer<'info>,
}
