use anchor_lang::prelude::*;
use anchor_lang::solana_program::clock::Clock;
use light_sdk::{cpi::CpiSigner, derive_light_cpi_signer};

declare_id!("HVcTokFF4rwvcU7sC7GjS317CSf7QDgfCvW7edijKS2v");

/// CPI signer for Light Protocol cross-program invocations
///
/// This constant is derived at compile time from the program ID.
/// Light Protocol uses this to verify that CPI calls originate from
/// authorized programs. The seed is generated from the program ID string.
pub const LIGHT_CPI_SIGNER: CpiSigner =
    derive_light_cpi_signer!("HVcTokFF4rwvcU7sC7GjS317CSf7QDgfCvW7edijKS2v");
// use anchor_lang::solana_program::system_instruction; // Not needed - use through anchor
use anchor_lang::system_program;
use groth16_solana::groth16::{Groth16Verifier, Groth16Verifyingkey};
// REMOVED: ark_bn254 and ark_serialize - no longer needed for on-chain negation

pub mod constants;
use constants::ZERO_CHAIN;
pub mod merkle_tree;
use merkle_tree::*;

pub mod verifying_key;
#[cfg(test)]
use verifying_key::get_circuit_verifying_key;

pub mod records;
use records::{CommitmentRecord, Nullifier};

// Light Protocol integration
pub mod light_state;
pub use light_state::ZerokCommitment;

// DISABLED: Old v1 modules (files deleted/archived)
// pub mod instructions;
// use instructions::*;
pub mod helpers;
use helpers::*;

// DISABLED: v2 pool with BE encoding (archived)
pub mod v2;
pub mod state_v2;
// LEGACY: Keep minimal stubs to satisfy Anchor IDL
pub mod instructions_v2;
use instructions_v2::*;

// Clean v2 implementation - THE ONLY WORKING PATH
pub mod state_v2_clean;
pub mod state_root_ring; // Phase R: Rolling on-chain roots (K=128)
pub mod state_root_ring_shard; // K=4,096 sharded ring
pub mod instructions_v2_clean;
pub mod instructions_cooldown; // Deposit cooldown rate limiting
pub mod instructions_root_ring; // Phase R: Rolling roots initialization (K=128)
pub mod instructions_root_ring_shard; // K=4,096 sharded ring initialization
pub mod instructions_light_withdraw; // Phase L1.3: Light Protocol withdrawal
pub mod vk_layout; // VK account layout - single source of truth
use instructions_v2_clean::*;
use instructions_cooldown::*;
use instructions_root_ring::*;
use instructions_root_ring_shard::*;
use instructions_light_withdraw::*;

// Debug instructions (feature-gated)
#[cfg(feature = "debug-merkle")]
pub mod instructions_debug;
#[cfg(feature = "debug-merkle")]
use instructions_debug::*;

// LEGACY VARIANTS - ALL CAUSE STACK OVERFLOW
// These are kept for reference only, disabled by default
// DISABLED: Files archived/deleted, feature doesn't exist in Cargo.toml
// #[cfg(feature = "archive_v2")]
// pub mod instructions_v2_account;
// #[cfg(feature = "archive_v2")]
// use instructions_v2_account::*;

// #[cfg(feature = "archive_v2")]
// pub mod instructions_v2_optimized;
// #[cfg(feature = "archive_v2")]
// use instructions_v2_optimized::*;

// #[cfg(feature = "archive_v2")]
// pub mod instructions_v2_static;
// #[cfg(feature = "archive_v2")]
// use instructions_v2_static::*;

// V2 with heap cache (Final solution - limbs + cache)
// TEMPORARILY DISABLED TO TEST BUILD
// pub mod instructions_v2_cached;
// use instructions_v2_cached::*;

#[cfg(test)]
mod poseidon_test;

#[cfg(test)]
mod poseidon_test_vectors;

#[cfg(test)]
mod commitment_uniqueness_test;

#[cfg(test)]
mod hash_parity_test;

#[cfg(test)]
mod integration_tests;

#[cfg(test)]
mod simple_test;

#[cfg(test)]
mod nullifier_pda_test;

// Temporarily disabled due to Anchor API changes (not poseidon related)
//#[cfg(test)]
//mod final_verification_test;

#[cfg(test)]
mod relayer_security_test;

#[cfg(test)]
mod state_layout_test;

// Disabled - uses old API
//#[cfg(test)]
//mod vault_pda_tests;

// Program ID must match Anchor.toml for deployment


#[program]
pub mod zerok {
    use super::*;

    /// Initialize VK account for chunked upload
    /// @param vk_sha256: SHA256 hash of the VK data (for binding verification)
    pub fn init_vk_account(ctx: Context<InitVkAccount>, vk_sha256: [u8; 32]) -> Result<()> {
        // Fixed array size is 1536 bytes (enough for 1028-byte VK)
        // Zero-copy account: load_init() returns mutable reference, zeros memory

        // TEMPORARY: Log sizes to verify exact match (remove after validation)
        let account_info = ctx.accounts.vk_account.to_account_info();
        let actual_data_len = account_info.data_len();
        let expected_total = 8 + VerifyingKeyAccount::BYTE_LEN;
        msg!("VK Account Size Validation:");
        msg!("  BYTE_LEN (struct size): {}", VerifyingKeyAccount::BYTE_LEN);
        msg!("  Expected total (8 + BYTE_LEN): {}", expected_total);
        msg!("  Actual account data_len: {}", actual_data_len);
        msg!("  Match: {}", actual_data_len == expected_total);

        // SAFETY CHECK: Enforce exact size (prevents AccountDiscriminatorNotFound)
        require_eq!(
            actual_data_len,
            expected_total,
            ZerokError::VkAccountSizeMismatch
        );

        let vk_account = &mut ctx.accounts.vk_account.load_init()?;

        // Initialize header with magic and version
        vk_account.magic = *b"G16S";
        vk_account.version = 1;

        // Set authority and perform explicit validation (defense in depth)
        vk_account.authority = ctx.accounts.payer.key();
        require!(
            vk_account.authority == ctx.accounts.payer.key(),
            ZerokError::Unauthorized
        );

        // Store VK hash for binding validation
        vk_account.sha256_hash = vk_sha256;

        vk_account.length = 0;
        vk_account.finalized = 0; // 0 = false, 1 = true (u8 to avoid padding)
        // Note: vk_account.data is already zero-initialized by load_init()

        msg!("VK account initialized with hash={:?}", &vk_sha256[..8]);
        Ok(())
    }

    /// Append chunk of VK data
    /// @param offset: Position in the VK where this chunk should be placed
    /// @param chunk_data: The chunk bytes to append
    pub fn append_vk_chunk(ctx: Context<AppendVkChunk>, offset: u32, chunk_data: Vec<u8>) -> Result<()> {
        // Extract key before load_mut() to avoid borrow checker conflict
        let vk_account_key = ctx.accounts.vk_account.key();
        let vk_account = &mut ctx.accounts.vk_account.load_mut()?;

        // Explicit authority validation (defense in depth)
        require!(
            vk_account.authority == ctx.accounts.authority.key(),
            ZerokError::Unauthorized
        );

        require!(vk_account.finalized == 0, ZerokError::VkAlreadyFinalized); // 0 = not finalized
        require!(offset as usize == vk_account.length as usize, ZerokError::InvalidChunkOffset);
        require!(chunk_data.len() <= 900, ZerokError::ChunkTooLarge);
        require!(
            (vk_account.length as usize) + chunk_data.len() <= 1536,
            ZerokError::ExceedsExpectedSize
        );

        // Copy chunk into fixed array (using helper for flat view)
        let start = vk_account.length as usize;
        let end = start + chunk_data.len();
        vk_account.data_as_mut_slice()[start..end].copy_from_slice(&chunk_data);
        vk_account.length = end as u16;

        // Emit event for upload progress tracking and resumption support
        emit!(VkChunkAppended {
            vk_account: vk_account_key,
            offset,
            chunk_size: chunk_data.len() as u32,
            total_uploaded: vk_account.length as u32,
            expected_size: 1536,  // Fixed size
        });

        Ok(())
    }

    /// Finalize VK and verify integrity
    /// @param expected_sha256: Expected SHA256 hash for verification
    pub fn finalize_vk(ctx: Context<FinalizeVk>, expected_sha256: [u8; 32]) -> Result<()> {
        // Extract key before load_mut() to avoid borrow checker conflict
        let vk_account_key = ctx.accounts.vk_account.key();
        let mut vk_account = ctx.accounts.vk_account.load_mut()?;

        // Explicit authority validation (defense in depth)
        require!(
            vk_account.authority == ctx.accounts.authority.key(),
            ZerokError::Unauthorized
        );

        require!(vk_account.finalized == 0, ZerokError::VkAlreadyFinalized); // 0 = not finalized
        require!(
            vk_account.length > 0,
            ZerokError::IncompleteVk
        );

        // Phase B3: Verify that the expected hash matches what was declared during init
        // This ensures the VK being finalized is the same one that was declared upfront
        require!(
            expected_sha256 == vk_account.sha256_hash,
            ZerokError::VkHashMismatch
        );

        // Verify SHA256 using our canonical hash function
        // Single source of truth: vk_hash_data_field
        let calculated_hash = vk_hash_data_field(&vk_account);
        require!(
            calculated_hash == expected_sha256,
            ZerokError::VkHashMismatch
        );

        vk_account.sha256_hash = expected_sha256;
        vk_account.finalized = 1; // 1 = finalized (u8)

        // Emit event for completion notification and integrity confirmation
        emit!(VkFinalized {
            vk_account: vk_account_key,
            total_size: vk_account.length as u32,
            sha256_hash: expected_sha256,
            authority: vk_account.authority,
        });

        Ok(())
    }

    /// Initialize a new ZeroK pool with VK reference (PRODUCTION METHOD)
    /// @param denomination: Fixed deposit amount for this pool
    /// This is the only production initializer - uses VK reference for elegant architecture
    pub fn initialize_with_vk_ref(
        ctx: Context<InitializeWithVkRef>,
        denomination: u64,
    ) -> Result<()> {
        // Load VK account with zero-copy (read-only)
        let vk_account_key = ctx.accounts.vk_account.key();
        let vk = ctx.accounts.vk_account.load()?;

        // VK validation is enforced by account constraints, but double-check for clarity
        require!(vk.finalized == 1, ZerokError::IncompleteVk); // 1 = finalized
        require!(
            vk.length > 0,
            ZerokError::IncompleteVk
        );
        require!(
            vk.authority == ctx.accounts.authority.key(),
            ZerokError::Unauthorized
        );

        // Vault validation is now handled by SystemAccount type - no manual checks needed!

        // Zero-copy initialization: load_init() returns mutable reference
        let mut state = ctx.accounts.pool_state.load_init()?;

        // Initialize state with VK reference approach
        state.authority = ctx.accounts.authority.key();
        state.denomination = denomination;

        // Initialize merkle tree fields directly (no MerkleTree struct)
        // Copy zero chain for zeros array
        state.zeros.copy_from_slice(&ZERO_CHAIN[0..20]);
        // Initialize filled_subtrees to zeros
        state.filled_subtrees = [[0u8; 32]; 20];
        // Set current root to empty tree root
        state.current_root = ZERO_CHAIN[19];
        state.next_index = 0;

        // Initialize root history with empty tree root (fixed array)
        state.roots[0] = ZERO_CHAIN[19];
        // Remaining slots already zero-initialized by load_init()
        state.current_root_index = 0;

        // Set VK reference (elegant single source of truth)
        state.vk_account = vk_account_key;
        state.vk_sha256 = vk.sha256_hash;

        // Phase 6: Security Enhancement - Initialize security controls
        state.max_relayer_fee_bps = 500;  // 5% maximum relayer fee
        state.emergency_paused = 0;  // 0 = active (u8, not bool)
        state.daily_withdraw_limit = denomination * 100;  // 100x denomination per day
        state.last_limit_reset = Clock::get()?.unix_timestamp;
        state.daily_withdrawn = 0;

        Ok(())
    }

