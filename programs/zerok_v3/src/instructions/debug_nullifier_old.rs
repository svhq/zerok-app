use anchor_lang::prelude::*;

/// Debug instruction to reveal exact nullifier PDA derivation
/// This is feature-gated and authority-only for safety
#[derive(Accounts)]
pub struct DebugNullifier<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The pool state account
    pub pool_state: Account<'info, crate::ZerokState>,
}

/// Debug function to print exactly what seeds the program expects
/// This helps us understand the PDA mismatch issue
pub fn debug_expected_nullifier(
    ctx: Context<DebugNullifier>,
    nullifier_hash: [u8; 32],
) -> Result<()> {
    // Only allow authority to debug
    require_keys_eq!(
        ctx.accounts.authority.key(),
        ctx.accounts.pool_state.authority,
        crate::ZerokError::Unauthorized
    );

    msg!("=== Debug Nullifier PDA ===");
    msg!("Nullifier hash (hex): {:?}",
        nullifier_hash.iter().map(|b| format!("{:02x}", b)).collect::<String>());

    // Test Recipe 1: Basic ["nullifier", hash]
    let (pda1, bump1) = Pubkey::find_program_address(
        &[b"nullifier", &nullifier_hash],
        &crate::ID
    );
    msg!("Recipe 1: [\"nullifier\", hash]");
    msg!("  PDA: {}", pda1);
    msg!("  Bump: {}", bump1);

    // Test Recipe 2: With state ["nullifier", state, hash]
    let (pda2, bump2) = Pubkey::find_program_address(
        &[b"nullifier", ctx.accounts.pool_state.key().as_ref(), &nullifier_hash],
        &crate::ID
    );
    msg!("Recipe 2: [\"nullifier\", state, hash]");
    msg!("  State: {}", ctx.accounts.pool_state.key());
    msg!("  PDA: {}", pda2);
    msg!("  Bump: {}", bump2);

    // Test Recipe 3: With seed prefix ["zerok_v1", "nullifier", hash]
    let (pda3, bump3) = Pubkey::find_program_address(
        &[b"zerok_v1", b"nullifier", &nullifier_hash],
        &crate::ID
    );
    msg!("Recipe 3: [\"zerok_v1\", \"nullifier\", hash]");
    msg!("  PDA: {}", pda3);
    msg!("  Bump: {}", bump3);

    // Test Recipe 4: Different order ["nullifier", hash, state]
    let (pda4, bump4) = Pubkey::find_program_address(
        &[b"nullifier", &nullifier_hash, ctx.accounts.pool_state.key().as_ref()],
        &crate::ID
    );
    msg!("Recipe 4: [\"nullifier\", hash, state]");
    msg!("  PDA: {}", pda4);
    msg!("  Bump: {}", bump4);

    // Show what the actual withdraw instruction expects
    msg!("=== What Withdraw Expects ===");

    // This is what's in the withdraw instruction constraint
    // From lib.rs line 798: seeds = [b"nullifier", nullifier_hash.as_ref()]
    let expected_seeds = &[b"nullifier".as_ref(), nullifier_hash.as_ref()];
    msg!("Withdraw constraint seeds: [\"nullifier\", nullifier_hash]");

    let (expected_pda, expected_bump) = Pubkey::find_program_address(
        expected_seeds,
        &crate::ID
    );

    msg!("Expected PDA from withdraw: {}", expected_pda);
    msg!("Expected bump: {}", expected_bump);

    // Also test with different endianness (reverse bytes)
    let mut nullifier_hash_le = nullifier_hash;
    nullifier_hash_le.reverse();

    let (pda_le, bump_le) = Pubkey::find_program_address(
        &[b"nullifier", &nullifier_hash_le],
        &crate::ID
    );
    msg!("With LE encoding: {}", pda_le);

    msg!("=== Debug Complete ===");

    Ok(())
}