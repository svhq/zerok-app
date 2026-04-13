use anchor_lang::prelude::*;
use crate::state_root_ring::RootRing;

#[derive(Accounts)]
pub struct InitRootRing<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + RootRing::LEN,
        seeds = [b"roots", pool_state.key().as_ref()],
        bump
    )]
    pub root_ring: AccountLoader<'info, RootRing>,

    /// CHECK: Pool state account (for seed derivation)
    pub pool_state: AccountInfo<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn init_root_ring(ctx: Context<InitRootRing>) -> Result<()> {
    let root_ring = &mut ctx.accounts.root_ring.load_init()?;

    root_ring.version = 1;
    root_ring.capacity = 128;
    root_ring.head = 0;

    msg!("RootRing initialized: capacity={}, version={}", root_ring.capacity, root_ring.version);
    Ok(())
}