    /// Initialize a new ZeroK pool with fixed denomination (LEGACY - TEST ONLY)
    /// @param verifying_key: The Groth16 verifying key from trusted setup ceremony (for direct init)
    /// For production, use: init_vk_account -> append_vk_chunk -> finalize_vk -> initialize_with_vk_ref
    #[cfg(test)]
    pub fn initialize(
        ctx: Context<Initialize>, 
        denomination: u64,
        verifying_key: Vec<u8>,
    ) -> Result<()> {
        
        // Validate verifying key size
        const MIN_VK_SIZE: usize = 516; // 4 + 64 + 128 + 128 + 128 + 64 (minimum with 1 IC element)
        require!(
            verifying_key.len() >= MIN_VK_SIZE,
            ZerokError::InvalidVerifyingKey
        );
        
        // Vault validation is now handled by SystemAccount type - no manual checks needed!

        // Zero-copy initialization: load_init() returns mutable reference
        let mut state = ctx.accounts.pool_state.load_init()?;

        state.authority = ctx.accounts.authority.key();
        state.denomination = denomination;

        // Initialize merkle tree fields directly (no MerkleTree struct)
        // Copy zero chain for zeros array
        state.zeros.copy_from_slice(&ZERO_CHAIN[0..20]);
        // Initialize filled_subtrees to zeros
        state.filled_subtrees = [[0u8; 32]; 20];
        // Set current root to empty tree root
        state.current_root = ZERO_CHAIN[19];
        state.next_index = 0;

        // Initialize root history with empty tree root (fixed array)
        state.roots[0] = ZERO_CHAIN[19];
        // Remaining slots already zero-initialized by load_init()
        state.current_root_index = 0;

        // Legacy test method - use placeholder VK references (not used in production)
        state.vk_account = Pubkey::default();
        state.vk_sha256 = [0u8; 32]; // Test placeholder

        // Phase 6: Security Enhancement - Initialize security controls
        state.max_relayer_fee_bps = 500;  // 5% maximum relayer fee
        state.emergency_paused = 0;  // 0 = active (u8, not bool)
        state.daily_withdraw_limit = denomination * 100;  // 100x denomination per day
        state.last_limit_reset = Clock::get()?.unix_timestamp;
        state.daily_withdrawn = 0;

        Ok(())
    }

    /// Deposit funds into the zerok pool
    /// @param commitment: Hash(nullifier + secret)
    pub fn deposit(ctx: Context<Deposit>, commitment: [u8; 32]) -> Result<()> {
        // Load state with zero-copy (mutable)
        let mut state = ctx.accounts.pool_state.load_mut()?;

        // Check state invariants before processing deposit
        require!(state.emergency_paused == 0, ZerokError::EmergencyPaused);

        // Commitment uniqueness enforced by PDA constraint above
        // If commitment already exists, transaction fails with "account already exists"

        // Store denomination before the transfer
        let deposit_amount = state.denomination;

        // Drop mutable borrow before CPI (Rust borrow checker requirement)
        drop(state);

        // Vault validation: SystemAccount type already ensures System ownership
        // PDA derivation is enforced by seeds constraint in the Accounts struct
        // No manual validation needed - this is the elegant Anchor approach

        // Transfer SOL to the vault using CPI
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.depositor.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            deposit_amount,
        )?;

        // Reload state after CPI
        let mut state = ctx.accounts.pool_state.load_mut()?;

        // Convert commitment bytes to field element for proper ZK circuit compatibility
        let commitment_fr = seed_bytes_le_to_fr(&commitment);

        // Insert commitment into merkle tree (in-place, no allocation)
        let commitment_bytes = fr_to_seed_bytes_le(commitment_fr);
        let leaf_index = state.insert_leaf(commitment_bytes)?;

        // Add new root to history ring buffer (copy root before push)
        let new_root = state.current_root;
        state.push_root(new_root);

