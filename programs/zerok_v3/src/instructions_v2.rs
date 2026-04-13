/// Zerok v2 Instructions - STUB ONLY
/// Real implementation in instructions_v2_clean.rs

use anchor_lang::prelude::*;
use crate::state_v2::ZerokStateV2;
use crate::ZerokError;

/// Initialize v2 pool with BE configuration - DEPRECATED
pub fn initialize_v2(
    _ctx: Context<InitializeV2>,
    _denomination: u64,
    _max_fee_bps: u16,
    _daily_limit: u64,
) -> Result<()> {
    Err(ZerokError::Deprecated.into())
}

/// Deposit to v2 pool - DEPRECATED
pub fn deposit_v2(_ctx: Context<DepositV2>, _commitment_be: [u8; 32]) -> Result<()> {
    Err(ZerokError::Deprecated.into())
}

/// Withdraw from v2 pool - DEPRECATED
pub fn withdraw_v2(
    _ctx: Context<WithdrawV2>,
    _proof: Vec<u8>,
    _root_be: [u8; 32],
    _nullifier_hash_be: [u8; 32],
    _recipient: Pubkey,
    _relayer: Option<Pubkey>,
    _fee: u64,
    _refund: u64,
) -> Result<()> {
    Err(ZerokError::Deprecated.into())
}

/// Account contexts - kept for Anchor IDL generation

#[derive(Accounts)]
pub struct InitializeV2<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ZerokStateV2::SPACE,
        seeds = [b"zerok_v2"],
        bump
    )]
    pub pool_state: Account<'info, ZerokStateV2>,

    #[account(
        init,
        payer = authority,
        space = 0,
        seeds = [b"vault_v2", pool_state.key().as_ref()],
        bump,
    )]
    /// CHECK: Vault is a PDA holding SOL
    pub vault: AccountInfo<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositV2<'info> {
    #[account(
        mut,
        seeds = [b"zerok_v2"],
        bump
    )]
    pub pool_state: Account<'info, ZerokStateV2>,

    #[account(
        mut,
        seeds = [b"vault_v2", pool_state.key().as_ref()],
        bump,
    )]
    /// CHECK: Vault is a PDA holding SOL
    pub vault: AccountInfo<'info>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(proof: Vec<u8>, root_be: [u8; 32], nullifier_hash_be: [u8; 32])]
pub struct WithdrawV2<'info> {
    #[account(
        mut,
        seeds = [b"zerok_v2"],
        bump
    )]
    pub pool_state: Account<'info, ZerokStateV2>,

    #[account(
        mut,
        seeds = [b"vault_v2", pool_state.key().as_ref()],
        bump
    )]
    /// CHECK: Vault is a PDA
    pub vault: AccountInfo<'info>,

    /// CHECK: Nullifier PDA
    #[account(
        init,
        payer = payer,
        space = 8,
        seeds = [b"nullifier_v2", nullifier_hash_be.as_ref()],
        bump,
    )]
    pub nullifier: AccountInfo<'info>,

    /// CHECK: Recipient of withdrawal
    pub recipient: AccountInfo<'info>,

    /// CHECK: Optional relayer
    pub relayer: Option<AccountInfo<'info>>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}