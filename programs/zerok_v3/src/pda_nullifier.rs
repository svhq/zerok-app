use anchor_lang::prelude::*;
use anchor_lang::system_program;

/// PDA-based nullifier record for O(1) lookups
/// This replaces the Vec<[u8; 32]> storage pattern
#[account]
pub struct NullifierRecord {
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

impl NullifierRecord {
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 32 + 8; // discriminator + fields
    
    pub const SEED_PREFIX: &'static [u8] = b"nullifier";
    
    /// Derive the PDA address for a nullifier
    pub fn derive_pda(nullifier_hash: &[u8; 32], program_id: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[Self::SEED_PREFIX, nullifier_hash.as_ref()],
            program_id,
        )
    }
}

/// PDA-based commitment record
#[account]
pub struct CommitmentRecord {
    /// The commitment hash
    pub commitment: [u8; 32],
    
    /// Unix timestamp when deposited
    pub deposited_at: i64,
    
    /// Solana slot number when deposited
    pub deposited_slot: u64,
    
    /// Leaf index in the merkle tree
    pub leaf_index: u32,
    
    /// The depositor's address
    pub depositor: Pubkey,
}

impl CommitmentRecord {
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 4 + 32; // discriminator + fields
    
    pub const SEED_PREFIX: &'static [u8] = b"commitment";
    
    /// Derive the PDA address for a commitment
    pub fn derive_pda(commitment: &[u8; 32], program_id: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[Self::SEED_PREFIX, commitment.as_ref()],
            program_id,
        )
    }
}

/// Account context for withdrawal with PDA nullifier check
#[derive(Accounts)]
#[instruction(nullifier_hash: [u8; 32])]
pub struct WithdrawWithPDA<'info> {
    #[account(mut)]
    pub pool_state: Account<'info, crate::ZerokState>,
    
    /// The nullifier record PDA
    /// If this already exists, the withdrawal will fail (prevents double-spend)
    #[account(
        init,
        payer = payer,
        space = NullifierRecord::SIZE,
        seeds = [NullifierRecord::SEED_PREFIX, nullifier_hash.as_ref()],
        bump
    )]
    pub nullifier_record: Account<'info, NullifierRecord>,
    
    /// The vault PDA holding the funds
    #[account(
        mut,
        seeds = [b"vault", pool_state.key().as_ref()],
        bump,
    )]
    pub vault: SystemAccount<'info>,
    
    /// The recipient of the withdrawal
    /// CHECK: Can be any account, validated in instruction
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    
    /// Optional relayer account
    /// CHECK: Validated in instruction if present
    #[account(mut)]
    pub relayer: Option<UncheckedAccount<'info>>,
    
    /// The account paying for the nullifier PDA creation
    #[account(mut)]
    pub payer: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

/// Account context for deposit with PDA commitment record
#[derive(Accounts)]
#[instruction(commitment: [u8; 32])]
pub struct DepositWithPDA<'info> {
    #[account(mut)]
    pub pool_state: Account<'info, crate::ZerokState>,
    
    /// The commitment record PDA
    /// Creating this prevents duplicate deposits
    #[account(
        init,
        payer = depositor,
        space = CommitmentRecord::SIZE,
        seeds = [CommitmentRecord::SEED_PREFIX, commitment.as_ref()],
        bump
    )]
    pub commitment_record: Account<'info, CommitmentRecord>,
    
    /// The vault PDA to receive funds
    #[account(
        mut,
        seeds = [b"vault", pool_state.key().as_ref()],
        bump,
    )]
    pub vault: SystemAccount<'info>,
    
    /// The account making the deposit
    #[account(mut)]
    pub depositor: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

/// Migration context for moving nullifiers from Vec to PDA
#[derive(Accounts)]
pub struct MigrateNullifiers<'info> {
    #[account(mut)]
    pub pool_state: Account<'info, crate::ZerokState>,
    
    /// Authority that can trigger migration (should be DAO/multisig)
    pub authority: Signer<'info>,
    
    /// Account paying for PDA creation during migration
    #[account(mut)]
    pub payer: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

/// Check if a nullifier has been spent (O(1) operation)
pub fn is_nullifier_spent(nullifier_hash: &[u8; 32], program_id: &Pubkey) -> bool {
    let (pda_address, _) = NullifierRecord::derive_pda(nullifier_hash, program_id);
    // In actual implementation, would check if account exists at this address
    // This is a placeholder - real check happens via account loading
    false
}

/// Check if a commitment exists (O(1) operation)
pub fn commitment_exists(commitment: &[u8; 32], program_id: &Pubkey) -> bool {
    let (pda_address, _) = CommitmentRecord::derive_pda(commitment, program_id);
    // In actual implementation, would check if account exists at this address
    // This is a placeholder - real check happens via account loading
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_nullifier_pda_derivation() {
        let program_id = Pubkey::new_unique();
        let nullifier_hash = [1u8; 32];
        
        let (pda1, bump1) = NullifierRecord::derive_pda(&nullifier_hash, &program_id);
        let (pda2, bump2) = NullifierRecord::derive_pda(&nullifier_hash, &program_id);
        
        // PDAs should be deterministic
        assert_eq!(pda1, pda2);
        assert_eq!(bump1, bump2);
    }
    
    #[test]
    fn test_different_nullifiers_different_pdas() {
        let program_id = Pubkey::new_unique();
        let nullifier1 = [1u8; 32];
        let nullifier2 = [2u8; 32];
        
        let (pda1, _) = NullifierRecord::derive_pda(&nullifier1, &program_id);
        let (pda2, _) = NullifierRecord::derive_pda(&nullifier2, &program_id);
        
        // Different nullifiers should produce different PDAs
        assert_ne!(pda1, pda2);
    }
    
    #[test]
    fn test_commitment_pda_derivation() {
        let program_id = Pubkey::new_unique();
        let commitment = [42u8; 32];
        
        let (pda1, bump1) = CommitmentRecord::derive_pda(&commitment, &program_id);
        let (pda2, bump2) = CommitmentRecord::derive_pda(&commitment, &program_id);
        
        assert_eq!(pda1, pda2);
        assert_eq!(bump1, bump2);
    }
}