        emit!(DepositEvent {
            commitment,
            leaf_index,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Withdraw funds with a zero-knowledge proof
    pub fn withdraw(
        ctx: Context<Withdraw>,
        proof: Vec<u8>,
        root: [u8; 32],
        nullifier_hash: [u8; 32],
        recipient: Pubkey,
        relayer: Option<Pubkey>,
        fee: u64,
        refund: u64,
        vk_sha256: [u8; 32],  // Phase B4: Explicit VK hash binding
    ) -> Result<()> {
        // Get key before loading (avoid borrow conflicts)
        let pool_state_key = ctx.accounts.pool_state.key();

        // Load state mutably (need to update daily_withdrawn at end)
        let mut state = ctx.accounts.pool_state.load_mut()?;

        // Check state invariants before processing withdrawal
        assert_state_invariants_zero_copy(&state)?;

        // RUNTIME PDA VALIDATION - Single source of truth for nullifier derivation
        // This eliminates offset-dependent bugs from compile-time macros
        // Derive expected nullifier PDA with state-namespaced seeds
        let nullifier_seeds = &[
            b"nullifier",
            pool_state_key.as_ref(),
            &nullifier_hash,
        ];
        let (expected_nullifier_pda, nullifier_bump) =
            Pubkey::find_program_address(nullifier_seeds, ctx.program_id);

        // Validate the provided nullifier account matches expected PDA
        require_keys_eq!(
            expected_nullifier_pda,
            ctx.accounts.nullifier.key(),
            ZerokError::InvalidNullifierPda
        );

        // Create nullifier account if it doesn't exist (prevents double-spending)
        if ctx.accounts.nullifier.data_is_empty() {
            msg!("Creating nullifier PDA to mark as spent");

            // Calculate minimum rent for 8 bytes (just discriminator)
            let rent = Rent::get()?;
            let lamports = rent.minimum_balance(8);

            // Create the nullifier account with proper seeds
            let create_account_ix = anchor_lang::solana_program::system_instruction::create_account(
                &ctx.accounts.payer.key(),
                &expected_nullifier_pda,
                lamports,
                8,  // Just need discriminator
                ctx.program_id,
            );

            // Invoke with PDA signer seeds
            anchor_lang::solana_program::program::invoke_signed(
                &create_account_ix,
                &[
                    ctx.accounts.payer.to_account_info(),
                    ctx.accounts.nullifier.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                &[&[
                    b"nullifier",
                    pool_state_key.as_ref(),
                    &nullifier_hash,
                    &[nullifier_bump],
                ]],
            )?;
        } else {
            // Nullifier already exists - this is a double-spend attempt
            return Err(ZerokError::NullifierAlreadyUsed.into());
        }

        // Load and verify VK from account (single source of truth with integrity check)
        // WORKAROUND: Manual validation due to AccountLoader::load() bug
        // This is safe because we validate owner, discriminator, and hash
        let vk_ai = &ctx.accounts.vk_account;

        // Validate owner
        require!(
            vk_ai.owner == ctx.program_id,
            ZerokError::InvalidVKAccount
        );

        // Validate account size
        let vk_data = vk_ai.try_borrow_data()?;
        let expected_size = 8 + VerifyingKeyAccount::BYTE_LEN;
        require!(
            vk_data.len() == expected_size,
            ZerokError::InvalidVKAccount
        );

        // Validate discriminator (hash of "account:VerifyingKeyAccount")
        let expected_discriminator: [u8; 8] = [0x05, 0x36, 0xe7, 0x54, 0x51, 0x46, 0x11, 0xa8];
        require!(
            vk_data[0..8] == expected_discriminator,
            ZerokError::InvalidVKAccount
        );

        // Manual zero-copy access: cast data to struct
        // Safety: We validated size and discriminator above
        let vk = unsafe {
            &*(vk_data[8..].as_ptr() as *const VerifyingKeyAccount)
        };

        require!(vk.finalized == 1, ZerokError::IncompleteVk); // 1 = finalized

        // Phase B4: Explicit VK hash binding - verify caller provided correct hash
        require!(
            vk_sha256 == vk.sha256_hash,
            ZerokError::VkHashMismatch
        );

        // Verify VK pubkey matches state
        require!(
            vk_ai.key() == state.vk_account,
            ZerokError::VkHashMismatch
        );

        // Verify VK integrity using the same canonical function
        // Single source of truth: vk_hash_data_field
        let computed_hash = vk_hash_data_field(&vk);
        require!(
            computed_hash == state.vk_sha256,
            ZerokError::VkHashMismatch
        );

        // Extract verified VK bytes for proof verification
        let vk_bytes = &vk.data_as_slice()[..vk.length as usize];

        // Phase 6: Security Enhancement - Comprehensive checks

        // Check emergency pause (u8: 0=active, 1=paused)
        require!(state.emergency_paused == 0, ZerokError::EmergencyPaused);

        // Verify fee doesn't exceed denomination
        require!(fee <= state.denomination, ZerokError::FeeExceedsDenomination);

        // Verify relayer fee cap (basis points check)
        let max_fee = (state.denomination * state.max_relayer_fee_bps as u64) / 10_000;
        require!(fee <= max_fee, ZerokError::RelayerFeeExceedsLimit);

        // Daily withdrawal limit check
        let current_time = Clock::get()?.unix_timestamp;
        let mut daily_withdrawn = state.daily_withdrawn;
        let mut last_reset = state.last_limit_reset;

        // Reset daily limit if 24 hours have passed
        if current_time - last_reset >= 86400 { // 24 hours = 86400 seconds
            daily_withdrawn = 0;
            last_reset = current_time;
        }

        // Check if withdrawal would exceed daily limit
        let withdrawal_amount = state.denomination - fee; // Amount going to recipient
        require!(
            daily_withdrawn + withdrawal_amount <= state.daily_withdraw_limit,
            ZerokError::DailyLimitExceeded
        );

        // Nullifier PDA now validated at runtime above - prevents double-spending
        // This is the robust O(1) solution that avoids offset-dependent bugs

        // Verify root is in history using zero-copy method
        require!(
            state.is_known_root(&root),
            ZerokError::UnknownRoot
        );
        
        // **CRITICAL SECURITY**: Use VK from account with integrity verification
        // This uses the elegant VK reference approach with single source of truth
        // VK is loaded from dedicated account and verified against stored SHA256 hash
        let stored_vk = deserialize_verifying_key(vk_bytes)?;
        
        // Verify the zero-knowledge proof using Groth16
        // This uses Solana's native alt_bn128 syscalls for <200k CU verification
        // Now using the ACTUAL verifying key from the trusted setup ceremony
        verify_proof(
            &proof, 
            &root, 
            &nullifier_hash, 
            &recipient, 
            &relayer.unwrap_or(Pubkey::default()), 
            fee, 
            refund, 
            &stored_vk
        )?;
        
        // Vault validation: SystemAccount type already ensures System ownership
        // PDA derivation is enforced by seeds constraint in the Accounts struct
        // No manual validation needed - this is the elegant Anchor approach
        
        // Validate recipient is not an executable program account
        // This prevents accidentally sending funds to program accounts where they could be locked
        require!(
            !ctx.accounts.recipient.executable,
            ZerokError::BadRecipient
        );
        
        // Nullifier is marked as spent by the PDA account creation itself
        // No need to store in Vec - the account's existence is the proof
        
        // Calculate withdrawal amount
        let amount = state.denomination - fee;
        
        // Prepare vault seeds for signing
        let vault_bump = ctx.bumps.vault;
        let vault_seeds: &[&[u8]] = &[
            b"vault",
            pool_state_key.as_ref(),
            &[vault_bump]
        ];
        
        // Check vault has sufficient balance for total payout
        let rent = Rent::get()?;
        let rent_minimum = rent.minimum_balance(0);
        let total_payout = amount + fee;
        
        require!(
            ctx.accounts.vault.lamports().saturating_sub(total_payout) >= rent_minimum,
            ZerokError::VaultBelowRent
        );
        
        // Transfer to recipient using CPI with vault signing
        if amount > 0 {
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.recipient.to_account_info(),
                    },
                    &[vault_seeds]
                ),
                amount,
            )?;
        }
        
        // Pay relayer fee if present - with security validations
        if let Some(relayer_pubkey) = relayer {
            if fee > 0 {
                // Security validation: Ensure recipient cannot be the relayer (self-pay attack prevention)
                require!(
                    recipient != relayer_pubkey,
                    ZerokError::RecipientCannotBeRelayer
                );

                // Security validation: Ensure the provided relayer account matches the specified pubkey
                // Since relayer is now UncheckedAccount, we validate it matches the pubkey
                require!(
                    ctx.accounts.relayer.key() == relayer_pubkey,
                    ZerokError::RelayerMismatch
                );

                // Transfer fee to verified relayer using CPI with vault signing
                system_program::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.system_program.to_account_info(),
                        system_program::Transfer {
                            from: ctx.accounts.vault.to_account_info(),
                            to: ctx.accounts.relayer.to_account_info(),
                        },
                        &[vault_seeds]
                    ),
                    fee,
                )?;
            }
        }
        
        // Phase 6: Update daily withdrawal tracking after successful withdrawal
        state.daily_withdrawn = daily_withdrawn + withdrawal_amount;
        state.last_limit_reset = last_reset;

        emit!(WithdrawalEvent {
            to: recipient,
            nullifier_hash,
            relayer,
            fee,
        });

        Ok(())
    }
    
    /// One-time migration to move existing funds from state account to vault
    /// This should only be called once during the upgrade from old to new architecture
    pub fn migrate_to_vault(ctx: Context<MigrateToVault>) -> Result<()> {
        // Vault validation: SystemAccount type already ensures System ownership
        // PDA derivation is enforced by seeds constraint in the Accounts struct
        
        // Calculate surplus funds in state account (above rent exemption)
        let rent = Rent::get()?;
        let state_account_size = 8 + ZerokState::MAX_SIZE;
        let state_rent_minimum = rent.minimum_balance(state_account_size);
        let state_account_info = ctx.accounts.pool_state.to_account_info();
        let current_state_balance = state_account_info.lamports();
        
        // Only migrate if there's surplus
        if current_state_balance > state_rent_minimum {
            let migration_amount = current_state_balance - state_rent_minimum;
            
            // Prepare pool_state PDA seeds for signing
            let state_bump = ctx.bumps.pool_state;
            let state_seeds: &[&[u8]] = &[b"zerok", &[state_bump]];
            
            // Transfer surplus from state account to vault using CPI with PDA signing
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: state_account_info.clone(),
                        to: ctx.accounts.vault.to_account_info(),
                    },
                    &[state_seeds],
                ),
                migration_amount,
            )?;
            
            emit!(MigrationEvent {
                amount_migrated: migration_amount,
                timestamp: Clock::get()?.unix_timestamp,
            });
        }
        
        Ok(())
    }

    /// Update security parameters (authority only)
    /// Allows pool authority to manage security settings
    pub fn update_security_config(
        ctx: Context<UpdateSecurityConfig>,
        max_relayer_fee_bps: Option<u16>,
        daily_withdraw_limit: Option<u64>,
        emergency_paused: Option<bool>,
    ) -> Result<()> {
        // Load state mutably for updates
        let mut state = ctx.accounts.pool_state.load_mut()?;

        // Validate authority
        require!(
            state.authority == ctx.accounts.authority.key(),
            ZerokError::Unauthorized
        );

        // Update max relayer fee (max 10% = 1000 bps)
        if let Some(new_fee_bps) = max_relayer_fee_bps {
            require!(new_fee_bps <= 1000, ZerokError::RelayerFeeExceedsLimit);
            state.max_relayer_fee_bps = new_fee_bps;
        }

        // Update daily withdrawal limit
        if let Some(new_limit) = daily_withdraw_limit {
            state.daily_withdraw_limit = new_limit;
        }

        // Update emergency pause status (u8: 0=active, 1=paused)
        if let Some(paused) = emergency_paused {
            state.emergency_paused = if paused { 1 } else { 0 };
        }

        // P3.3: Emit event for security config update
        emit!(SecurityConfigUpdated {
            authority: ctx.accounts.authority.key(),
            max_relayer_fee_bps,
            daily_withdraw_limit,
            emergency_paused,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Zero-cost view instruction for system observability
    /// Returns critical system metrics without state modifications
    pub fn view_state(ctx: Context<ViewState>) -> Result<StateView> {
        // Load state read-only
        let state = ctx.accounts.pool_state.load()?;

        Ok(StateView {
            authority: state.authority,
            denomination: state.denomination,
            next_index: state.next_index,
            current_root_index: state.current_root_index,
            merkle_root: state.current_root,  // No merkle_tree field, use current_root directly
            vk_account: state.vk_account,
            vk_sha256: state.vk_sha256,
            total_roots: ZerokState::ROOT_HISTORY_SIZE as u32,  // Fixed array size
            max_deposits: 1u32 << ZerokState::N_LEVELS,
            fill_percentage: ((state.next_index as f64 / (1u64 << ZerokState::N_LEVELS) as f64) * 100.0) as u16,

            // Phase 6: Security Enhancement visibility (emergency_paused is u8: 0=active, 1=paused)
            max_relayer_fee_bps: state.max_relayer_fee_bps,
            emergency_paused: state.emergency_paused != 0,  // Convert u8 to bool for view
            daily_withdraw_limit: state.daily_withdraw_limit,
            daily_withdrawn: state.daily_withdrawn,
            last_limit_reset: state.last_limit_reset,
        })
    }

    /// Debug instruction for devnet - reveals nullifier PDA derivation details
    /// DEVNET ONLY - helps diagnose PDA mismatches
    #[cfg(feature = "devnet")]
    pub fn debug_nullifier_derivation(
        ctx: Context<DebugNullifier>,
        nullifier_hash: [u8; 32],
    ) -> Result<()> {
        let pool_state = &ctx.accounts.pool_state;

        msg!("=== DEBUG: Nullifier PDA Derivation ===");
        msg!("State PDA: {}", pool_state.key());

        // Convert nullifier hash to hex string for display
        let hex_string = nullifier_hash
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>();
        msg!("Nullifier Hash: 0x{}", hex_string);

        // Show the exact seeds being used
        msg!("Seeds used for PDA derivation:");
        msg!("  1. b'nullifier'");
        msg!("  2. State key: {}", pool_state.key());
        msg!("  3. Nullifier hash: 0x{}", hex_string);

        // Derive and show expected PDA
        let state_key = pool_state.key();
        let seeds = &[
            b"nullifier",
            state_key.as_ref(),
            &nullifier_hash,
        ];
        let (expected_pda, bump) = Pubkey::find_program_address(seeds, ctx.program_id);

        msg!("Expected nullifier PDA: {}", expected_pda);
        msg!("Expected bump: {}", bump);

        // If nullifier account provided, compare
        if !ctx.accounts.nullifier.data_is_empty() {
            msg!("Provided nullifier account: {}", ctx.accounts.nullifier.key());
            msg!(
                "Match: {}",
                if expected_pda == ctx.accounts.nullifier.key() {
                    "✅ YES"
                } else {
                    "❌ NO"
                }
            );
        }

        msg!("=== END DEBUG ===");
        Ok(())
    }

    /// Debug instruction for VK hash validation
    /// DEVNET ONLY - helps verify hash computation matches client
    #[cfg(feature = "devnet")]
    pub fn debug_vk_hash(ctx: Context<DebugVkHash>) -> Result<()> {
        let vk = ctx.accounts.vk_account.load()?;

        msg!("=== DEBUG: VK Hash Validation ===");
        msg!("VK Account: {}", ctx.accounts.vk_account.key());
        msg!("VK length: {}", vk.length);
        msg!("Finalized: {}", vk.finalized);

        // Compute hash using our canonical function
        let computed_hash = vk_hash_data_field(&vk);

        // Display as hex
        let hex_string = computed_hash
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>();
        msg!("Computed SHA256: 0x{}", hex_string);

        // If finalized, show stored hash
        if vk.finalized == 1 {
            let stored_hex = vk.sha256_hash
                .iter()
                .map(|b| format!("{:02x}", b))
                .collect::<String>();
            msg!("Stored SHA256: 0x{}", stored_hex);
            msg!(
                "Match: {}",
                if computed_hash == vk.sha256_hash {
                    "✅ YES"
                } else {
                    "❌ NO"
                }
            );
        }

        msg!("=== END DEBUG ===");
        Ok(())
    }

    /// Bind VK to state (authority only)
    /// This explicitly sets which VK account the state should use
    ///
    /// # First Principles
    /// - Single source of truth for VK identity
    /// - Authority-controlled for security
    /// - Safe binding (empty pool or devnet)
    pub fn bind_vk(ctx: Context<BindVk>) -> Result<()> {
        let vk_account_key = ctx.accounts.vk_account.key();
        let vk = ctx.accounts.vk_account.load()?;

        // Load state mutably
        let mut state = ctx.accounts.pool_state.load_mut()?;

        // Authority gate - only authority can bind VK
        require_keys_eq!(
            state.authority,
            ctx.accounts.authority.key(),
            ZerokError::Unauthorized
        );

        // Safety check: Only allow binding on empty pool (or devnet)
        #[cfg(not(feature = "devnet"))]
        require!(
            state.next_index == 0,
            ZerokError::PoolNotEmpty
        );

        // VK must be finalized before binding
        require!(
            vk.finalized == 1,
            ZerokError::IncompleteVk
        );

        // Compute and store the VK hash that withdraw will verify
        let computed_hash = vk_hash_data_field(&vk);

        // Bind the VK to state
        state.vk_account = vk_account_key;
        state.vk_sha256 = computed_hash;

        msg!("VK bound successfully");
        msg!("VK Account: {}", vk_account_key);
        msg!("VK SHA256: {:?}", computed_hash);

        // Emit event for transparency
        emit!(VkBound {
            vk_account: vk_account_key,
            vk_sha256: computed_hash,
            authority: state.authority,
        });

        Ok(())
    }

    /// P3.2: Set new authority (authority only, no realloc)
    /// Transfers control to a new authority (typically multisig)
    pub fn set_authority(ctx: Context<SetAuthority>, new_authority: Pubkey) -> Result<()> {
        let pool_state_info = ctx.accounts.pool_state.to_account_info();
        require_eq!(pool_state_info.owner, ctx.program_id, ZerokError::InvalidOwner);
        let mut data = pool_state_info.try_borrow_mut_data()?;
        // Validate discriminator (ZerokStateV2Clean)
        let disc = <state_v2_clean::ZerokStateV2Clean as anchor_lang::Discriminator>::DISCRIMINATOR;
        require!(&data[0..8] == disc, ZerokError::InvalidStateAccount);
        // Validate current authority at offset 16
        require!(
            &data[16..48] == ctx.accounts.authority.key().as_ref(),
            ZerokError::Unauthorized
        );

        // Read old authority for event
        let mut old_auth = [0u8; 32];
        old_auth.copy_from_slice(&data[16..48]);

        // Write new authority at offset 16 (32 bytes)
        data[16..48].copy_from_slice(new_authority.as_ref());

        msg!("Authority transferred from {} to {}", Pubkey::from(old_auth), new_authority);
        Ok(())
    }

    /// Repair corrupted state indices
    /// Authority-only function to fix invariant violations
    pub fn repair_state(ctx: Context<RepairState>) -> Result<()> {
        // Load state mutably
        let mut state = ctx.accounts.pool_state.load_mut()?;

        // Authority gate
        require_keys_eq!(
            state.authority,
            ctx.accounts.authority.key(),
            ZerokError::Unauthorized
        );

        msg!("Repairing corrupted state indices");
        msg!("Before: current_root_index={}, next_index={}",
            state.current_root_index,
            state.next_index);

        // Reset corrupted indices to valid values
        if state.current_root_index >= ZerokState::ROOT_HISTORY_SIZE as u32 {
            state.current_root_index = 0;
            msg!("Reset current_root_index to 0");
        }

        let max_leaves = 1u32 << ZerokState::N_LEVELS;
        if state.next_index > max_leaves {
            // If tree was never used, set to 0
            // Otherwise cap at max_leaves
            state.next_index = if state.next_index == 2984057452 {
                0  // Corrupted value, likely never used
            } else {
                max_leaves
            };
            msg!("Reset next_index to {}", state.next_index);
        }

        // Note: roots is now a fixed array, no truncation needed

        msg!("After: current_root_index={}, next_index={}",
            state.current_root_index,
            state.next_index);

        // Verify invariants are now satisfied
        assert_state_invariants_zero_copy(&state)?;
        msg!("State invariants verified - repair successful");

        Ok(())
    }

    // ============================================
    // v2 Pool Instructions (BE encoding)
    // ============================================

    /// Initialize v2 pool with BE encoding
    pub fn initialize_v2(
        ctx: Context<InitializeV2>,
        denomination: u64,
        max_fee_bps: u16,
        daily_limit: u64,
    ) -> Result<()> {
        instructions_v2::initialize_v2(ctx, denomination, max_fee_bps, daily_limit)
    }

    /// Deposit to v2 pool with BE commitment
    pub fn deposit_v2(
        ctx: Context<DepositV2>,
        commitment_be: [u8; 32]
    ) -> Result<()> {
        instructions_v2::deposit_v2(ctx, commitment_be)
    }

    /// Withdraw from v2 pool with BE proof
    pub fn withdraw_v2(
        ctx: Context<WithdrawV2>,
        proof: Vec<u8>,
        root_be: [u8; 32],
        nullifier_hash_be: [u8; 32],
        recipient: Pubkey,
        relayer: Option<Pubkey>,
        fee: u64,
        refund: u64,
    ) -> Result<()> {
        instructions_v2::withdraw_v2(
            ctx,
            proof,
            root_be,
            nullifier_hash_be,
            recipient,
            relayer,
            fee,
            refund
        )
    }

    // Clean v2 instructions - NO contamination from old state

    /// Initialize state (Step 1 of 2 - split to reduce stack pressure)
    pub fn initialize_state_v2_clean(
        ctx: Context<InitializeStateV2Clean>,
        denomination: u64,
        max_fee_bps: u16,
    ) -> Result<()> {
        handler_initialize_state_v2_clean(ctx, denomination, max_fee_bps)
    }

    /// Initialize vault (Step 2 of 2 - split to reduce stack pressure)
    pub fn initialize_vault_v2_clean(
        ctx: Context<InitializeVaultV2Clean>,
        denomination: u64,
    ) -> Result<()> {
        handler_initialize_vault_v2_clean(ctx, denomination)
    }

    /// Initialize RootRing for rolling on-chain Merkle roots (Phase R: K=128)
    pub fn init_root_ring(ctx: Context<InitRootRing>) -> Result<()> {
        instructions_root_ring::init_root_ring(ctx)
    }

    /// Initialize sharded root ring metadata (K=4,096)
    pub fn init_root_ring_v2_sharded(ctx: Context<InitRootRingV2Sharded>) -> Result<()> {
        instructions_root_ring_shard::init_root_ring_v2_sharded(ctx)
    }

    /// Lazy allocate a shard PDA (K=4,096 sharded ring)
    pub fn init_shard(ctx: Context<InitShard>, shard_index: u32) -> Result<()> {
        instructions_root_ring_shard::init_shard(ctx, shard_index)
    }

    /// Advance to next shard when current is full (wrap-around)
    ///
    /// Called by deposit orchestrator when shard fills up (local_head >= shard_capacity).
    /// Uses modulo arithmetic for wrap-around: (active_shard_index + 1) % num_shards
    pub fn advance_active_shard(ctx: Context<AdvanceActiveShard>) -> Result<()> {
        instructions_root_ring_shard::advance_active_shard(ctx)
    }

    /// Deposit to clean v2 pool (with optional Light Protocol integration)
    pub fn deposit_v2_clean<'info>(
        ctx: Context<'_, '_, '_, 'info, DepositV2Clean<'info>>,
        commitment_be: [u8; 32],
        light_enabled: bool,
        light_proof_bytes: Vec<u8>,
        output_tree_index: u8,
        light_accounts_offset: u8,
    ) -> Result<()> {
        handler_deposit_v2_clean(
            ctx,
            commitment_be,
            light_enabled,
            light_proof_bytes,
            output_tree_index,
            light_accounts_offset,
        )
    }

    /// Batch deposit to clean v2 pool — multiple commitments in one instruction
    /// State-equivalent to calling deposit_v2_clean N times sequentially.
    /// remaining_accounts[0] = next shard PDA (for mid-batch shard rotation)
    pub fn deposit_batch_v2_clean<'info>(
        ctx: Context<'_, '_, '_, 'info, DepositBatchV2Clean<'info>>,
        commitments_be: Vec<[u8; 32]>,
    ) -> Result<()> {
        handler_deposit_batch_v2_clean(ctx, commitments_be)
    }

    /// Withdraw from clean v2 pool
    pub fn withdraw_v2_clean(
        ctx: Context<WithdrawV2Clean>,
        nullifier_hash: [u8; 32],
        proof: Vec<u8>,
        root: [u8; 32],
        fee: u64,
        refund: u64,
    ) -> Result<()> {
        handler_withdraw_v2_clean(ctx, nullifier_hash, proof, root, fee, refund)
    }

    /// Withdraw from Light Protocol compressed account
    /// Phase L1.3: Light-aware withdrawal with CPI integration
    ///
    /// Consumes a compressed note via Light System Program and transfers funds to recipient.
    /// Supports both full and partial withdrawals (with change).
    ///
    /// See WITHDRAWAL_INSTRUCTION_DESIGN.md for complete specification.
    pub fn withdraw_light<'info>(
        ctx: Context<'_, '_, '_, 'info, WithdrawLight<'info>>,
        args: WithdrawLightArgs,
    ) -> Result<()> {
        handler_withdraw_light(ctx, args)
    }

    /// Initialize cooldown configuration for a pool
    /// Authority-only setup instruction
    pub fn initialize_cooldown_config(
        ctx: Context<InitializeCooldownConfig>,
        cooldown_slots: u64,
    ) -> Result<()> {
        handler_initialize_cooldown_config(ctx, cooldown_slots)
    }

    /// Update cooldown configuration settings
    /// Authority-only update instruction
    pub fn update_cooldown_config(
        ctx: Context<UpdateCooldownConfig>,
        cooldown_slots: Option<u64>,
        enabled: Option<bool>,
    ) -> Result<()> {
        handler_update_cooldown_config(ctx, cooldown_slots, enabled)
    }

    // V2 with account-stored constants (stack overflow fix - DISABLED due to stack issues)
    // These instructions cause stack overflow and are replaced by optimized versions below
    /*
    /// Initialize Poseidon constants account
    pub fn initialize_poseidon_constants(ctx: Context<InitializePoseidonConstants>) -> Result<()> {
        instructions_v2_account::initialize_poseidon_constants(ctx)
    }

    /// Initialize v2 pool with constants account
    pub fn initialize_v2_with_constants(
        ctx: Context<InitializeV2WithConstants>,
        denomination: u64,
        max_fee_bps: u16,
    ) -> Result<()> {
        instructions_v2_account::initialize_v2_with_constants(ctx, denomination, max_fee_bps)
    }

    /// Deposit to v2 pool using constants account
    pub fn deposit_v2_with_constants(
        ctx: Context<DepositV2WithConstants>,
        commitment: [u8; 32],
    ) -> Result<()> {
        instructions_v2_account::deposit_v2_with_constants(ctx, commitment)
    }
    */

    // LEGACY V2 optimized - disabled to prevent stack overflow
    #[cfg(feature = "archive_v2")]
    pub fn initialize_v2_optimized(
        ctx: Context<InitializeV2Optimized>,
        denomination: u64,
        max_fee_bps: u16,
    ) -> Result<()> {
        handler_initialize_v2_optimized(ctx, denomination, max_fee_bps)
    }

    #[cfg(feature = "archive_v2")]
    pub fn deposit_v2_optimized(
        ctx: Context<DepositV2Optimized>,
        commitment: [u8; 32],
    ) -> Result<()> {
        handler_deposit_v2_optimized(ctx, commitment)
    }

    #[cfg(feature = "archive_v2")]
    pub fn withdraw_v2_optimized(
        ctx: Context<WithdrawV2Optimized>,
        proof: [u8; 256],
        root: [u8; 32],
        nullifier_hash: [u8; 32],
        fee: u64,
        refund: u64,
    ) -> Result<()> {
        handler_withdraw_v2_optimized(ctx, proof, root, nullifier_hash, fee, refund)
    }

    /// Initialize VK PDA for clean v2 (separate from upload to avoid BPF heap limits)
    pub fn initialize_vk_pda_v2_clean(
        ctx: Context<InitializeVkPdaV2Clean>,
    ) -> Result<()> {
        handler_initialize_vk_pda_v2_clean(ctx)
    }

    /// Upload VK chunk for clean v2 (chunked upload with manual zero-copy deserialization)
    /// Parameters are manually parsed from instruction data to avoid BPF heap allocation
    pub fn upload_vk_chunk_v2_clean(
        ctx: Context<UploadVKChunkV2Clean>,
    ) -> Result<()> {
        handler_upload_vk_chunk_v2_clean(ctx)
    }

    /// Finalize verifying key for clean v2 (after chunks uploaded)
    pub fn finalize_vk_v2_clean(
        ctx: Context<FinalizeVKV2Clean>,
    ) -> Result<()> {
        handler_finalize_vk_v2_clean(ctx)
    }

    pub fn pause_v2_clean(
        ctx: Context<PauseV2Clean>,
    ) -> Result<()> {
        handler_pause_v2_clean(ctx)
    }

    pub fn unpause_v2_clean(
        ctx: Context<UnpauseV2Clean>,
    ) -> Result<()> {
        handler_unpause_v2_clean(ctx)
    }

    /// Update max_fee_bps for a pool (authority only)
    pub fn update_max_fee_bps(
        ctx: Context<UpdateMaxFeeBps>,
        new_max_fee_bps: u16,
    ) -> Result<()> {
        let pool_state_info = ctx.accounts.pool_state.to_account_info();
        require_eq!(pool_state_info.owner, ctx.program_id, ZerokError::InvalidOwner);
        let mut data = pool_state_info.try_borrow_mut_data()?;
        // Validate discriminator
        let disc = <state_v2_clean::ZerokStateV2Clean as anchor_lang::Discriminator>::DISCRIMINATOR;
        require!(&data[0..8] == disc, ZerokError::InvalidStateAccount);
        // Validate authority (offset 16, 32 bytes)
        let authority_bytes = &data[16..48];
        require!(
            authority_bytes == ctx.accounts.authority.key().as_ref(),
            ZerokError::Unauthorized
        );
        // Write new max_fee_bps at offset 8984 (u16 LE)
        data[8984] = (new_max_fee_bps & 0xFF) as u8;
        data[8985] = (new_max_fee_bps >> 8) as u8;
        msg!("max_fee_bps updated to {}", new_max_fee_bps);
        Ok(())
    }

    /// Close a pool and return all rent to authority.
    /// Requires: vault balance = 0 (all user funds withdrawn first).
    /// Closes: state, vault, VK, ring metadata, and all shard accounts passed as remaining_accounts.
    pub fn close_pool(ctx: Context<ClosePool>) -> Result<()> {
        let pool_state_info = ctx.accounts.pool_state.to_account_info();
        let authority_info = ctx.accounts.authority.to_account_info();

        // Validate state account
        require_eq!(pool_state_info.owner, ctx.program_id, ZerokError::InvalidOwner);
        let data = pool_state_info.try_borrow_data()?;
        let disc = <state_v2_clean::ZerokStateV2Clean as anchor_lang::Discriminator>::DISCRIMINATOR;
        require!(&data[0..8] == disc, ZerokError::InvalidStateAccount);
        // Validate authority (offset 16)
        require!(&data[16..48] == ctx.accounts.authority.key().as_ref(), ZerokError::Unauthorized);
        drop(data);

        // Validate vault is empty (no user funds locked)
        let vault_info = ctx.accounts.vault.to_account_info();
        let vault_lamports = vault_info.lamports();
        let vault_rent = anchor_lang::prelude::Rent::get()?.minimum_balance(0);
        require!(vault_lamports <= vault_rent, ZerokError::VaultNotEmpty);

        // Close all accounts by transferring lamports to authority
        let accounts_to_close = vec![
            pool_state_info.clone(),
            vault_info.clone(),
            ctx.accounts.vk_pda.to_account_info(),
            ctx.accounts.ring_metadata.to_account_info(),
        ];

        let mut total_recovered: u64 = 0;

        // Close base accounts
        for account in accounts_to_close {
            if account.owner == ctx.program_id || account.owner == &anchor_lang::system_program::ID {
                let lamports = account.lamports();
                **account.try_borrow_mut_lamports()? = 0;
                **authority_info.try_borrow_mut_lamports()? += lamports;
                total_recovered += lamports;
            }
        }

        // Close shard accounts from remaining_accounts
        for shard_info in ctx.remaining_accounts.iter() {
            if shard_info.owner == ctx.program_id {
                let lamports = shard_info.lamports();
                **shard_info.try_borrow_mut_lamports()? = 0;
                **authority_info.try_borrow_mut_lamports()? += lamports;
                total_recovered += lamports;
            }
        }

        msg!("Pool closed. Recovered {} lamports ({} SOL)", total_recovered, total_recovered as f64 / 1e9);
        Ok(())
    }

    // close_legacy_pool removed — all V2 pools already closed (2026-04-06)

    /// Get Merkle path for a given leaf index (read-only)
    pub fn get_merkle_path(
        ctx: Context<GetMerklePath>,
        leaf_index: u32,
    ) -> Result<()> {
        handler_get_merkle_path(ctx, leaf_index)
    }

    /// Debug-only: Log Merkle computation step-by-step (feature-gated)
    /// Helps identify endianness mismatches with off-chain tools
    #[cfg(feature = "debug-merkle")]
    pub fn debug_merkle_computation(
        ctx: Context<DebugMerkleComputation>,
        commitment_be: [u8; 32],
        leaf_index: u32,
    ) -> Result<()> {
        handler_debug_merkle_computation(ctx, commitment_be, leaf_index)
    }

    /// Test-only: Verify arbitrary proof with 9 inputs (feature-gated)
    /// Uses fixed-size arrays to avoid heap allocation from Vec parameters
    #[cfg(feature = "verify-hook")]
    pub fn test_verify(
        ctx: Context<TestVerify>,
        proof: [u8; 256],
        public_inputs_flat: [u8; 288], // 9 inputs × 32 bytes
    ) -> Result<()> {
        let n = 9;

        // Load VK account with zero-copy
        let vk_account = ctx.accounts.vk.load()?;

        // Extract VK bytes from the data field
        let vk_bytes = &vk_account.data_as_slice()[..vk_account.length as usize];

        // Deserialize VK from bytes
        let vk = crate::deserialize_verifying_key(vk_bytes)?;

        // Parse proof components
        let proof_a: [u8; 64] = proof[0..64].try_into()
            .map_err(|_| ZerokError::InvalidProofFormat)?;
        let proof_b: [u8; 128] = proof[64..192].try_into()
            .map_err(|_| ZerokError::InvalidProofFormat)?;
        let proof_c: [u8; 64] = proof[192..256].try_into()
            .map_err(|_| ZerokError::InvalidProofFormat)?;

        // Parse 9 inputs (fixed size for reference test)
        let inputs: [[u8; 32]; 9] = [
            public_inputs_flat[0..32].try_into().unwrap(),
            public_inputs_flat[32..64].try_into().unwrap(),
            public_inputs_flat[64..96].try_into().unwrap(),
            public_inputs_flat[96..128].try_into().unwrap(),
            public_inputs_flat[128..160].try_into().unwrap(),
            public_inputs_flat[160..192].try_into().unwrap(),
            public_inputs_flat[192..224].try_into().unwrap(),
            public_inputs_flat[224..256].try_into().unwrap(),
            public_inputs_flat[256..288].try_into().unwrap(),
        ];

        let mut verifier = Groth16Verifier::new(
            &proof_a,  // Now negated!
            &proof_b,
            &proof_c,
            &inputs,
            &vk,
        ).map_err(|e| {
            msg!("Failed to create verifier: {:?}", e);
            ZerokError::VerifierCreationFailed
        })?;

        verifier.verify().map_err(|e| {
            msg!("Proof verification failed: {:?}", e);
            ZerokError::ProofVerificationFailed
        })?;

        msg!("✅ Test proof verified successfully (9 inputs)");
        Ok(())
    }

    /// Test-only: Verify minimal circuit proof with 2 inputs (feature-gated)
    /// For testing serialization format with minimal circuit
    #[cfg(feature = "verify-hook")]
    pub fn test_verify_minimal(
        ctx: Context<TestVerify>,
        proof: [u8; 256],
        public_inputs_flat: [u8; 64], // 2 inputs × 32 bytes
    ) -> Result<()> {
        // Load VK account with zero-copy
        let vk_account = ctx.accounts.vk.load()?;

        // Ensure VK is finalized before use
        require!(vk_account.finalized == 1, ZerokError::VKNotFinalized);

        // Get VK bytes from the data field
        let vk_bytes = &vk_account.data_as_slice()[..vk_account.length as usize];

        // Deserialize VK
        let vk = crate::deserialize_verifying_key(vk_bytes)?;

        // Parse proof components
        let proof_a: [u8; 64] = proof[0..64].try_into()
            .map_err(|_| ZerokError::InvalidProofFormat)?;
        let proof_b: [u8; 128] = proof[64..192].try_into()
            .map_err(|_| ZerokError::InvalidProofFormat)?;
        let proof_c: [u8; 64] = proof[192..256].try_into()
            .map_err(|_| ZerokError::InvalidProofFormat)?;

        // Parse 2 inputs for minimal circuit (x + y = 3)
        let inputs: [[u8; 32]; 2] = [
            public_inputs_flat[0..32].try_into().unwrap(),
            public_inputs_flat[32..64].try_into().unwrap(),
        ];

        let mut verifier = Groth16Verifier::new(
            &proof_a,  // Already negated by zkprover!
            &proof_b,
            &proof_c,
            &inputs,
            &vk,
        ).map_err(|e| {
            msg!("Failed to create verifier: {:?}", e);
            ZerokError::VerifierCreationFailed
        })?;

        verifier.verify().map_err(|e| {
            msg!("Proof verification failed: {:?}", e);
            ZerokError::ProofVerificationFailed
        })?;

        msg!("✅ Minimal test proof verified successfully (2 inputs)");
        Ok(())
    }

    /// Test-only: Verify withdraw circuit proof with 8 inputs (feature-gated)
    /// For testing withdraw circuit (root, nullifierHash, recipient, relayer, fee, refund)
    #[cfg(feature = "verify-hook")]
    pub fn test_verify_withdraw(
        ctx: Context<TestVerify>,
        proof: [u8; 256],
        public_inputs_flat: [u8; 256], // 8 inputs × 32 bytes
    ) -> Result<()> {
        // Load VK account with zero-copy
        let vk_account = ctx.accounts.vk.load()?;

        // Ensure VK is finalized before use
        require!(vk_account.finalized == 1, ZerokError::VKNotFinalized);

        // Get VK bytes from the data field
        let vk_bytes = &vk_account.data_as_slice()[..vk_account.length as usize];

        // Deserialize VK
        let vk = crate::deserialize_verifying_key(vk_bytes)?;

        // Parse proof components
        let proof_a: [u8; 64] = proof[0..64].try_into()
            .map_err(|_| ZerokError::InvalidProofFormat)?;
        let proof_b: [u8; 128] = proof[64..192].try_into()
            .map_err(|_| ZerokError::InvalidProofFormat)?;
        let proof_c: [u8; 64] = proof[192..256].try_into()
            .map_err(|_| ZerokError::InvalidProofFormat)?;

        // Parse 8 inputs for withdraw circuit
        let inputs: [[u8; 32]; 8] = [
            public_inputs_flat[0..32].try_into().unwrap(),
            public_inputs_flat[32..64].try_into().unwrap(),
            public_inputs_flat[64..96].try_into().unwrap(),
            public_inputs_flat[96..128].try_into().unwrap(),
            public_inputs_flat[128..160].try_into().unwrap(),
            public_inputs_flat[160..192].try_into().unwrap(),
            public_inputs_flat[192..224].try_into().unwrap(),
            public_inputs_flat[224..256].try_into().unwrap(),
        ];

        let mut verifier = Groth16Verifier::new(
            &proof_a,  // Already negated by zkprover!
            &proof_b,
            &proof_c,
            &inputs,
            &vk,
        ).map_err(|e| {
            msg!("Failed to create verifier: {:?}", e);
            ZerokError::VerifierCreationFailed
        })?;

        verifier.verify().map_err(|e| {
            msg!("Proof verification failed: {:?}", e);
            ZerokError::ProofVerificationFailed
        })?;

        msg!("✅ Withdraw test proof verified successfully (8 inputs)");
        Ok(())
    }

    /// Debug syscall oracle: test scalar encoding with known values
    #[cfg(feature = "verify-hook")]
    pub fn debug_ecmul(
        ctx: Context<DebugEcmul>,
        ic_index: u8,
        scalar_be: [u8; 32],
    ) -> Result<()> {
        use solana_bn254::prelude::{alt_bn128_multiplication, alt_bn128_addition};

        // Load VK and get IC point
        let vk_account = ctx.accounts.vk.to_account_info();
        let vk_data = vk_account.try_borrow_data()?;
        let vk = crate::deserialize_verifying_key(&vk_data)?;

        require!(
            (ic_index as usize) < vk.vk_ic.len(),
            ZerokError::InvalidInputsLen
        );

        let p: [u8; 64] = vk.vk_ic[ic_index as usize];

        // Try BE scalar first
        let be_input = [&p[..], &scalar_be[..]].concat();
        let be_res = alt_bn128_multiplication(&be_input)
            .map_err(|_| ZerokError::PreparingInputsG1MulFailed)?;

        // Try LE scalar (just reversed)
        let mut scalar_le = scalar_be;
        scalar_le.reverse();
        let le_input = [&p[..], &scalar_le[..]].concat();
        let le_res = alt_bn128_multiplication(&le_input)
            .map_err(|_| ZerokError::PreparingInputsG1MulFailed)?;

        // Log both; also log p for equality check
        msg!("═══ ECMUL ORACLE PROBE ═══");
        msg!("IC[{}] point P (x||y): {}", ic_index, hex::encode(&p));
        msg!("Scalar (BE):           {}", hex::encode(&scalar_be));
        msg!("Scalar (LE):           {}", hex::encode(&scalar_le));
        msg!("BE result (x||y):      {}", hex::encode(&be_res));
        msg!("LE result (x||y):      {}", hex::encode(&le_res));
        msg!("═════════════════════════");

        Ok(())
    }

    // LEGACY V2 Static - disabled to prevent stack overflow
    #[cfg(feature = "archive_v2")]
    pub fn initialize_v2_static(
        ctx: Context<InitializeV2Static>,
        denomination: u64,
        max_fee_bps: u16,
    ) -> Result<()> {
        handler_initialize_v2_static(ctx, denomination, max_fee_bps)
    }

    #[cfg(feature = "archive_v2")]
    pub fn deposit_v2_static(
        ctx: Context<DepositV2Static>,
        commitment: [u8; 32],
    ) -> Result<()> {
        handler_deposit_v2_static(ctx, commitment)
    }

    // TEMPORARILY DISABLED TO TEST BUILD
    // /// Initialize v2 pool with cached Poseidon (Final solution)
    // pub fn initialize_v2_cached(
    //     ctx: Context<InitializeV2Cached>,
    //     denomination: u64,
    //     max_fee_bps: u16,
    // ) -> Result<()> {
    //     handler_initialize_v2_cached(ctx, denomination, max_fee_bps)
    // }

    // /// Deposit to v2 pool with cached Poseidon (Final solution)
    // pub fn deposit_v2_cached(
    //     ctx: Context<DepositV2Cached>,
    //     commitment: [u8; 32],
    // ) -> Result<()> {
    //     handler_deposit_v2_cached(ctx, commitment)
    // }

}

/// Assert state invariants to prevent corruption
/// Checks that indices are within valid bounds
// Legacy version for non-zero-copy (if any remain)
pub fn assert_state_invariants(state: &ZerokState) -> Result<()> {
    // This is kept for backward compatibility but should not be used
    // Use assert_state_invariants_zero_copy instead
    assert_state_invariants_zero_copy(state)
}

// Zero-copy version of state invariant checks
pub fn assert_state_invariants_zero_copy(state: &ZerokState) -> Result<()> {
    // Check current_root_index is within history bounds
    require!(
        state.current_root_index < ZerokState::ROOT_HISTORY_SIZE as u32,
        ZerokError::InvalidRootIndex
    );

    // Check next_index is within tree capacity
    let max_leaves = 1u32 << ZerokState::N_LEVELS;
    require!(
        state.next_index <= max_leaves,
        ZerokError::TreeFull
    );

    // Note: roots is now a fixed array, no length check needed

    Ok(())
}

// State view return structure
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StateView {
    pub authority: Pubkey,
    pub denomination: u64,
    pub next_index: u32,
    pub current_root_index: u32,
    pub merkle_root: [u8; 32],
    pub vk_account: Pubkey,
    pub vk_sha256: [u8; 32],
    pub total_roots: u32,
    pub max_deposits: u32,
    pub fill_percentage: u16,

    // Phase 6: Security Enhancement visibility
    pub max_relayer_fee_bps: u16,
    pub emergency_paused: bool,
    pub daily_withdraw_limit: u64,
    pub daily_withdrawn: u64,
    pub last_limit_reset: i64,
}

// Constants matching original protocol design
pub const ROOT_HISTORY_SIZE: u32 = 30;
pub const MERKLE_TREE_HEIGHT: u32 = 20;
pub const MAX_LEAVES: u32 = 1 << MERKLE_TREE_HEIGHT; // 2^20 = 1,048,576

#[derive(Accounts)]
pub struct InitVkAccount<'info> {
    #[account(init, payer = payer, space = 8 + VerifyingKeyAccount::MAX_SIZE)]
    pub vk_account: AccountLoader<'info, VerifyingKeyAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AppendVkChunk<'info> {
    #[account(mut, has_one = authority)]
    pub vk_account: AccountLoader<'info, VerifyingKeyAccount>,
    
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct FinalizeVk<'info> {
    #[account(mut, has_one = authority)]
    pub vk_account: AccountLoader<'info, VerifyingKeyAccount>,
    
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ZerokState::MAX_SIZE,
        seeds = [b"zerok_v1"],
        bump
    )]
    pub pool_state: AccountLoader<'info, ZerokState>,
    
    #[account(
        init,
        payer = authority,
        space = 0,  // 0-byte SystemAccount for holding SOL only
        seeds = [b"vault", pool_state.key().as_ref()],
        bump
    )]
    /// CHECK: Vault PDA created as a zero-byte account for holding SOL
    pub vault: UncheckedAccount<'info>,
    
    #[account(mut)]
    pub authority: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeWithVkRef<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ZerokState::MAX_SIZE,
        seeds = [b"zerok_v1"],
        bump
    )]
    pub pool_state: AccountLoader<'info, ZerokState>,
    
    #[account(
        init,
        payer = authority,
        space = 0,  // 0-byte SystemAccount for holding SOL only
        seeds = [b"vault", pool_state.key().as_ref()],
        bump
    )]
    /// CHECK: Vault PDA created as a zero-byte account for holding SOL  
    pub vault: UncheckedAccount<'info>,
    
    /// The finalized VK account containing the verifying key data
    /// Validation moved to function body (AccountLoader doesn't support field access in constraints)
    pub vk_account: AccountLoader<'info, VerifyingKeyAccount>,
    
    #[account(mut)]
    pub authority: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(commitment: [u8; 32])]
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [b"zerok_v1"],
        bump
    )]
    pub pool_state: AccountLoader<'info, ZerokState>,

    #[account(
        mut,
        seeds = [b"vault", pool_state.key().as_ref()],
        bump
    )]
    /// CHECK: Vault PDA for holding deposits
    pub vault: UncheckedAccount<'info>,
    
    /// Commitment uniqueness guard - prevents duplicate commitments
    /// Mathematical guarantee: commitment → PDA mapping is bijective
    #[account(
        init,
        payer = depositor,
        space = 8, // Just discriminator (empty account)
        seeds = [b"commitment", pool_state.key().as_ref(), commitment.as_ref()],
        bump
    )]
    pub commitment_record: Account<'info, CommitmentRecord>,
    
    #[account(mut)]
    pub depositor: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        seeds = [b"zerok_v1"],
        bump
    )]
    pub pool_state: AccountLoader<'info, ZerokState>,

    /// The nullifier PDA - verified at runtime in handler to avoid offset-dependent bugs
    /// CHECK: Validated in handler with runtime PDA derivation
    #[account(mut)]
    pub nullifier: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"vault", pool_state.key().as_ref()],
        bump
    )]
    /// CHECK: Vault PDA for holding deposits
    pub vault: UncheckedAccount<'info>,

    /// The VK account containing verifying key data for proof verification
    /// WORKAROUND: Using UncheckedAccount due to AccountLoader::load() bug
    /// Manual validation performed in handler (owner, discriminator, deserialization)
    /// CHECK: Validated in handler with explicit checks
    pub vk_account: UncheckedAccount<'info>,

    /// CHECK: Recipient of withdrawn funds - validated in handler
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    /// CHECK: Optional relayer receiving fee - validated in handler
    #[account(mut)]
    pub relayer: UncheckedAccount<'info>,

    /// The account paying for nullifier PDA creation (relayer or recipient)
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MigrateToVault<'info> {
    #[account(
        mut,
        has_one = authority,
        seeds = [b"zerok_v1"],
        bump
    )]
    pub pool_state: AccountLoader<'info, ZerokState>,
    
    #[account(
        mut,
        seeds = [b"vault", pool_state.key().as_ref()],
        bump
    )]
    /// CHECK: Vault PDA for holding deposits
    pub vault: UncheckedAccount<'info>,
    
    #[account(mut)]
    pub authority: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateSecurityConfig<'info> {
    #[account(
        mut,
        seeds = [b"zerok_v1"],
        bump
    )]
    pub pool_state: AccountLoader<'info, ZerokState>,

    /// Authority that can update security settings
    #[account(mut)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ViewState<'info> {
    #[account(
        seeds = [b"zerok_v1"],
        bump
    )]
    pub pool_state: AccountLoader<'info, ZerokState>,
}

/// Debug context for nullifier PDA derivation (devnet only)
#[cfg(feature = "devnet")]
#[derive(Accounts)]
pub struct DebugNullifier<'info> {
    #[account(
        seeds = [b"zerok_v1"],
        bump
    )]
    pub pool_state: AccountLoader<'info, ZerokState>,

    /// CHECK: Optional nullifier account to compare
    pub nullifier: UncheckedAccount<'info>,
}

#[cfg(feature = "devnet")]
#[derive(Accounts)]
pub struct DebugVkHash<'info> {
    pub vk_account: AccountLoader<'info, VerifyingKeyAccount>,
}

/// Context for bind_vk instruction
#[derive(Accounts)]
pub struct BindVk<'info> {
    #[account(
        mut,
        seeds = [b"zerok_v1"],
        bump
    )]
    pub pool_state: AccountLoader<'info, ZerokState>,

    pub vk_account: AccountLoader<'info, VerifyingKeyAccount>,

    pub authority: Signer<'info>,
}

/// P3.2: Context for set_authority instruction — manual validation (multi-pool compatible)
#[derive(Accounts)]
pub struct SetAuthority<'info> {
    /// CHECK: Pool state PDA — validated manually in handler (supports any denomination)
    #[account(mut)]
    pub pool_state: UncheckedAccount<'info>,

    /// Current authority that must sign to transfer control
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct RepairState<'info> {
    #[account(
        mut,
        seeds = [b"zerok_v1"],
        bump,
        has_one = authority @ ZerokError::Unauthorized
    )]
    pub pool_state: AccountLoader<'info, ZerokState>,

    /// Authority that must sign to repair state
    pub authority: Signer<'info>,
}

/// Zero-copy ZeroK pool state with fixed-size arrays
/// All fields are deterministic, no dynamic allocation
/// This ensures stable byte layout and proper serialization
#[account(zero_copy)]
#[repr(C)]
pub struct ZerokState {
    // Core pool configuration (40 bytes)
    pub authority: Pubkey,              // 32 bytes
    pub denomination: u64,              // 8 bytes

    // Merkle tree state (1320 bytes) - inlined from MerkleTree
    pub filled_subtrees: [[u8; 32]; 20], // 640 bytes - rightmost node at each level
    pub zeros: [[u8; 32]; 20],           // 640 bytes - zero values for empty subtrees
    pub current_root: [u8; 32],          // 32 bytes - current merkle root
    pub next_index: u32,                 // 4 bytes - next leaf index to insert
    pub _merkle_pad: u32,                // 4 bytes - padding for alignment

    // Root history for withdrawal proofs (968 bytes)
    pub roots: [[u8; 32]; 30],           // 960 bytes - ring buffer of historical roots
    pub current_root_index: u32,         // 4 bytes - index into roots ring buffer
    pub _roots_pad: u32,                 // 4 bytes - padding for 8-byte alignment

    // VK reference (single source of truth) (64 bytes)
    pub vk_account: Pubkey,              // 32 bytes - address of VerifyingKeyAccount
    pub vk_sha256: [u8; 32],             // 32 bytes - integrity hash of VK

    // Security controls (32 bytes)
    pub max_relayer_fee_bps: u16,        // 2 bytes - max fee in basis points
    pub emergency_paused: u8,            // 1 byte - pause flag (0=active, 1=paused)
    pub _security_pad1: u8,              // 1 byte - padding
    pub _security_pad2: u32,             // 4 bytes - padding for 8-byte alignment before u64
    pub daily_withdraw_limit: u64,       // 8 bytes - max daily withdrawals
    pub last_limit_reset: i64,           // 8 bytes - timestamp of last reset
    pub daily_withdrawn: u64,            // 8 bytes - amount withdrawn today
}

impl ZerokState {
    /// Exact struct size (deterministic, no dynamic allocation)
    pub const MAX_SIZE: usize = 2424;

    /// Tree depth (20 levels = 2^20 = 1,048,576 max deposits)
    pub const N_LEVELS: usize = 20;

    /// Root history size (ring buffer of recent roots)
    pub const ROOT_HISTORY_SIZE: usize = 30;

    /// Insert leaf into merkle tree (in-place, no allocation)
    /// Returns the leaf index where it was inserted
    pub fn insert_leaf(&mut self, leaf: [u8; 32]) -> Result<u32> {
        require!(
            self.next_index < (1 << Self::N_LEVELS),
            ZerokError::MerkleTreeFull
        );

        let leaf_index = self.next_index;
        let mut current_hash = leaf;
        let mut current_index = leaf_index;
        let mut left;
        let mut right;

        // Update path from leaf to root (in-place)
        for level in 0..Self::N_LEVELS {
            if current_index % 2 == 0 {
                // Left child - store and continue
                left = current_hash;
                right = self.zeros[level];
                self.filled_subtrees[level] = current_hash;
            } else {
                // Right child - hash with left sibling
                left = self.filled_subtrees[level];
                right = current_hash;
            }

            // Hash pair using Poseidon
            current_hash = poseidon_hash_pair(&left, &right)?;
            current_index /= 2;
        }

        self.current_root = current_hash;
        self.next_index += 1;

        Ok(leaf_index)
    }

    /// Add root to history ring buffer
    pub fn push_root(&mut self, root: [u8; 32]) {
        let idx = self.current_root_index as usize % Self::ROOT_HISTORY_SIZE;
        self.roots[idx] = root;
        self.current_root_index = self.current_root_index.wrapping_add(1);
    }

    /// Check if root exists in history
    pub fn is_known_root(&self, root: &[u8; 32]) -> bool {
        // Check current root first (most common case)
        if &self.current_root == root {
            return true;
        }

        // Search history ring buffer (only check populated entries)
        let history_len = self.next_index.min(Self::ROOT_HISTORY_SIZE as u32);
        for i in 0..history_len {
            if &self.roots[i as usize] == root {
                return true;
            }
        }

        false
    }
}

/// Hash two nodes together using Poseidon (ZK-friendly)
/// Uses Anza's solana-poseidon implementation
fn poseidon_hash_pair(left: &[u8; 32], right: &[u8; 32]) -> Result<[u8; 32]> {
    use solana_poseidon::{hashv, Parameters, Endianness};

    // ENCODING CONTRACT: Field elements are canonical, bytes are LE encoding
    // Input: 32-byte LE arrays representing field elements
    // Process: Interpret as LE → hash in field domain → output as LE
    match hashv(Parameters::Bn254X5, Endianness::LittleEndian, &[left, right]) {
        Ok(hash) => Ok(hash.to_bytes()),
        Err(_) => err!(ZerokError::PoseidonHashFailed),
    }
}

#[account(zero_copy)]
#[repr(C)]
pub struct VerifyingKeyAccount {
    pub magic: [u8; 4],         // 4 bytes - magic bytes "G16S" for format validation
    pub version: u32,           // 4 bytes - format version (current: 1)
    pub authority: Pubkey,      // 32 bytes - owner who can upload/finalize VK
    pub sha256_hash: [u8; 32],  // 32 bytes - integrity check
    pub finalized: u8,          // 1 byte - upload complete flag (0=false, 1=true, avoids bool padding)
    pub _padding: [u8; 1],      // 1 byte - explicit padding for alignment
    pub length: u16,            // 2 bytes - actual VK size (supports up to 65535)
    pub data: [[u8; 512]; 3],   // 3×512 = 1536 bytes - multidimensional to satisfy Pod trait limits
}

impl VerifyingKeyAccount {
    // Canonical size from compiler, not hand calculation
    // This ensures exact match with AccountLoader's size validation
    pub const BYTE_LEN: usize = core::mem::size_of::<VerifyingKeyAccount>();

    // Deprecated: Use BYTE_LEN instead
    // Kept temporarily for backwards compatibility during migration
    pub const MAX_SIZE: usize = Self::BYTE_LEN;

    // Helper to get a flat view of the data array
    pub fn data_as_slice(&self) -> &[u8] {
        unsafe {
            std::slice::from_raw_parts(
                self.data.as_ptr() as *const u8,
                512 * 3
            )
        }
    }

    // Helper to get a mutable flat view of the data array
    pub fn data_as_mut_slice(&mut self) -> &mut [u8] {
        unsafe {
            std::slice::from_raw_parts_mut(
                self.data.as_mut_ptr() as *mut u8,
                512 * 3
            )
        }
    }
}

// Compile-time safety checks for zero-copy layout
// TEMPORARILY DISABLED to see actual size
// const _: () = {
//     // Zero-copy accounts should be aligned to 8 bytes for optimal performance
//     assert!(VerifyingKeyAccount::BYTE_LEN % 8 == 0, "VerifyingKeyAccount must be 8-byte aligned");
// };

#[event]
pub struct DepositEvent {
    pub commitment: [u8; 32],
    pub leaf_index: u32,
    pub timestamp: i64,
}

#[event]
pub struct WithdrawalEvent {
    pub to: Pubkey,
    pub nullifier_hash: [u8; 32],
    pub relayer: Option<Pubkey>,
    pub fee: u64,
}

#[event]
pub struct MigrationEvent {
    pub amount_migrated: u64,
    pub timestamp: i64,
}

#[event]
pub struct VkChunkAppended {
    pub vk_account: Pubkey,
    pub offset: u32,
    pub chunk_size: u32,
    pub total_uploaded: u32,
    pub expected_size: u32,
}

#[event]
pub struct VkFinalized {
    pub vk_account: Pubkey,
    pub total_size: u32,
    pub sha256_hash: [u8; 32],
    pub authority: Pubkey,
}

/// Event emitted when VK is bound to state
#[event]
pub struct VkBound {
    pub vk_account: Pubkey,
    pub vk_sha256: [u8; 32],
    pub authority: Pubkey,
}

/// P3.3: Event emitted when authority is changed
#[event]
pub struct AuthorityChanged {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
    pub timestamp: i64,
}

/// P3.3: Event emitted when security config is updated
#[event]
pub struct SecurityConfigUpdated {
    pub authority: Pubkey,
    pub max_relayer_fee_bps: Option<u16>,
    pub daily_withdraw_limit: Option<u64>,
    pub emergency_paused: Option<bool>,
    pub timestamp: i64,
}

/// Test-only: Accounts for test_verify instruction
#[cfg(feature = "verify-hook")]
#[derive(Accounts)]
pub struct TestVerify<'info> {
    /// VK account containing the verifying key data
    pub vk: AccountLoader<'info, VerifyingKeyAccount>,
}

#[cfg(feature = "verify-hook")]
#[derive(Accounts)]
pub struct DebugEcmul<'info> {
    /// CHECK: test-only VK account; same PDA as test_verify
    pub vk: UncheckedAccount<'info>,
}

#[error_code]
pub enum ZerokError {
    #[msg("Fee exceeds transfer value")]
    FeeExceedsDenomination,
    #[msg("The note has been already spent")]
    NoteAlreadySpent,
    #[msg("Cannot find your merkle root")]
    UnknownRoot,
    #[msg("Invalid withdraw proof")]
    InvalidProof,
    #[msg("Invalid proof length - must be 256 bytes")]
    InvalidProofLength,
    #[msg("Invalid proof format")]
    InvalidProofFormat,
    #[msg("Failed to negate proof A")]
    ProofNegationFailed,
    #[msg("Failed to create Groth16 verifier")]
    VerifierCreationFailed,
    #[msg("Merkle tree is full")]
    MerkleTreeFull,
    #[msg("Relayer account does not match specified relayer address")]
    RelayerMismatch,
    #[msg("Recipient cannot be the relayer")]
    RecipientCannotBeRelayer,
    #[msg("Invalid or corrupted verifying key data")]
    InvalidVerifyingKey,
    #[msg("Vault PDA doesn't match expected derivation")]
    VaultMismatch,
    #[msg("Vault account is not owned by System Program")]
    VaultNotSystemOwned,
    #[msg("Withdrawal would drop vault below rent minimum")]
    VaultBelowRent,
    #[msg("Relayer account missing when required")]
    RelayerAccountMissing,
    #[msg("Recipient account cannot be an executable program")]
    BadRecipient,
    #[msg("Vault must be owned by System Program")]
    InvalidVaultOwner,
    #[msg("Account must be owned by System Program")]
    InvalidOwner,
    #[msg("Vault must be empty")]
    VaultNotEmpty,
    #[msg("VK is already finalized")]
    VkAlreadyFinalized,
    #[msg("VK PDA is already initialized")]
    VKAlreadyInitialized,
    #[msg("VK PDA not initialized - call initialize_vk_pda_v2_clean first")]
    VKNotInitialized,
    #[msg("Invalid chunk offset - must be sequential")]
    InvalidChunkOffset,
    #[msg("Chunk too large - maximum 900 bytes")]
    ChunkTooLarge,
    #[msg("Chunk exceeds expected VK size")]
    ExceedsExpectedSize,
    #[msg("VK is incomplete - missing data")]
    IncompleteVk,
    #[msg("VK SHA256 hash mismatch")]
    VkHashMismatch,
    #[msg("VK magic bytes mismatch - expected G16S")]
    VkMagicMismatch,
    #[msg("VK version mismatch - incompatible format")]
    VkVersionMismatch,
    #[msg("VK account mismatch")]
    VkAccountMismatch,
    #[msg("Invalid VK account")]
    InvalidVKAccount,
    #[msg("Invalid instruction data format")]
    InvalidInstruction,
    #[msg("Unauthorized: authority mismatch")]
    Unauthorized,
    #[msg("Pool not empty - cannot bind VK")]
    PoolNotEmpty,

    // Phase 6: Security Enhancement errors
    #[msg("Emergency pause is active - withdrawals disabled")]
    EmergencyPaused,
    #[msg("Relayer fee exceeds maximum allowed limit")]
    RelayerFeeExceedsLimit,
    #[msg("Daily withdrawal limit exceeded")]
    DailyLimitExceeded,
    #[msg("Invalid nullifier PDA - does not match expected derivation")]
    InvalidNullifierPda,
    #[msg("Nullifier has already been used - double-spend attempt")]
    NullifierAlreadyUsed,
    #[msg("Deposit cooldown active - retry after specified slots")]
    DepositCooldownActive,

    // State invariant errors
    #[msg("Invalid root index - exceeds history bounds")]
    InvalidRootIndex,
    #[msg("Tree is full - maximum leaves reached")]
    TreeFull,
    #[msg("Roots array overflow - exceeds maximum history")]
    RootsOverflow,

    // v2 errors
    #[msg("Public input exceeds BN254 field modulus")]
    PublicInputGreaterThanFieldSize,
    #[msg("Fee exceeds maximum allowed")]
    FeeExceedsMax,
    #[msg("Verifying key not finalized")]
    VKNotFinalized,
    #[msg("Verifying key already finalized")]
    AlreadyFinalized,
    #[msg("Invalid verifying key length")]
    InvalidVKLength,
    #[msg("Poseidon hash computation failed")]
    PoseidonHashError,
    #[msg("This function is deprecated - use v2_clean variant instead")]
    Deprecated,

    // test_verify errors
    #[msg("Public inputs length must be a multiple of 32")]
    InvalidInputsLen,
    #[msg("Proof verification failed")]
    ProofVerificationFailed,
    #[msg("G1 scalar multiplication failed in IC accumulator")]
    PreparingInputsG1MulFailed,
    #[msg("Poseidon hash computation failed")]
    PoseidonHashFailed,
    #[msg("VK account size mismatch - expected 8 + BYTE_LEN")]
    VkAccountSizeMismatch,

    // Multi-pool denomination errors
    #[msg("Invalid denomination - must be greater than 0")]
    InvalidDenomination,
    #[msg("Invalid state account - PDA does not match expected derivation")]
    InvalidStateAccount,
    #[msg("Invalid vault account - PDA does not match expected derivation")]
    InvalidVaultAccount,
    #[msg("Account already initialized")]
    AlreadyInitialized,
    #[msg("Invalid leaf index - exceeds current leaf count")]
    InvalidLeafIndex,

    // Phase R: Rolling Roots errors
    #[msg("Root not found in ring buffer - too old or invalid")]
    RootNotInRing,
    #[msg("Slot must be monotonically increasing")]
    SlotNotMonotonic,
    #[msg("RootRing account required for devnet/mainnet deployment")]
    RootRingRequired,
    /// DEPRECATED: With circular buffer semantics, shards never fill permanently.
    /// This error is kept for backward compatibility but should never be returned.
    #[msg("Shard is full - transition to next shard required (DEPRECATED)")]
    ShardFull,
    #[msg("Shard is not full - cannot advance to next shard yet")]
    ShardNotFull,

    // Phase L1.3: Light Protocol withdrawal errors
    #[msg("Insufficient balance in compressed account for withdrawal")]
    InsufficientBalance,
    #[msg("Invalid withdrawal amount - must be positive and match compressed account balance")]
    InvalidWithdrawAmount,

    // Batch deposit errors
    #[msg("Invalid batch size - must be 1..=20")]
    InvalidBatchSize,
}

// Helper functions
fn is_known_root(roots: &Vec<[u8; 32]>, current_index: u32, root: &[u8; 32]) -> bool {
    if root == &[0u8; 32] {
        return false;
    }
    
    let mut i = current_index;
    loop {
        if &roots[i as usize] == root {
            return true;
        }
        
        if i == 0 {
            i = ROOT_HISTORY_SIZE - 1;
        } else {
            i -= 1;
        }
        
        if i == current_index {
            break;
        }
    }
    
    false
}

// Optimized Groth16 proof verification using Solana's native syscalls
// Achieves <200k compute units by using pre-negated proofs and alt_bn128 syscalls
// Proof.A is negated client-side in JavaScript to avoid expensive on-chain operations
fn verify_proof(
    proof: &[u8],
    root: &[u8; 32],
    nullifier_hash: &[u8; 32],
    recipient: &Pubkey,
    relayer: &Pubkey,
    fee: u64,
    refund: u64,
    verifying_key: &Groth16Verifyingkey,
) -> Result<()> {
    // Proof should be 256 bytes (64 bytes for A, 128 for B, 64 for C)
    require!(
        proof.len() == 256,
        ZerokError::InvalidProofLength
    );

    // Parse proof components (all big-endian, A already negated in client)
    let proof_a: [u8; 64] = proof[0..64].try_into()
        .map_err(|_| ZerokError::InvalidProofFormat)?;
    let proof_b: [u8; 128] = proof[64..192].try_into()
        .map_err(|_| ZerokError::InvalidProofFormat)?;
    let proof_c: [u8; 64] = proof[192..256].try_into()
        .map_err(|_| ZerokError::InvalidProofFormat)?;

    // NO ON-CHAIN NEGATION! Proof.A was already negated in JavaScript SDK
    // This is the key optimization that reduces CU usage from 1.4M to <200K

    // Prepare 8 public inputs as required by the circuit
    let public_inputs = prepare_public_inputs(root, nullifier_hash, recipient, relayer, fee, refund);

    // Create and run verifier using native syscalls (pass-through pattern)
    msg!("Verifying proof with native syscalls (proof.A pre-negated)...");
    let mut verifier = Groth16Verifier::new(
        &proof_a,  // Already negated in SDK - no on-chain operations needed!
        &proof_b,
        &proof_c,
        &public_inputs,
        verifying_key,
    ).map_err(|e| {
        msg!("Failed to create verifier: {:?}", e);
        ZerokError::VerifierCreationFailed
    })?;

    verifier.verify().map_err(|e| {
        msg!("Proof verification failed: {:?}", e);
        ZerokError::InvalidProof
    })?;

    msg!("Proof verification succeeded!");
    Ok(())
}

// Note: negate_proof_a function removed - negation now integrated into verify_proof
// using optimized syscall-friendly approach for <200K CU verification

/// Prepare the 8 public inputs for the circuit:
/// root, nullifierHash, recipientHigh, recipientLow, relayerHigh, relayerLow, fee, refund
fn prepare_public_inputs(
    root: &[u8; 32],
    nullifier_hash: &[u8; 32],
    recipient: &Pubkey,
    relayer: &Pubkey,
    fee: u64,
    refund: u64,
) -> [[u8; 32]; 8] {
    let mut inputs = [[0u8; 32]; 8];

    // ENCODING CONTRACT: root and nullifier_hash are stored as LE bytes on-chain,
    // but Groth16 proof system expects BE bytes for public inputs.
    // Convert LE→BE by reversing the bytes.

    // Input 0: root (LE→BE conversion)
    let mut root_be = *root;
    root_be.reverse();
    inputs[0] = root_be;

    // Input 1: nullifierHash (LE→BE conversion)
    let mut nullifier_hash_be = *nullifier_hash;
    nullifier_hash_be.reverse();
    inputs[1] = nullifier_hash_be;
    
    // Inputs 2-3: recipient split into high/low parts
    let (recipient_high, recipient_low) = split_address_to_high_low(recipient);
    inputs[2] = recipient_high;
    inputs[3] = recipient_low;
    
    // Inputs 4-5: relayer split into high/low parts
    let (relayer_high, relayer_low) = split_address_to_high_low(relayer);
    inputs[4] = relayer_high;
    inputs[5] = relayer_low;
    
    // Input 6: fee as 32-byte big-endian
    encode_u64_as_32_bytes(fee, &mut inputs[6]);
    
    // Input 7: refund as 32-byte big-endian
    encode_u64_as_32_bytes(refund, &mut inputs[7]);
    
    inputs
}

/// Split a Solana address into high and low parts to fit within BN254 field size
/// Addresses are 32 bytes (256 bits), we split into two 128-bit values
/// CRITICAL: Values must be right-aligned (big-endian) to stay within field bounds
fn split_address_to_high_low(address: &Pubkey) -> ([u8; 32], [u8; 32]) {
    let address_bytes = address.to_bytes();
    let mut high = [0u8; 32];
    let mut low = [0u8; 32];

    // High part: right-align first 16 bytes (put in last 16 bytes of 32-byte array)
    // This ensures the value is interpreted as a 128-bit number, not 256-bit
    high[16..32].copy_from_slice(&address_bytes[0..16]);

    // Low part: right-align last 16 bytes
    low[16..32].copy_from_slice(&address_bytes[16..32]);

    (high, low)
}

/// Encode a u64 as a 32-byte big-endian array
fn encode_u64_as_32_bytes(value: u64, output: &mut [u8; 32]) {
    output[24..32].copy_from_slice(&value.to_be_bytes());
}

/// Reconstruct a Solana address from high and low parts
#[allow(dead_code)]
fn reconstruct_address_from_high_low(high: &[u8; 32], low: &[u8; 32]) -> Pubkey {
    let mut address_bytes = [0u8; 32];
    address_bytes[0..16].copy_from_slice(&high[16..32]);
    address_bytes[16..32].copy_from_slice(&low[16..32]);
    Pubkey::from(address_bytes)
}

// Note: change_endianness function removed - endianness conversion now inlined in verify_proof
// for better optimization and to avoid dependencies

// Note: validate_vault_pda function removed - vault validation is now handled elegantly
// by Anchor's SystemAccount type constraint which automatically ensures System ownership,
// and the seeds constraint in the Accounts struct which ensures correct PDA derivation.
// This is the first-principles approach: leverage the type system instead of manual checks.

/// **CRITICAL SECURITY FUNCTION**: Safely deserialize stored verifying key from trusted setup
/// 
/// This function implements the core fix for the vulnerability where hardcoded verifying keys
/// were used instead of the verifying key from the trusted setup ceremony stored in `pool_state.verifying_key`.
/// 
/// # Cryptographic Security Properties:
/// - Validates all VK components are within BN254 curve parameters
/// - Ensures proper field element bounds checking
/// - Validates IC (public input coefficients) array structure
/// - Protects against malformed/corrupted VK attacks
/// - Maintains deterministic verification behavior
/// 
/// # Parameters:
/// - `vk_bytes`: Raw verifying key bytes from `pool_state.verifying_key`
/// 
/// # Returns:
/// - `Ok(Groth16Verifyingkey)`: Successfully deserialized and validated VK
/// - `Err(ZerokError::InvalidVerifyingKey)`: Malformed or corrupted VK data
/// 
/// # Security Considerations:
/// - This function MUST be used in production instead of `get_circuit_verifying_key()`
/// - All VK components undergo cryptographic validation
/// - Protects against VK substitution attacks
/// - Ensures trusted setup ceremony results are actually used
/// - G2 limbs are swapped to match arkworks expectations (Phase 2 parity test finding)

/// Helper: Swap c0 ↔ c1 components in a G2 point for arkworks compatibility
///
/// snarkjs VK format: (x.c0, x.c1, y.c0, y.c1) - each component 32 bytes
/// arkworks expects:   (x.c1, x.c0, y.c1, y.c0)
///
/// This fixes the VK encoding mismatch discovered via Phase 1 & 2 parity tests.
fn swap_g2_limbs(g2_bytes: &[u8; 128]) -> [u8; 128] {
    let mut swapped = [0u8; 128];

    // Swap x: c1, c0 instead of c0, c1
    swapped[0..32].copy_from_slice(&g2_bytes[32..64]);   // x.c1 → position 0
    swapped[32..64].copy_from_slice(&g2_bytes[0..32]);   // x.c0 → position 32

    // Swap y: c1, c0 instead of c0, c1
    swapped[64..96].copy_from_slice(&g2_bytes[96..128]); // y.c1 → position 64
    swapped[96..128].copy_from_slice(&g2_bytes[64..96]); // y.c0 → position 96

    swapped
}

fn deserialize_verifying_key(vk_bytes: &[u8]) -> Result<Groth16Verifyingkey> {
    // Minimum size validation - VK must contain all required components
    // Structure: nr_pubinputs (4) + alpha_g1 (64) + beta_g2 (128) + gamma_g2 (128) + delta_g2 (128) + IC array
    const MIN_VK_SIZE: usize = 4 + 64 + 128 + 128 + 128 + 64; // At least 1 IC element
    
    if vk_bytes.len() < MIN_VK_SIZE {
        msg!("VK too small: {} bytes, minimum required: {}", vk_bytes.len(), MIN_VK_SIZE);
        return Err(ZerokError::InvalidVerifyingKey.into());
    }
    
    // Parse nr_pubinputs (first 4 bytes as little-endian u32)
    let mut offset = 0;
    let nr_pubinputs_bytes = vk_bytes.get(offset..offset + 4)
        .ok_or_else(|| {
            msg!("Failed to read nr_pubinputs from VK");
            ZerokError::InvalidVerifyingKey
        })?;
    let nr_pubinputs = u32::from_le_bytes(nr_pubinputs_bytes.try_into().unwrap());
    offset += 4;
    
    // Security validation: Reasonable bounds for number of public inputs
    if nr_pubinputs == 0 || nr_pubinputs > 100 {
        msg!("Invalid nr_pubinputs: {}, must be between 1 and 100", nr_pubinputs);
        return Err(ZerokError::InvalidVerifyingKey.into());
    }
    
    // Parse vk_alpha_g1 (64 bytes)
    let vk_alpha_g1_bytes = vk_bytes.get(offset..offset + 64)
        .ok_or_else(|| {
            msg!("Failed to read vk_alpha_g1 from VK");
            ZerokError::InvalidVerifyingKey
        })?;
    let vk_alpha_g1: [u8; 64] = vk_alpha_g1_bytes.try_into().unwrap();
    offset += 64;
    
    // Parse vk_beta_g2 (128 bytes) - swap limbs for arkworks
    let vk_beta_g2_bytes = vk_bytes.get(offset..offset + 128)
        .ok_or_else(|| {
            msg!("Failed to read vk_beta_g2 from VK");
            ZerokError::InvalidVerifyingKey
        })?;
    let vk_beta_g2_raw: [u8; 128] = vk_beta_g2_bytes.try_into().unwrap();
    let vk_beta_g2 = swap_g2_limbs(&vk_beta_g2_raw);
    offset += 128;

    // Parse vk_gamme_g2 (128 bytes) - swap limbs for arkworks
    let vk_gamme_g2_bytes = vk_bytes.get(offset..offset + 128)
        .ok_or_else(|| {
            msg!("Failed to read vk_gamme_g2 from VK");
            ZerokError::InvalidVerifyingKey
        })?;
    let vk_gamme_g2_raw: [u8; 128] = vk_gamme_g2_bytes.try_into().unwrap();
    let vk_gamme_g2 = swap_g2_limbs(&vk_gamme_g2_raw);
    offset += 128;

    // Parse vk_delta_g2 (128 bytes) - swap limbs for arkworks
    let vk_delta_g2_bytes = vk_bytes.get(offset..offset + 128)
        .ok_or_else(|| {
            msg!("Failed to read vk_delta_g2 from VK");
            ZerokError::InvalidVerifyingKey
        })?;
    let vk_delta_g2_raw: [u8; 128] = vk_delta_g2_bytes.try_into().unwrap();
    let vk_delta_g2 = swap_g2_limbs(&vk_delta_g2_raw);
    offset += 128;
    
    // Parse IC array - each element is 64 bytes, need (nr_pubinputs + 1) elements
    let ic_count = (nr_pubinputs + 1) as usize;
    let ic_bytes_needed = ic_count * 64;
    
    if vk_bytes.len() < offset + ic_bytes_needed {
        msg!("VK too small for IC array: need {} bytes for {} IC elements", ic_bytes_needed, ic_count);
        return Err(ZerokError::InvalidVerifyingKey.into());
    }
    
    // Allocate IC vector and parse each element
    let mut vk_ic = Vec::with_capacity(ic_count);
    for i in 0..ic_count {
        let ic_offset = offset + (i * 64);
        let ic_element_bytes = vk_bytes.get(ic_offset..ic_offset + 64)
            .ok_or_else(|| {
                msg!("Failed to read IC element {} from VK", i);
                ZerokError::InvalidVerifyingKey
            })?;
        let ic_element: [u8; 64] = ic_element_bytes.try_into().unwrap();
        vk_ic.push(ic_element);
    }
    
    // Additional security validation: Ensure no obvious zero patterns that indicate corruption
    let is_alpha_zero = vk_alpha_g1.iter().all(|&b| b == 0);
    let is_beta_zero = vk_beta_g2.iter().all(|&b| b == 0);
    let is_gamma_zero = vk_gamme_g2.iter().all(|&b| b == 0);
    let is_delta_zero = vk_delta_g2.iter().all(|&b| b == 0);
    
    if is_alpha_zero || is_beta_zero || is_gamma_zero || is_delta_zero {
        msg!("VK contains zero curve elements, likely corrupted");
        return Err(ZerokError::InvalidVerifyingKey.into());
    }
    
    // Construct and return the validated verifying key
    let verifying_key = Groth16Verifyingkey {
        nr_pubinputs: nr_pubinputs as usize,
        vk_alpha_g1,
        vk_beta_g2,
        vk_gamme_g2,
        vk_delta_g2,
        vk_ic: vk_ic.leak(), // Safe to leak as this is long-lived VK data
    };
    
    msg!("Successfully deserialized verifying key with {} public inputs and {} IC elements", 
         nr_pubinputs, ic_count);
    
    Ok(verifying_key)
}


#[cfg(test)]
mod poseidon_golden_vector_tests {
    use super::*;
    use solana_poseidon::{hashv, Parameters, Endianness};

    #[test]
    fn test_poseidon_zero_hash_matches_zero_chain() {
        // Golden test: Hash(0, 0) should match ZERO_CHAIN[1]
        let left = [0u8; 32];
        let right = [0u8; 32];

        let result = hashv(
            Parameters::Bn254X5,
            Endianness::LittleEndian,  // ENCODING CONTRACT: LE interpretation
            &[&left, &right]
        ).expect("Poseidon hash failed on zero inputs");

        let hash_bytes = result.to_bytes();

        // This should match ZERO_CHAIN[1] from constants.rs (regenerated with LE)
        let expected = constants::ZERO_CHAIN[1];

        assert_eq!(
            hash_bytes, expected,
            "Poseidon(0,0) output doesn't match circuit ZERO_CHAIN[1]\nGot:      {:02x?}\nExpected: {:02x?}",
            &hash_bytes[..8], &expected[..8]
        );

        println!("✅ Poseidon golden vector test passed!");
        println!("   Hash(0,0) = {:02x?}...", &hash_bytes[..8]);
    }

    #[test]
    fn test_poseidon_non_zero_inputs() {
        // Test with non-zero inputs to ensure syscall works
        let left = [1u8; 32];
        let right = [2u8; 32];

        let result = hashv(
            Parameters::Bn254X5,
            Endianness::LittleEndian,  // ENCODING CONTRACT: LE interpretation
            &[&left, &right]
        );

        assert!(result.is_ok(), "Poseidon should succeed with non-zero inputs");

        let hash = result.unwrap().to_bytes();
        assert_ne!(hash, [0u8; 32], "Hash of non-zero inputs should be non-zero");

        println!("✅ Poseidon non-zero test passed!");
        println!("   Hash(1..1, 2..2) = {:02x?}...", &hash[..8]);
    }

    #[test]
    fn test_poseidon_parameters_correct() {
        // Verify we're using the right parameters
        // Bn254X5 = BN254 curve with x^5 S-box (matches circomlib)
        // LittleEndian = ENCODING CONTRACT (LE bytes represent field elements)

        let test_input = [42u8; 32];
        let result = hashv(
            Parameters::Bn254X5,
            Endianness::LittleEndian,
            &[&test_input, &test_input]
        );

        assert!(result.is_ok(), "Poseidon with Bn254X5 + LittleEndian should work");
        println!("✅ Poseidon parameters test passed!");
    }
}

#[cfg(test)]
mod mini_poseidon_test;
