//! Clean v2 instructions with ZERO contamination
//! Follows consultant's brief exactly

use anchor_lang::prelude::*;
use crate::state_v2_clean::*;
// Use Solana Poseidon syscall - ~6.5k CU per hash vs 70k manual
use solana_poseidon::{hashv, Parameters, Endianness};
use crate::v2::poseidon_helpers::ZERO_CHAIN_BE;
use crate::ZerokError;
use hex; // For diagnostic digest logging

// Light Protocol integration imports
use light_sdk::{
    account::LightAccount,
    cpi::{
        v2::{CpiAccounts, LightSystemProgramCpi},
        InvokeLightSystemProgram,
        LightCpiInstruction,
    },
    instruction::ValidityProof,
};
use crate::{ZerokCommitment, LIGHT_CPI_SIGNER};

// Sharded root ring imports (K=2560 ring buffer)
use crate::state_root_ring_shard::{RootRingMetadata, RootRingShard};

/// Helper function to invoke Light Protocol deposit CPI
///
/// Separated into its own function to reduce stack usage in main deposit handler.
/// Solana has a 4096-byte stack limit per function, and Light Protocol types are large.
#[inline(never)] // Prevent inlining to keep stack frames separate
fn invoke_light_deposit<'info>(
    program_id: &Pubkey,
    depositor: &AccountInfo<'info>,
    remaining_accounts: &[AccountInfo<'info>],
    light_accounts_offset: u8,
    commitment_be: [u8; 32],
    output_tree_index: u8,
    light_proof_bytes: &[u8],
    denomination: u64,
) -> Result<()> {
    // Validate we have enough accounts for V2 CPI
    // V2 requires minimum 6 system accounts + tree accounts
    const MIN_V2_SYSTEM_ACCOUNTS: usize = 6;
    if remaining_accounts.len() < MIN_V2_SYSTEM_ACCOUNTS {
        msg!("❌ Not enough remaining accounts for Light V2 CPI (need ≥{}, have: {})",
            MIN_V2_SYSTEM_ACCOUNTS, remaining_accounts.len());
        return Err(ZerokError::InvalidInstruction.into());
    }

    // CRITICAL: In Anchor programs, ctx.remaining_accounts contains ONLY accounts
    // AFTER the named struct accounts. The Light system accounts start at index 0
    // of remaining_accounts, NOT at light_accounts_offset.
    //
    // light_accounts_offset (passed from client) indicates where Light accounts
    // start in the FULL account array, but we don't use it for slicing here.
    let cpi_accounts = CpiAccounts::new(
        depositor,
        remaining_accounts,  // ✅ FIX: Don't slice - Light accounts start at index 0
        LIGHT_CPI_SIGNER,
    );

    // Diagnostic logging for V2 account structure verification
    msg!("📋 CPI Account Debug:");
    msg!("  Light accounts offset in full array: {}", light_accounts_offset);
    msg!("  Remaining accounts (all Light accounts): {}", remaining_accounts.len());
    msg!("  Expected V2: ≥6 base + optional + trees");
    msg!("  First 10 accounts:");
    for (i, acc) in remaining_accounts.iter().enumerate().take(10) {
        msg!("    [{}] {}", i, acc.key);
    }

    msg!("✓ Light CPI accounts configured");

    // Create LightAccount wrapper for ZerokCommitment
    // - owner: Our program ID (ZeroK program)
    // - address: Derived from commitment (deterministic, privacy-preserving)
    // - output_tree_index: Which devnet state tree to use (0 = first tree)
    // - lamports: denomination amount (stored in compressed account for withdrawal)

    // CRITICAL: ZeroK uses anonymous deposits (address: None)
    // Light Protocol V2 batched trees support both address-based and anonymous accounts.
    //
    // ⚠️ DEPRECATED EXPERIMENTAL APPROACHES (DO NOT USE - see ARCHITECTURE.md):
    // - new_burn() pattern: FAILED with Error 6018 (requires address field)
    // - new_close() pattern: FAILED with Error 6042 (wrong tree type)
    // Reference: CONSULTANT_REPORT_2025-01-19_LIGHT_WITHDRAWAL_V2_ADDRESSLESS_ACCOUNTS.md
    //
    // CURRENT APPROACH: Use new_read_only() with prove_by_index: false (ZK proof verification)

    msg!("=== Deposit Account Creation ===");
    msg!("Commitment (BE): {:?}", &commitment_be[..8]);
    msg!("Address: None (anonymous ZeroK deposit)");

    let mut zerok_account = LightAccount::<ZerokCommitment>::new_init(
        program_id,
        None,  // Anonymous deposit - no address
        output_tree_index,
    );

    // Set the commitment data (LightAccount derefs to access inner struct fields)
    zerok_account.commitment = commitment_be;

    // ⚠️ CRITICAL: Lamports = 0 because SOL is stored in vault PDA, not compressed account
    // Compressed account is ONLY for commitment storage (proof of deposit)
    // Actual denomination SOL is transferred separately to vault PDA (line 580-593)
    // Withdrawal will also use lamports=0 when consuming this compressed account
    *zerok_account.lamports_mut() = 0;

    // ========== DEBUG: Compute and log the hash that will be stored ==========
    {
        use solana_poseidon::{hashv, Parameters, Endianness};
        use borsh::BorshSerialize;
        use crate::light_state::ZerokCommitment;

        // Step 1: Compute data_hash (same as withdrawal)
        let zerok_commitment = ZerokCommitment { commitment: commitment_be };
        let serialized = zerok_commitment.try_to_vec()
            .map_err(|_| ZerokError::InvalidInstruction)?;
        let data_hash = hashv(
            Parameters::Bn254X5,
            Endianness::BigEndian,
            &[&serialized],
        )
        .map_err(|_| ZerokError::InvalidInstruction)?
        .to_bytes();

        msg!("=== DEPOSIT HASH DEBUG ===");
        msg!("Owner: {:?}", program_id);
        msg!("Lamports: 0");
        msg!("Address: None (anonymous)");
        msg!("Commitment (BE): {:?}", hex::encode(&commitment_be));
        msg!("data_hash (first 8): {:?}", &data_hash[..8]);
        msg!("data_hash (full): {:?}", data_hash);

        // Step 2: We cannot easily replicate the full account hash here because Light SDK
        // uses internal tree state (merkle_tree pubkey, leaf_index) that we don't have access to yet.
        // The Light System Program CPI will compute and store the final account hash.
        // We'll see it in the withdrawal logs when it tries to match.
    }

    msg!("✓ LightAccount created: commitment={:?}, tree_index={}, lamports=0 (commitment-only)",
        hex::encode(&commitment_be), output_tree_index);

    // Deserialize proof from bytes
    // Empty bytes = default/empty proof (for first deposit)
    use borsh::BorshDeserialize;
    let proof = if light_proof_bytes.is_empty() {
        ValidityProof::default()
    } else {
        ValidityProof::try_from_slice(light_proof_bytes)
            .map_err(|_| ZerokError::InvalidInstruction)?
    };

    // Invoke Light System Program CPI
    match LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
        .with_light_account(zerok_account)?
        .invoke(cpi_accounts)
    {
        Ok(_) => {
            msg!("✓ Light Protocol deposit successful - commitment stored in compressed tree");
            Ok(())
        }
        Err(e) => {
            msg!("❌ Light Protocol CPI failed: {:?}", e);

            // PRODUCTION BEHAVIOR: Fail transaction on Light CPI error
            // This ensures state consistency between custom tree and Light tree
            #[cfg(not(feature = "skip-light-verification"))]
            {
                msg!("⚠️ Light CPI error is FATAL in production build");
                msg!("⚠️ Transaction will fail to maintain state consistency");
                return Err(e.into());
            }

            // TEST-ONLY BEHAVIOR: Allow error for testing without Light Protocol
            // ⚠️ WARNING: This branch should NEVER execute in production deployments
            #[cfg(feature = "skip-light-verification")]
            {
                msg!("⚠️ Custom tree deposit succeeded, but Light tree deposit failed");
                msg!("⚠️ Continuing because 'skip-light-verification' feature is enabled (TEST ONLY)");
                msg!("⚠️ This feature must NOT be enabled in production builds!");
                Ok(())
            }
        }
    }
}

/// Event emitted on deposit containing proof data (siblings + root)
/// This is the canonical source of truth for withdrawal witness generation
/// Siblings are captured BEFORE frontier mutation, so they're correct for verification
#[event]
pub struct DepositProofData {
    /// Leaf index assigned to this deposit
    pub leaf_index: u32,
    /// Root after this deposit (matches proof target root)
    pub root_after: [u8; 32],
    /// Siblings array (20 levels, BigEndian format matching Poseidon syscall)
    pub siblings_be: [[u8; 32]; 20],
    /// Path positions (0=LEFT, 1=RIGHT) for verification
    pub positions: [u8; 20],
}

/// Event emitted when a root is pushed to the rolling ring buffer (Phase R)
/// Enables daemon fast-forward logic and operational monitoring
#[event]
pub struct RootRingUpdate {
    /// Root that was pushed
    pub root: [u8; 32],
    /// Slot when root was inserted
    pub slot: u64,
    /// Ring head position after push (index of next write)
    pub head: u32,
}

/// Initialize zerok state (Step 1 of 2)
/// Multi-pool design: denomination in PDA seeds → separate anonymity sets
#[derive(Accounts)]
#[instruction(denomination: u64)]
pub struct InitializeStateV2Clean<'info> {
    /// State PDA derived with denomination - ensures pool isolation
    /// CHECK: PDA derivation verified in handler
    #[account(mut)]
    pub pool_state: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler_initialize_state_v2_clean(
    ctx: Context<InitializeStateV2Clean>,
    denomination: u64,
    max_fee_bps: u16,
) -> Result<()> {
    // Validate denomination
    require!(denomination > 0, ZerokError::InvalidDenomination);

    // Derive state PDA with denomination
    let denomination_bytes = denomination.to_le_bytes();
    let state_seeds = &[ZEROK_STATE_SEED, &denomination_bytes[..]];
    let (expected_state_pda, state_bump) = Pubkey::find_program_address(state_seeds, ctx.program_id);

    // Verify provided account matches expected PDA
    require_keys_eq!(
        ctx.accounts.pool_state.key(),
        expected_state_pda,
        ZerokError::InvalidStateAccount
    );

    // Check account doesn't already exist
    require!(
        ctx.accounts.pool_state.data_is_empty(),
        ZerokError::AlreadyInitialized
    );

    // Create state account
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(ZerokStateV2Clean::SPACE);

    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::system_instruction::create_account(
            ctx.accounts.authority.key,
            &expected_state_pda,
            lamports,
            ZerokStateV2Clean::SPACE as u64,
            ctx.program_id,
        ),
        &[
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.pool_state.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[&[ZEROK_STATE_SEED, &denomination_bytes[..], &[state_bump]]],
    )?;

    // Initialize state data using zero-copy
    let account_info = ctx.accounts.pool_state.to_account_info();
    let mut account_data = account_info.try_borrow_mut_data()?;

    // Write discriminator
    let discriminator = <ZerokStateV2Clean as anchor_lang::Discriminator>::DISCRIMINATOR;
    account_data[0..8].copy_from_slice(&discriminator);

    // Initialize zero-copy struct
    let state_data = &mut account_data[8..8 + ZerokStateV2Clean::SIZE];
    let state: &mut ZerokStateV2Clean = bytemuck::from_bytes_mut(state_data);
    state.initialize(ctx.accounts.authority.key(), denomination, max_fee_bps);

    msg!("Initialized state v2 clean with denomination {} lamports", denomination);
    Ok(())
}

/// Initialize vault (Step 2 of 2)
/// Multi-pool design: vault PDA includes denomination
#[derive(Accounts)]
#[instruction(denomination: u64)]
pub struct InitializeVaultV2Clean<'info> {
    /// CHECK: Vault PDA for holding funds - derived with denomination
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler_initialize_vault_v2_clean(
    ctx: Context<InitializeVaultV2Clean>,
    denomination: u64,
) -> Result<()> {
    // Validate denomination
    require!(denomination > 0, ZerokError::InvalidDenomination);

    // Derive vault PDA with denomination
    let denomination_bytes = denomination.to_le_bytes();
    let vault_seeds = &[VAULT_V2_CLEAN_SEED, &denomination_bytes[..]];
    let (expected_vault_pda, vault_bump) = Pubkey::find_program_address(vault_seeds, ctx.program_id);

    // Verify provided account matches expected PDA
    require_keys_eq!(
        ctx.accounts.vault.key(),
        expected_vault_pda,
        ZerokError::InvalidVaultAccount
    );

    // Check account doesn't already exist
    require!(
        ctx.accounts.vault.data_is_empty(),
        ZerokError::AlreadyInitialized
    );

    // Create vault account (0 space - just a system account for holding lamports)
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(0);

    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::system_instruction::create_account(
            ctx.accounts.authority.key,
            &expected_vault_pda,
            lamports,
            0,
            ctx.program_id,
        ),
        &[
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[&[VAULT_V2_CLEAN_SEED, &denomination_bytes[..], &[vault_bump]]],
    )?;

    msg!("Initialized vault v2 clean for denomination {} lamports", denomination);
    Ok(())
}

/// Deposit with frontier-based merkle tree (NOT levels!)
/// Multi-pool design: state and vault PDAs include denomination
#[derive(Accounts)]
pub struct DepositV2Clean<'info> {
    /// State account - PDA derived with denomination
    /// CHECK: PDA validation happens in handler by reading denomination from state
    #[account(mut)]
    pub pool_state: UncheckedAccount<'info>,

    /// CHECK: Vault PDA - validated in handler
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    pub system_program: Program<'info, System>,

    /// Pool cooldown configuration (optional - None/program ID for backward compatibility)
    /// CHECK: Manual PDA validation in handler if provided (not program ID)
    pub cooldown_config: UncheckedAccount<'info>,

    /// User cooldown tracking (optional - None/program ID for backward compatibility)
    /// CHECK: Manual PDA validation and init in handler if provided (not program ID)
    pub user_cooldown: UncheckedAccount<'info>,

    /// Phase R: Rolling root ring buffer (DEPRECATED - for backward compatibility only)
    /// CHECK: If provided and not program ID, must be valid RootRing PDA
    /// NOTE: This is the legacy K=128 ring. New deposits use sharded ring below.
    #[account(mut)]
    pub root_ring: UncheckedAccount<'info>,

    /// Phase R-Sharded: Sharded root ring metadata (K=2560)
    /// CHECK: PDA validated in handler - seeds = ["root_ring_metadata", state_key]
    #[account(mut)]
    pub root_ring_metadata: UncheckedAccount<'info>,

    /// Active shard for writing (determined by metadata.active_shard_index)
    /// CHECK: PDA validated in handler - seeds = ["root_ring_shard", state_key, shard_index]
    #[account(mut)]
    pub active_shard: UncheckedAccount<'info>,

    // ═══════════════════════════════════════════════════════════
    // LIGHT PROTOCOL INTEGRATION (Phase L0 - Shadow Deposits)
    // ═══════════════════════════════════════════════════════════
    // These accounts are passed through to Light System Program CPI.
    // They are OPTIONAL - if light_enabled is false, these should be program ID.
    // Light SDK will validate these accounts during CPI.
    //
    // Remaining accounts must be passed in this order (starting at light_accounts_offset):
    // [0] Light System Program
    // [1] Account Compression Program
    // [2] Registered Program PDA (for ZeroK)
    // [3] Noop Program
    // [4] Self Program (for CPI context)
    // [5] CPI Authority PDA
    // [6] State Tree (Merkle tree for commitments)
    // [7] Nullifier Queue
    // [8] Address Merkle Tree (not used for ZeroK, but required by Light SDK)
    // [9] Address Queue (not used for ZeroK, but required by Light SDK)
    //
    // Note: Light SDK's CpiAccounts::try_new_with_config will parse these automatically.
}

pub fn handler_deposit_v2_clean<'info>(
    ctx: Context<'_, '_, '_, 'info, DepositV2Clean<'info>>,
    commitment_be: [u8; 32],
    // Light Protocol integration parameters (Phase L0)
    light_enabled: bool,              // If true, also write to Light tree
    light_proof_bytes: Vec<u8>,       // Light Protocol proof bytes (empty vec for first deposit)
    output_tree_index: u8,            // Which devnet state tree to use (0 = first tree)
    light_accounts_offset: u8,        // Offset in remaining_accounts where Light accounts start
) -> Result<()> {
    // Extract references early to help borrow checker with lifetimes
    let depositor_info = ctx.accounts.depositor.as_ref();
    let remaining_accounts = ctx.remaining_accounts;
    let program_id = ctx.program_id;

    // Validate state account exists and is correct type
    require_eq!(
        ctx.accounts.pool_state.owner,
        program_id,
        ZerokError::InvalidOwner
    );

    // Load state (read-only for validations)
    let account_data = ctx.accounts.pool_state.try_borrow_data()?;
    let discriminator = <ZerokStateV2Clean as anchor_lang::Discriminator>::DISCRIMINATOR;
    require!(
        account_data.len() >= 8 + ZerokStateV2Clean::SIZE && &account_data[0..8] == discriminator,
        ZerokError::InvalidStateAccount
    );

    let state: &ZerokStateV2Clean = bytemuck::from_bytes(&account_data[8..8 + ZerokStateV2Clean::SIZE]);
    let denomination = state.denomination;

    // Validate state PDA matches denomination
    let denomination_bytes = denomination.to_le_bytes();
    let (expected_state_pda, _) = Pubkey::find_program_address(
        &[ZEROK_STATE_SEED, &denomination_bytes[..]],
        ctx.program_id
    );
    require_keys_eq!(
        ctx.accounts.pool_state.key(),
        expected_state_pda,
        ZerokError::InvalidStateAccount
    );

    // Validate vault PDA matches denomination
    let (expected_vault_pda, _) = Pubkey::find_program_address(
        &[VAULT_V2_CLEAN_SEED, &denomination_bytes[..]],
        ctx.program_id
    );
    require_keys_eq!(
        ctx.accounts.vault.key(),
        expected_vault_pda,
        ZerokError::InvalidVaultAccount
    );

    // Check pool is not paused
    require!(!state.is_paused(), ZerokError::EmergencyPaused);

    // Check deposit cooldown (if cooldown accounts provided - not program ID)
    // Skip if either account is program ID (backward compatibility)
    if ctx.accounts.cooldown_config.key() != *ctx.program_id {
        // Cooldown config provided - check if enabled
        let config_data = ctx.accounts.cooldown_config.try_borrow_data()?;

        // Verify account is owned by program
        require_eq!(
            ctx.accounts.cooldown_config.owner,
            ctx.program_id,
            ZerokError::InvalidOwner
        );

        // Deserialize config (8-byte discriminator + Pubkey + u64 + bool)
        require!(config_data.len() >= 49, ZerokError::InvalidOwner);

        let enabled = config_data[48] != 0;

        if enabled {
            let cooldown_slots = u64::from_le_bytes([
                config_data[40], config_data[41], config_data[42], config_data[43],
                config_data[44], config_data[45], config_data[46], config_data[47],
            ]);

            if cooldown_slots > 0 {
                msg!("Cooldown active: {} slots (~{}s)", cooldown_slots, (cooldown_slots as f64 * 0.4));

                // ═══════════════════════════════════════════════════════════
                // USER COOLDOWN TRACKING (Per-User Enforcement)
                // ═══════════════════════════════════════════════════════════

                // Check if user_cooldown account is provided (not program ID)
                if ctx.accounts.user_cooldown.key() != *ctx.program_id {
                    let current_slot = Clock::get()?.slot;
                    let state_key = ctx.accounts.pool_state.key();
                    let depositor_key = ctx.accounts.depositor.key();

                    // Derive expected user cooldown PDA
                    let user_cooldown_seeds = &[
                        USER_COOLDOWN_SEED,
                        state_key.as_ref(),
                        depositor_key.as_ref(),
                    ];
                    let (expected_user_cooldown_pda, user_cooldown_bump) =
                        Pubkey::find_program_address(user_cooldown_seeds, ctx.program_id);

                    // Verify provided account matches expected PDA
                    require_keys_eq!(
                        ctx.accounts.user_cooldown.key(),
                        expected_user_cooldown_pda,
                        ZerokError::InvalidOwner
                    );

                    // Check if user_cooldown PDA exists
                    if ctx.accounts.user_cooldown.data_is_empty() {
                        // First deposit for this user - create PDA
                        // Verify account is owned by system program (safe to create)
                        require!(
                            *ctx.accounts.user_cooldown.owner == anchor_lang::solana_program::system_program::ID,
                            ZerokError::InvalidOwner
                        );

                        // Calculate rent for user cooldown account
                        let rent = Rent::get()?;
                        let lamports = rent.minimum_balance(UserDepositCooldown::SPACE);

                        // Create user cooldown account
                        anchor_lang::solana_program::program::invoke_signed(
                            &anchor_lang::solana_program::system_instruction::create_account(
                                ctx.accounts.depositor.key,
                                &expected_user_cooldown_pda,
                                lamports,
                                UserDepositCooldown::SPACE as u64,
                                ctx.program_id,
                            ),
                            &[
                                ctx.accounts.depositor.to_account_info(),
                                ctx.accounts.user_cooldown.to_account_info(),
                                ctx.accounts.system_program.to_account_info(),
                            ],
                            &[&[
                                USER_COOLDOWN_SEED,
                                state_key.as_ref(),
                                depositor_key.as_ref(),
                                &[user_cooldown_bump],
                            ]],
                        )?;

                        // Initialize with current slot (first deposit always succeeds)
                        let mut user_cooldown_data = ctx.accounts.user_cooldown.try_borrow_mut_data()?;

                        // Write discriminator
                        let discriminator = <UserDepositCooldown as anchor_lang::Discriminator>::DISCRIMINATOR;
                        user_cooldown_data[0..8].copy_from_slice(&discriminator);

                        // Write last_slot = current_slot (8 bytes, little-endian)
                        user_cooldown_data[8..16].copy_from_slice(&current_slot.to_le_bytes());

                        msg!("✓ User cooldown PDA created (first deposit, slot={})", current_slot);
                    } else {
                        // Existing user - check cooldown
                        require_eq!(
                            ctx.accounts.user_cooldown.owner,
                            ctx.program_id,
                            ZerokError::InvalidOwner
                        );

                        let user_cooldown_data = ctx.accounts.user_cooldown.try_borrow_data()?;

                        // Verify discriminator
                        let discriminator = <UserDepositCooldown as anchor_lang::Discriminator>::DISCRIMINATOR;
                        require!(
                            user_cooldown_data.len() >= UserDepositCooldown::SPACE &&
                            &user_cooldown_data[0..8] == discriminator,
                            ZerokError::InvalidOwner
                        );

                        // Read last_slot (bytes 8-16)
                        let last_slot = u64::from_le_bytes([
                            user_cooldown_data[8], user_cooldown_data[9], user_cooldown_data[10], user_cooldown_data[11],
                            user_cooldown_data[12], user_cooldown_data[13], user_cooldown_data[14], user_cooldown_data[15],
                        ]);

                        // Calculate elapsed slots
                        let slots_elapsed = current_slot.saturating_sub(last_slot);

                        // Check if cooldown period has passed
                        if slots_elapsed < cooldown_slots {
                            let remaining = cooldown_slots - slots_elapsed;
                            msg!("❌ Deposit cooldown active! Wait {} more slots (~{}s)",
                                remaining,
                                (remaining as f64 * 0.4));
                            return Err(ZerokError::DepositCooldownActive.into());
                        }

                        msg!("✓ Cooldown check passed (elapsed: {} slots)", slots_elapsed);
                    }
                }
            }
        }
    }

    // Validate commitment is canonical (< p)
    require!(
        crate::v2::is_canonical_field_element(&commitment_be),
        ZerokError::PublicInputGreaterThanFieldSize
    );

    // Transfer exact denomination to vault
    let leaf_count = state.leaf_count;
    drop(account_data); // Release borrow

    let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
        &ctx.accounts.depositor.key(),
        &ctx.accounts.vault.key(),
        denomination,
    );

    anchor_lang::solana_program::program::invoke(
        &transfer_ix,
        &[
            ctx.accounts.depositor.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;

    // Load state mutably for merkle tree updates
    let mut account_data_mut = ctx.accounts.pool_state.try_borrow_mut_data()?;
    let state: &mut ZerokStateV2Clean = bytemuck::from_bytes_mut(&mut account_data_mut[8..8 + ZerokStateV2Clean::SIZE]);

    // Extract denomination for later use (before dropping account_data_mut)
    let denomination = state.denomination;

    // ═══════════════════════════════════════════════════════════
    // CAPTURE SIBLINGS BEFORE FRONTIER MUTATION
    // ═══════════════════════════════════════════════════════════
    // This is where the facts are true: frontier contains PRE-deposit values
    // These are the correct siblings for verifying this leaf later

    let mut siblings_be = [[0u8; 32]; 20];
    let mut positions = [0u8; 20];
    let mut idx_sibling = leaf_count;

    for level in 0..20 {
        if (idx_sibling & 1) == 0 {
            // LEFT child: sibling is to the RIGHT (from zero chain)
            siblings_be[level] = ZERO_CHAIN_BE[level];
            positions[level] = 0;
        } else {
            // RIGHT child: sibling is to the LEFT (from frontier)
            siblings_be[level] = state.merkle_frontier[level];
            positions[level] = 1;
        }
        idx_sibling >>= 1;
    }

    // ═══════════════════════════════════════════════════════════
    // UPDATE FRONTIER-BASED MERKLE TREE
    // ═══════════════════════════════════════════════════════════

    let mut node_be = commitment_be;
    let mut idx = leaf_count;

    // Hash with syscall - ~6.5k CU per hash (vs 70k manual)
    for level in 0..20 {
        let (left, right) = if (idx & 1) == 0 {
            // Right edge: use precomputed zero
            (node_be, ZERO_CHAIN_BE[level])
        } else {
            // Not right edge: use stored frontier
            (state.merkle_frontier[level], node_be)
        };

        // Poseidon syscall: BN254, x^5, BigEndian (matches Circom)
        node_be = hashv(
            Parameters::Bn254X5,
            Endianness::BigEndian,
            &[&left, &right]
        )
        .map_err(|_| ZerokError::PoseidonHashError)?
        .to_bytes();

        // Update frontier
        state.merkle_frontier[level] = node_be;
        idx >>= 1;
    }

    // Update root and history
    state.current_root = node_be;
    let next_idx = state.next_root_index();
    state.root_history[next_idx] = node_be;
    state.root_index = next_idx as u32;
    state.leaf_count += 1;

    msg!("Deposit #{} complete, new root: {:?}", state.leaf_count, hex::encode(&node_be));

    // Release mutable state borrow before Light CPI
    drop(account_data_mut);

    // ═══════════════════════════════════════════════════════════
    // LIGHT PROTOCOL CPI (Phase L0 - Shadow Deposits)
    // ═══════════════════════════════════════════════════════════
    // Write commitment to BOTH trees during Phase L0:
    // 1. Custom tree (above) - maintains existing functionality
    // 2. Light tree (below) - new compressed state tree for migration
    //
    // This dual-tree approach enables zero-downtime migration:
    // - Existing withdrawals continue using custom tree
    // - New features can gradually switch to Light tree
    // - Full backward compatibility maintained

    if light_enabled {
        msg!("✓ Custom tree deposit complete, writing to Light tree...");

        // Invoke Light Protocol deposit via helper function
        // Separated to reduce stack usage (Solana 4KB stack limit)
        invoke_light_deposit(
            program_id,
            depositor_info,
            remaining_accounts,
            light_accounts_offset,
            commitment_be,
            output_tree_index,
            &light_proof_bytes,
            denomination,
        )?;
    } else {
        msg!("✓ Light Protocol integration disabled - skipping Light tree deposit");
    }

    // Re-borrow state mutably for root ring operations
    let mut account_data_mut = ctx.accounts.pool_state.try_borrow_mut_data()?;
    let _state: &mut ZerokStateV2Clean = bytemuck::from_bytes_mut(&mut account_data_mut[8..8 + ZerokStateV2Clean::SIZE]);

    // ═══════════════════════════════════════════════════════════
    // PHASE R: PUSH ROOT TO SHARDED RING BUFFER (K=2560)
    // ═══════════════════════════════════════════════════════════
    //
    // The sharded ring provides 20x larger anonymity set (K=2560 vs K=128).
    // Structure: 20 shards × 128 entries = 2560 total capacity
    // Wrap-around: (active_shard_index + 1) % num_shards when shard fills

    // Sharded ring is REQUIRED for all environments (K=2560 capacity)
    #[cfg(not(feature = "localnet-testing"))]
    {
        require!(
            ctx.accounts.root_ring_metadata.key() != *ctx.program_id,
            ZerokError::RootRingRequired
        );
    }

    // If sharded ring provided (not program ID), push root into sharded ring
    if ctx.accounts.root_ring_metadata.key() != *ctx.program_id {
        // 1. Validate metadata PDA: seeds = ["root_ring_metadata", state_key]
        let (expected_metadata_pda, _) = Pubkey::find_program_address(
            &[b"root_ring_metadata", ctx.accounts.pool_state.key().as_ref()],
            ctx.program_id
        );
        require_keys_eq!(
            ctx.accounts.root_ring_metadata.key(),
            expected_metadata_pda,
            ZerokError::InvalidOwner
        );

        // Validate ownership
        require_eq!(
            ctx.accounts.root_ring_metadata.owner,
            ctx.program_id,
            ZerokError::InvalidOwner
        );

        // 2. Load metadata to get active_shard_index
        let metadata_info = ctx.accounts.root_ring_metadata.to_account_info();
        let mut metadata_data = metadata_info.try_borrow_mut_data()?;

        let metadata_discriminator = <RootRingMetadata as anchor_lang::Discriminator>::DISCRIMINATOR;
        require!(
            metadata_data.len() >= 8 + RootRingMetadata::LEN &&
            &metadata_data[0..8] == metadata_discriminator,
            ZerokError::InvalidOwner
        );

        let metadata: &mut RootRingMetadata =
            bytemuck::from_bytes_mut(&mut metadata_data[8..8 + RootRingMetadata::LEN]);

        // 3. Validate active shard PDA matches expected
        let shard_index_bytes = metadata.active_shard_index.to_le_bytes();
        let (expected_shard_pda, _) = Pubkey::find_program_address(
            &[b"root_ring_shard", ctx.accounts.pool_state.key().as_ref(), &shard_index_bytes],
            ctx.program_id
        );
        require_keys_eq!(
            ctx.accounts.active_shard.key(),
            expected_shard_pda,
            ZerokError::InvalidOwner
        );

        // Validate shard ownership
        require_eq!(
            ctx.accounts.active_shard.owner,
            ctx.program_id,
            ZerokError::InvalidOwner
        );

        // 4. Load active shard
        let shard_info = ctx.accounts.active_shard.to_account_info();
        let mut shard_data = shard_info.try_borrow_mut_data()?;

        let shard_discriminator = <RootRingShard as anchor_lang::Discriminator>::DISCRIMINATOR;
        require!(
            shard_data.len() >= 8 + RootRingShard::LEN &&
            &shard_data[0..8] == shard_discriminator,
            ZerokError::InvalidOwner
        );

        let shard: &mut RootRingShard =
            bytemuck::from_bytes_mut(&mut shard_data[8..8 + RootRingShard::LEN]);

        // 5. Push root to shard (circular buffer - never fails due to capacity)
        // With modulo semantics, shards accept unlimited deposits by overwriting oldest entries
        let slot = Clock::get()?.slot;
        shard.push(node_be, slot)?;

        // 7. Update global head (tracks total deposits across all shards)
        metadata.global_head = (metadata.global_head + 1) % metadata.total_capacity;

        msg!("✓ Root pushed to shard {}, local_head={}, global_head={}, slot={}",
            metadata.active_shard_index, shard.local_head, metadata.global_head, slot);

        // 8. Emit event for monitoring
        emit!(RootRingUpdate {
            root: node_be,
            slot,
            head: metadata.global_head,
        });

        // 9. AUTO-ROTATE to next shard when current shard cycle completes
        // This ensures even distribution across all 20 shards automatically
        // The ring wraps around: shard 19 -> shard 0 -> shard 1 -> ... (circular)
        if shard.local_head % metadata.shard_capacity == 0 && shard.local_head > 0 {
            let next_shard = (metadata.active_shard_index + 1) % metadata.num_shards;

            // Rotate to next shard (all 20 shards must be pre-initialized)
            // This is safe because shards use circular buffer semantics - deposits never fail
            if metadata.is_shard_allocated(next_shard) {
                let old_shard = metadata.active_shard_index;
                metadata.active_shard_index = next_shard;
                msg!("✓ Auto-rotated shard: {} -> {} (cycle complete, local_head={})",
                    old_shard, next_shard, shard.local_head);
            } else {
                // Fallback: if next shard not allocated, continue on current shard
                // Circular buffer will overwrite oldest entries
                msg!("⚠️ Shard {} cycle complete but shard {} not allocated. Continuing with circular overwrite.",
                    metadata.active_shard_index, next_shard);
            }
        }
    }

    // Legacy root_ring (K=128) - kept for backward compatibility during migration
    // This will be removed after full migration to sharded ring
    #[cfg(feature = "localnet-testing")]
    if ctx.accounts.root_ring.key() != *ctx.program_id &&
       ctx.accounts.root_ring_metadata.key() == *ctx.program_id {
        // Validate root_ring PDA
        let (expected_root_ring_pda, _) = Pubkey::find_program_address(
            &[b"roots", ctx.accounts.pool_state.key().as_ref()],
            ctx.program_id
        );
        require_keys_eq!(
            ctx.accounts.root_ring.key(),
            expected_root_ring_pda,
            ZerokError::InvalidOwner
        );

        let root_ring_info = ctx.accounts.root_ring.to_account_info();
        let mut root_ring_data = root_ring_info.try_borrow_mut_data()?;

        let discriminator = <crate::state_root_ring::RootRing as anchor_lang::Discriminator>::DISCRIMINATOR;
        require!(
            root_ring_data.len() >= 8 + crate::state_root_ring::RootRing::LEN &&
            &root_ring_data[0..8] == discriminator,
            ZerokError::InvalidOwner
        );

        let ring: &mut crate::state_root_ring::RootRing =
            bytemuck::from_bytes_mut(&mut root_ring_data[8..8 + crate::state_root_ring::RootRing::LEN]);

        let slot = Clock::get()?.slot;
        ring.push(node_be, slot)?;

        msg!("✓ [LEGACY] Root pushed to non-sharded ring: index={}, slot={}", ring.head.wrapping_sub(1), slot);

        emit!(RootRingUpdate {
            root: node_be,
            slot,
            head: ring.head,
        });
    }

    // ═══════════════════════════════════════════════════════════
    // EMIT DEPOSIT PROOF DATA EVENT
    // ═══════════════════════════════════════════════════════════
    // The transaction log now contains the immutable source of truth
    // for witness generation: siblings that reconstruct root_after

    emit!(DepositProofData {
        leaf_index: leaf_count,
        root_after: node_be,
        siblings_be,
        positions,
    });

    // ═══════════════════════════════════════════════════════════
    // UPDATE USER COOLDOWN TIMESTAMP (After Successful Deposit)
    // ═══════════════════════════════════════════════════════════
    // Update last_slot ONLY if cooldown is active (both accounts provided)
    if ctx.accounts.cooldown_config.key() != *ctx.program_id &&
       ctx.accounts.user_cooldown.key() != *ctx.program_id {
        let current_slot = Clock::get()?.slot;
        let mut user_cooldown_data = ctx.accounts.user_cooldown.try_borrow_mut_data()?;
        user_cooldown_data[8..16].copy_from_slice(&current_slot.to_le_bytes());
        msg!("✓ User cooldown updated (last_slot = {})", current_slot);
    }

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// BATCH DEPOSIT — accepts Vec<[u8; 32]> commitments in one instruction
// ═══════════════════════════════════════════════════════════════════════════
// State-equivalent to calling deposit_v2_clean N times sequentially.
// No Light Protocol for batch v1. Same-pool only.

pub const MAX_BATCH_SIZE: usize = 20;

/// Batch deposit accounts — same pool accounts as single deposit
/// remaining_accounts[0] = next shard PDA (for mid-batch shard rotation)
#[derive(Accounts)]
pub struct DepositBatchV2Clean<'info> {
    /// State account - PDA derived with denomination
    /// CHECK: PDA validation happens in handler
    #[account(mut)]
    pub pool_state: UncheckedAccount<'info>,

    /// CHECK: Vault PDA - validated in handler
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    pub system_program: Program<'info, System>,

    /// Pool cooldown configuration (optional - program ID to skip)
    /// CHECK: Manual PDA validation in handler if provided
    pub cooldown_config: UncheckedAccount<'info>,

    /// User cooldown tracking (optional - program ID to skip)
    /// CHECK: Manual PDA validation in handler if provided
    pub user_cooldown: UncheckedAccount<'info>,

    /// Legacy root ring (unused in batch, pass program ID)
    /// CHECK: Ignored in batch handler
    #[account(mut)]
    pub root_ring: UncheckedAccount<'info>,

    /// Sharded root ring metadata (K=2560)
    /// CHECK: PDA validated in handler
    #[account(mut)]
    pub root_ring_metadata: UncheckedAccount<'info>,

    /// Active shard for writing
    /// CHECK: PDA validated in handler
    #[account(mut)]
    pub active_shard: UncheckedAccount<'info>,
}

pub fn handler_deposit_batch_v2_clean<'info>(
    ctx: Context<'_, '_, '_, 'info, DepositBatchV2Clean<'info>>,
    commitments_be: Vec<[u8; 32]>,
) -> Result<()> {
    let batch_size = commitments_be.len();
    let remaining_accounts = ctx.remaining_accounts;
    let program_id = ctx.program_id;

    // ═══════════════════════════════════════════════════════════
    // VALIDATE BATCH SIZE
    // ═══════════════════════════════════════════════════════════
    require!(
        batch_size > 0 && batch_size <= MAX_BATCH_SIZE,
        ZerokError::InvalidBatchSize
    );

    // ═══════════════════════════════════════════════════════════
    // VALIDATE ACCOUNTS (ONCE)
    // ═══════════════════════════════════════════════════════════
    require_eq!(
        ctx.accounts.pool_state.owner,
        program_id,
        ZerokError::InvalidOwner
    );

    let account_data = ctx.accounts.pool_state.try_borrow_data()?;
    let discriminator = <ZerokStateV2Clean as anchor_lang::Discriminator>::DISCRIMINATOR;
    require!(
        account_data.len() >= 8 + ZerokStateV2Clean::SIZE && &account_data[0..8] == discriminator,
        ZerokError::InvalidStateAccount
    );

    let state: &ZerokStateV2Clean = bytemuck::from_bytes(&account_data[8..8 + ZerokStateV2Clean::SIZE]);
    let denomination = state.denomination;
    let leaf_count_start = state.leaf_count;

    // Validate state PDA
    let denomination_bytes = denomination.to_le_bytes();
    let (expected_state_pda, _) = Pubkey::find_program_address(
        &[ZEROK_STATE_SEED, &denomination_bytes[..]],
        program_id
    );
    require_keys_eq!(
        ctx.accounts.pool_state.key(),
        expected_state_pda,
        ZerokError::InvalidStateAccount
    );

    // Validate vault PDA
    let (expected_vault_pda, _) = Pubkey::find_program_address(
        &[VAULT_V2_CLEAN_SEED, &denomination_bytes[..]],
        program_id
    );
    require_keys_eq!(
        ctx.accounts.vault.key(),
        expected_vault_pda,
        ZerokError::InvalidVaultAccount
    );

    // Check pool not paused
    require!(!state.is_paused(), ZerokError::EmergencyPaused);

    // Check tree capacity
    require!(
        (leaf_count_start as u64) + (batch_size as u64) <= (1u64 << 20),
        ZerokError::MerkleTreeFull
    );

    drop(account_data);

    // ═══════════════════════════════════════════════════════════
    // COOLDOWN CHECK (ONCE)
    // ═══════════════════════════════════════════════════════════
    if ctx.accounts.cooldown_config.key() != *program_id {
        let config_data = ctx.accounts.cooldown_config.try_borrow_data()?;
        require_eq!(
            ctx.accounts.cooldown_config.owner,
            program_id,
            ZerokError::InvalidOwner
        );
        require!(config_data.len() >= 49, ZerokError::InvalidOwner);

        let enabled = config_data[48] != 0;
        if enabled {
            let cooldown_slots = u64::from_le_bytes([
                config_data[40], config_data[41], config_data[42], config_data[43],
                config_data[44], config_data[45], config_data[46], config_data[47],
            ]);

            if cooldown_slots > 0 && ctx.accounts.user_cooldown.key() != *program_id {
                let current_slot = Clock::get()?.slot;
                let state_key = ctx.accounts.pool_state.key();
                let depositor_key = ctx.accounts.depositor.key();

                let user_cooldown_seeds = &[
                    USER_COOLDOWN_SEED,
                    state_key.as_ref(),
                    depositor_key.as_ref(),
                ];
                let (expected_user_cooldown_pda, user_cooldown_bump) =
                    Pubkey::find_program_address(user_cooldown_seeds, program_id);
                require_keys_eq!(
                    ctx.accounts.user_cooldown.key(),
                    expected_user_cooldown_pda,
                    ZerokError::InvalidOwner
                );

                if ctx.accounts.user_cooldown.data_is_empty() {
                    require!(
                        *ctx.accounts.user_cooldown.owner == anchor_lang::solana_program::system_program::ID,
                        ZerokError::InvalidOwner
                    );
                    let rent = Rent::get()?;
                    let lamports = rent.minimum_balance(UserDepositCooldown::SPACE);
                    anchor_lang::solana_program::program::invoke_signed(
                        &anchor_lang::solana_program::system_instruction::create_account(
                            ctx.accounts.depositor.key,
                            &expected_user_cooldown_pda,
                            lamports,
                            UserDepositCooldown::SPACE as u64,
                            program_id,
                        ),
                        &[
                            ctx.accounts.depositor.to_account_info(),
                            ctx.accounts.user_cooldown.to_account_info(),
                            ctx.accounts.system_program.to_account_info(),
                        ],
                        &[&[
                            USER_COOLDOWN_SEED,
                            state_key.as_ref(),
                            depositor_key.as_ref(),
                            &[user_cooldown_bump],
                        ]],
                    )?;
                    let mut user_cooldown_data = ctx.accounts.user_cooldown.try_borrow_mut_data()?;
                    let cd_disc = <UserDepositCooldown as anchor_lang::Discriminator>::DISCRIMINATOR;
                    user_cooldown_data[0..8].copy_from_slice(&cd_disc);
                    user_cooldown_data[8..16].copy_from_slice(&current_slot.to_le_bytes());
                } else {
                    require_eq!(
                        ctx.accounts.user_cooldown.owner,
                        program_id,
                        ZerokError::InvalidOwner
                    );
                    let user_cooldown_data = ctx.accounts.user_cooldown.try_borrow_data()?;
                    let cd_disc = <UserDepositCooldown as anchor_lang::Discriminator>::DISCRIMINATOR;
                    require!(
                        user_cooldown_data.len() >= UserDepositCooldown::SPACE &&
                        &user_cooldown_data[0..8] == cd_disc,
                        ZerokError::InvalidOwner
                    );
                    let last_slot = u64::from_le_bytes([
                        user_cooldown_data[8], user_cooldown_data[9], user_cooldown_data[10], user_cooldown_data[11],
                        user_cooldown_data[12], user_cooldown_data[13], user_cooldown_data[14], user_cooldown_data[15],
                    ]);
                    let slots_elapsed = current_slot.saturating_sub(last_slot);
                    if slots_elapsed < cooldown_slots {
                        let remaining = cooldown_slots - slots_elapsed;
                        msg!("Batch deposit cooldown active! Wait {} more slots", remaining);
                        return Err(ZerokError::DepositCooldownActive.into());
                    }
                }
            }
        }
        drop(config_data);
    }

    // ═══════════════════════════════════════════════════════════
    // VALIDATE ALL COMMITMENTS (ONCE)
    // ═══════════════════════════════════════════════════════════
    for commitment in &commitments_be {
        require!(
            crate::v2::is_canonical_field_element(commitment),
            ZerokError::PublicInputGreaterThanFieldSize
        );
    }

    // ═══════════════════════════════════════════════════════════
    // TRANSFER SOL (ONCE) — denomination * batch_size
    // ═══════════════════════════════════════════════════════════
    let total_transfer = denomination
        .checked_mul(batch_size as u64)
        .ok_or(ZerokError::InvalidInstruction)?;

    let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
        &ctx.accounts.depositor.key(),
        &ctx.accounts.vault.key(),
        total_transfer,
    );
    anchor_lang::solana_program::program::invoke(
        &transfer_ix,
        &[
            ctx.accounts.depositor.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;

    msg!("Batch deposit: {} commitments, {} lamports total", batch_size, total_transfer);

    // ═══════════════════════════════════════════════════════════
    // VALIDATE SHARDED RING (ONCE)
    // ═══════════════════════════════════════════════════════════
    let state_key = ctx.accounts.pool_state.key();

    // Metadata PDA validation
    let (expected_metadata_pda, _) = Pubkey::find_program_address(
        &[b"root_ring_metadata", state_key.as_ref()],
        program_id
    );
    require_keys_eq!(
        ctx.accounts.root_ring_metadata.key(),
        expected_metadata_pda,
        ZerokError::InvalidOwner
    );
    require_eq!(
        ctx.accounts.root_ring_metadata.owner,
        program_id,
        ZerokError::InvalidOwner
    );

    // Active shard PDA validation (read metadata to get active_shard_index)
    {
        let metadata_data = ctx.accounts.root_ring_metadata.try_borrow_data()?;
        let metadata_discriminator = <RootRingMetadata as anchor_lang::Discriminator>::DISCRIMINATOR;
        require!(
            metadata_data.len() >= 8 + RootRingMetadata::LEN &&
            &metadata_data[0..8] == metadata_discriminator,
            ZerokError::InvalidOwner
        );
        let metadata: &RootRingMetadata = bytemuck::from_bytes(&metadata_data[8..8 + RootRingMetadata::LEN]);
        let shard_index_bytes = metadata.active_shard_index.to_le_bytes();
        let (expected_shard_pda, _) = Pubkey::find_program_address(
            &[b"root_ring_shard", state_key.as_ref(), &shard_index_bytes],
            program_id
        );
        require_keys_eq!(
            ctx.accounts.active_shard.key(),
            expected_shard_pda,
            ZerokError::InvalidOwner
        );
        require_eq!(
            ctx.accounts.active_shard.owner,
            program_id,
            ZerokError::InvalidOwner
        );
    }

    // ═══════════════════════════════════════════════════════════
    // LOOP: MERKLE INSERTION + SHARD PUSH + EVENT EMIT
    // ═══════════════════════════════════════════════════════════
    let mut rotated = false;
    let mut next_shard_validated = false;

    for (i, commitment_be) in commitments_be.iter().enumerate() {
        // --- A. MERKLE INSERTION (borrow pool_state) ---
        let (node_be, leaf_count, siblings_be, positions) = {
            let mut account_data_mut = ctx.accounts.pool_state.try_borrow_mut_data()?;
            let state: &mut ZerokStateV2Clean = bytemuck::from_bytes_mut(
                &mut account_data_mut[8..8 + ZerokStateV2Clean::SIZE]
            );

            let leaf_count = state.leaf_count;

            // Capture siblings BEFORE frontier mutation
            let mut siblings_be = [[0u8; 32]; 20];
            let mut positions = [0u8; 20];
            let mut idx_sibling = leaf_count;
            for level in 0..20 {
                if (idx_sibling & 1) == 0 {
                    siblings_be[level] = ZERO_CHAIN_BE[level];
                    positions[level] = 0;
                } else {
                    siblings_be[level] = state.merkle_frontier[level];
                    positions[level] = 1;
                }
                idx_sibling >>= 1;
            }

            // Update frontier-based Merkle tree
            let mut node_be = *commitment_be;
            let mut idx = leaf_count;
            for level in 0..20 {
                let (left, right) = if (idx & 1) == 0 {
                    (node_be, ZERO_CHAIN_BE[level])
                } else {
                    (state.merkle_frontier[level], node_be)
                };
                node_be = hashv(
                    Parameters::Bn254X5,
                    Endianness::BigEndian,
                    &[&left, &right]
                )
                .map_err(|_| ZerokError::PoseidonHashError)?
                .to_bytes();
                state.merkle_frontier[level] = node_be;
                idx >>= 1;
            }

            // Update root and history
            state.current_root = node_be;
            let next_idx = state.next_root_index();
            state.root_history[next_idx] = node_be;
            state.root_index = next_idx as u32;
            state.leaf_count += 1;

            (node_be, leaf_count, siblings_be, positions)
        }; // pool_state borrow dropped

        // --- B. SHARD PUSH (borrow metadata + shard) ---
        {
            let metadata_info = ctx.accounts.root_ring_metadata.to_account_info();
            let mut metadata_data = metadata_info.try_borrow_mut_data()?;
            let metadata: &mut RootRingMetadata = bytemuck::from_bytes_mut(
                &mut metadata_data[8..8 + RootRingMetadata::LEN]
            );

            // Choose the correct shard account
            let shard_info = if !rotated {
                ctx.accounts.active_shard.to_account_info()
            } else {
                // Validate next shard PDA on first use after rotation
                if !next_shard_validated {
                    require!(
                        !remaining_accounts.is_empty(),
                        ZerokError::InvalidOwner
                    );
                    let next_shard_index = metadata.active_shard_index;
                    let next_shard_index_bytes = next_shard_index.to_le_bytes();
                    let (expected_next_shard_pda, _) = Pubkey::find_program_address(
                        &[b"root_ring_shard", state_key.as_ref(), &next_shard_index_bytes],
                        program_id
                    );
                    require_keys_eq!(
                        remaining_accounts[0].key(),
                        expected_next_shard_pda,
                        ZerokError::InvalidOwner
                    );
                    require_eq!(
                        remaining_accounts[0].owner,
                        program_id,
                        ZerokError::InvalidOwner
                    );
                    next_shard_validated = true;
                }
                remaining_accounts[0].clone()
            };

            let mut shard_data = shard_info.try_borrow_mut_data()?;
            let shard_discriminator = <RootRingShard as anchor_lang::Discriminator>::DISCRIMINATOR;
            require!(
                shard_data.len() >= 8 + RootRingShard::LEN &&
                &shard_data[0..8] == shard_discriminator,
                ZerokError::InvalidOwner
            );
            let shard: &mut RootRingShard = bytemuck::from_bytes_mut(
                &mut shard_data[8..8 + RootRingShard::LEN]
            );

            let slot = Clock::get()?.slot;
            shard.push(node_be, slot)?;
            metadata.global_head = (metadata.global_head + 1) % metadata.total_capacity;

            emit!(RootRingUpdate {
                root: node_be,
                slot,
                head: metadata.global_head,
            });

            // Auto-rotate shard if cycle complete
            if shard.local_head % metadata.shard_capacity == 0 && shard.local_head > 0 {
                let next_shard = (metadata.active_shard_index + 1) % metadata.num_shards;
                if metadata.is_shard_allocated(next_shard) {
                    let old_shard = metadata.active_shard_index;
                    metadata.active_shard_index = next_shard;
                    rotated = true;
                    msg!("Batch: shard rotated {} -> {} at commitment {}", old_shard, next_shard, i);
                }
            }
        } // metadata + shard borrows dropped

        // --- C. EMIT DEPOSIT PROOF DATA ---
        emit!(DepositProofData {
            leaf_index: leaf_count,
            root_after: node_be,
            siblings_be,
            positions,
        });
    }

    msg!("Batch deposit complete: {} commitments, leaves {}..{}",
        batch_size, leaf_count_start, leaf_count_start + batch_size as u32 - 1);

    // ═══════════════════════════════════════════════════════════
    // UPDATE COOLDOWN (ONCE, after successful batch)
    // ═══════════════════════════════════════════════════════════
    if ctx.accounts.cooldown_config.key() != *program_id &&
       ctx.accounts.user_cooldown.key() != *program_id {
        let current_slot = Clock::get()?.slot;
        let mut user_cooldown_data = ctx.accounts.user_cooldown.try_borrow_mut_data()?;
        user_cooldown_data[8..16].copy_from_slice(&current_slot.to_le_bytes());
    }

    Ok(())
}

/// Withdrawal - lean accounts pattern
/// Multi-pool design: all PDAs include denomination for pool isolation
#[derive(Accounts)]
pub struct WithdrawV2Clean<'info> {
    /// State PDA - denomination validated in handler
    /// CHECK: PDA validated in handler
    #[account(mut)]
    pub pool_state: UncheckedAccount<'info>,

    /// CHECK: VK PDA - validated in handler (read-only)
    pub vk_pda: UncheckedAccount<'info>,

    /// Nullifier PDA - validated manually in handler
    /// CHECK: PDA derivation verified in handler with require_keys_eq!
    #[account(mut)]
    pub nullifier_record: UncheckedAccount<'info>,

    /// CHECK: Vault PDA - validated in handler
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: Recipient of withdrawn funds - validated in handler
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    /// CHECK: Relayer receiving fee - validated in handler
    #[account(mut)]
    pub relayer: UncheckedAccount<'info>,

    /// Payer for nullifier PDA creation
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,

    /// Phase R: Rolling root ring buffer (DEPRECATED - for backward compatibility only)
    /// CHECK: If provided and not program ID, must be valid RootRing PDA
    /// NOTE: This is the legacy K=128 ring. Use sharded ring (remaining_accounts) for production.
    pub root_ring: UncheckedAccount<'info>,

    /// Phase R-Sharded: Sharded root ring metadata (K=2560)
    /// CHECK: PDA validated in handler - seeds = ["root_ring_metadata", state_key]
    /// Shard accounts are passed via remaining_accounts for multi-shard root search
    pub root_ring_metadata: UncheckedAccount<'info>,
}

pub fn handler_withdraw_v2_clean(
    ctx: Context<WithdrawV2Clean>,
    nullifier_hash: [u8; 32],
    proof: Vec<u8>,
    root: [u8; 32],
    fee: u64,
    refund: u64,
) -> Result<()> {
    // ═══════════════════════════════════════════════════════════
    // STEP 0: Validate State PDA and Load Denomination
    // ═══════════════════════════════════════════════════════════

    // Validate state account ownership and discriminator
    require_eq!(
        ctx.accounts.pool_state.owner,
        ctx.program_id,
        ZerokError::InvalidOwner
    );

    let account_data = ctx.accounts.pool_state.try_borrow_data()?;
    let discriminator = <ZerokStateV2Clean as anchor_lang::Discriminator>::DISCRIMINATOR;
    require!(
        account_data.len() >= 8 + ZerokStateV2Clean::SIZE && &account_data[0..8] == discriminator,
        ZerokError::InvalidStateAccount
    );

    let state: &ZerokStateV2Clean = bytemuck::from_bytes(&account_data[8..8 + ZerokStateV2Clean::SIZE]);
    let denomination = state.denomination;

    // Validate state PDA matches denomination
    let denomination_bytes = denomination.to_le_bytes();
    let state_key = ctx.accounts.pool_state.key();
    let (expected_state_pda, _) = Pubkey::find_program_address(
        &[ZEROK_STATE_SEED, &denomination_bytes[..]],
        ctx.program_id
    );
    require_keys_eq!(
        state_key,
        expected_state_pda,
        ZerokError::InvalidStateAccount
    );

    // Validate vault PDA matches denomination
    let (expected_vault_pda, _) = Pubkey::find_program_address(
        &[VAULT_V2_CLEAN_SEED, &denomination_bytes[..]],
        ctx.program_id
    );
    require_keys_eq!(
        ctx.accounts.vault.key(),
        expected_vault_pda,
        ZerokError::InvalidVaultAccount
    );

    // Validate VK PDA matches denomination
    let (expected_vk_pda, _) = Pubkey::find_program_address(
        &[VK_V2_CLEAN_SEED, &denomination_bytes[..]],
        ctx.program_id
    );
    require_keys_eq!(
        ctx.accounts.vk_pda.key(),
        expected_vk_pda,
        ZerokError::InvalidVKAccount
    );

    // Check pool is not paused
    require!(!state.is_paused(), ZerokError::EmergencyPaused);

    // ═══════════════════════════════════════════════════════════
    // STEP 1: Manual Nullifier PDA Validation
    // ═══════════════════════════════════════════════════════════

    // Derive expected PDA from program-controlled seeds
    // Scoped by state AND denomination to prevent cross-pool collisions
    let nullifier_seeds = &[
        NULLIFIER_V2_CLEAN_SEED,
        state_key.as_ref(),
        nullifier_hash.as_ref(),
    ];
    let (expected_nullifier_pda, nullifier_bump) =
        Pubkey::find_program_address(nullifier_seeds, ctx.program_id);

    // Verify passed account matches expected PDA
    require_keys_eq!(
        expected_nullifier_pda,
        ctx.accounts.nullifier_record.key(),
        ZerokError::InvalidNullifierPda
    );

    // Check if nullifier already exists (double-spend check)
    if !ctx.accounts.nullifier_record.data_is_empty() {
        msg!("Nullifier already used - double-spend attempt");
        return Err(ZerokError::NullifierAlreadyUsed.into());
    }

    // Verify account is owned by system program (safe to create)
    // Mirrors Anchor's init macro safety guarantees
    require!(
        *ctx.accounts.nullifier_record.owner == anchor_lang::solana_program::system_program::ID,
        ZerokError::InvalidOwner
    );

    // ═══════════════════════════════════════════════════════════
    // STEP 2: Validate Withdrawal Parameters
    // ═══════════════════════════════════════════════════════════

    // Phase R: Check root exists in EITHER sharded ring OR legacy history
    let mut root_valid = state.is_known_root(&root);

    // On devnet/mainnet: sharded ring is REQUIRED (K=2560 capacity)
    #[cfg(not(feature = "localnet-testing"))]
    {
        require!(
            ctx.accounts.root_ring_metadata.key() != *ctx.program_id,
            ZerokError::RootRingRequired
        );
    }

    // ═══════════════════════════════════════════════════════════
    // SHARDED ROOT RING SEARCH (K=2560)
    // ═══════════════════════════════════════════════════════════
    // Search across all shards passed in remaining_accounts for the withdrawal root.
    // This enables 20x larger anonymity set compared to legacy K=128 ring.

    if !root_valid && ctx.accounts.root_ring_metadata.key() != *ctx.program_id {
        // Validate metadata PDA
        let (expected_metadata_pda, _) = Pubkey::find_program_address(
            &[b"root_ring_metadata", ctx.accounts.pool_state.key().as_ref()],
            ctx.program_id
        );
        require_keys_eq!(
            ctx.accounts.root_ring_metadata.key(),
            expected_metadata_pda,
            ZerokError::InvalidOwner
        );

        // Load metadata to get shard configuration
        let metadata_info = ctx.accounts.root_ring_metadata.to_account_info();
        let metadata_data = metadata_info.try_borrow_data()?;

        let metadata_discriminator = <RootRingMetadata as anchor_lang::Discriminator>::DISCRIMINATOR;
        require!(
            metadata_data.len() >= 8 + RootRingMetadata::LEN &&
            &metadata_data[0..8] == metadata_discriminator,
            ZerokError::InvalidOwner
        );

        let metadata: &RootRingMetadata =
            bytemuck::from_bytes(&metadata_data[8..8 + RootRingMetadata::LEN]);

        // Search through shard accounts passed in remaining_accounts
        let shard_discriminator = <RootRingShard as anchor_lang::Discriminator>::DISCRIMINATOR;

        for (i, shard_account) in ctx.remaining_accounts.iter().enumerate() {
            if i >= metadata.num_shards as usize {
                break;
            }

            // Validate shard PDA
            let shard_index_bytes = (i as u32).to_le_bytes();
            let (expected_shard_pda, _) = Pubkey::find_program_address(
                &[b"root_ring_shard", ctx.accounts.pool_state.key().as_ref(), &shard_index_bytes],
                ctx.program_id
            );

            if shard_account.key() != expected_shard_pda {
                continue; // Skip invalid shard
            }

            // Load shard and search for root
            let shard_data = match shard_account.try_borrow_data() {
                Ok(data) => data,
                Err(_) => continue,
            };

            if shard_data.len() < 8 + RootRingShard::LEN ||
               &shard_data[0..8] != shard_discriminator {
                continue;
            }

            let shard: &RootRingShard =
                bytemuck::from_bytes(&shard_data[8..8 + RootRingShard::LEN]);

            if shard.contains_root(&root) {
                root_valid = true;
                msg!("✓ Root found in shard {} (sharded ring K=2560)", i);
                break;
            }
        }
    }

    // Legacy root_ring (K=128) fallback - only for localnet backward compatibility
    #[cfg(feature = "localnet-testing")]
    if !root_valid && ctx.accounts.root_ring.key() != *ctx.program_id {
        let (expected_root_ring_pda, _) = Pubkey::find_program_address(
            &[b"roots", ctx.accounts.pool_state.key().as_ref()],
            ctx.program_id
        );
        require_keys_eq!(
            ctx.accounts.root_ring.key(),
            expected_root_ring_pda,
            ZerokError::InvalidOwner
        );

        let root_ring_info = ctx.accounts.root_ring.to_account_info();
        let root_ring_data = root_ring_info.try_borrow_data()?;

        let discriminator = <crate::state_root_ring::RootRing as anchor_lang::Discriminator>::DISCRIMINATOR;
        if root_ring_data.len() >= 8 + crate::state_root_ring::RootRing::LEN &&
           &root_ring_data[0..8] == discriminator {
            let ring: &crate::state_root_ring::RootRing =
                bytemuck::from_bytes(&root_ring_data[8..8 + crate::state_root_ring::RootRing::LEN]);

            root_valid = ring.contains_root(&root);

            if root_valid {
                msg!("✓ [LEGACY] Root validated via K=128 ring buffer");
            }
        }
    }

    // Require root is valid (found in sharded ring, legacy ring, or state history)
    require!(root_valid, ZerokError::RootNotInRing);

    // Validate fee is within allowed range
    let max_fee = state.denomination * (state.max_fee_bps as u64) / 10000;
    require!(fee <= max_fee, ZerokError::FeeExceedsMax);

    // ═══════════════════════════════════════════════════════════
    // STEP 3: Prepare Public Inputs
    // ═══════════════════════════════════════════════════════════

    // Handle relayer (fee can be 0 if no relayer)
    let relayer_key = if fee > 0 {
        ctx.accounts.relayer.key()
    } else {
        Pubkey::default()
    };

    let public_inputs = crate::v2::prepare_public_inputs_v2(
        &root,
        &nullifier_hash,
        &ctx.accounts.recipient.key(),
        &Some(relayer_key),
        fee,
        refund,
    );

    // Validate all public inputs are canonical (< BN254 field modulus)
    crate::v2::validate_public_inputs(&public_inputs)?;

    // ═══════════════════════════════════════════════════════════
    // STEP 4: Verify Zero-Knowledge Proof
    // ═══════════════════════════════════════════════════════════

    require!(state.is_vk_finalized(), ZerokError::VKNotFinalized);

    // VK Integrity Validation - read from PDA using canonical layout
    let vk_pda = &ctx.accounts.vk_pda;
    require_keys_eq!(vk_pda.key(), state.vk_account, ZerokError::VkAccountMismatch);
    require_eq!(vk_pda.owner, ctx.program_id, ZerokError::InvalidOwner);

    let vk_account_data = vk_pda.try_borrow_data()?;
    // Extract VK data (skip 49-byte header, read 1028 bytes)
    let vk_data = crate::vk_layout::vk_data_slice(&vk_account_data)?;

    // Runtime guardrail: Verify VK hash matches state (catches offset drift)
    use anchor_lang::solana_program::hash::hash;
    let computed_vk_hash = hash(vk_data);
    require!(
        computed_vk_hash.to_bytes() == state.vk_hash,
        ZerokError::VkHashMismatch
    );

    // Dynamic VK length validation (supports any number of public inputs)
    // VK format: nr_pubinputs (4) + alpha_g1 (64) + beta_g2 (128) + gamma_g2 (128) + delta_g2 (128) + IC array ((n+1) * 64)
    let vk_tmp = crate::deserialize_verifying_key(vk_data)?;
    msg!("VK deserialize: nr_pubinputs={}", vk_tmp.nr_pubinputs);
    let expected_vk_len = 4 + 64 + 128 + 128 + 128 + ((vk_tmp.nr_pubinputs as usize + 1) * 64);
    require_eq!(vk_data.len(), expected_vk_len, ZerokError::InvalidVKLength);

    // Call verification helper (isolated stack frame)
    crate::v2::verify_withdrawal_proof(
        vk_data,
        &proof,
        &public_inputs,
    )?;

    // ═══════════════════════════════════════════════════════════
    // STEP 5: Create Nullifier PDA
    // ═══════════════════════════════════════════════════════════

    // Calculate rent for nullifier account
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(NullifierV2Clean::SPACE);

    // Create nullifier account with PDA seeds
    let create_account_ix =
        anchor_lang::solana_program::system_instruction::create_account(
            &ctx.accounts.payer.key(),
            &expected_nullifier_pda,
            lamports,
            NullifierV2Clean::SPACE as u64,
            ctx.program_id,
        );

    // Invoke with PDA signer seeds
    anchor_lang::solana_program::program::invoke_signed(
        &create_account_ix,
        &[
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.nullifier_record.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[&[
            NULLIFIER_V2_CLEAN_SEED,
            state_key.as_ref(),
            nullifier_hash.as_ref(),
            &[nullifier_bump],
        ]],
    )?;

    // ═══════════════════════════════════════════════════════════
    // STEP 6: Initialize Nullifier Data
    // ═══════════════════════════════════════════════════════════

    let clock = Clock::get()?;

    let nullifier_data = NullifierV2Clean {
        nullifier_hash,
        spent_at: clock.unix_timestamp,
        spent_slot: clock.slot,
        recipient: ctx.accounts.recipient.key(),
        fee,
    };

    // Manually serialize into account data
    let mut data = ctx.accounts.nullifier_record.try_borrow_mut_data()?;
    nullifier_data.serialize_into(&mut data)?;

    msg!("✓ Nullifier PDA created and initialized");

    // ═══════════════════════════════════════════════════════════
    // STEP 7: Transfer Funds
    // ═══════════════════════════════════════════════════════════

    let recipient_amount = state.denomination - fee;

    // Transfer to recipient
    **ctx.accounts.vault.try_borrow_mut_lamports()? -= recipient_amount;
    **ctx.accounts.recipient.try_borrow_mut_lamports()? += recipient_amount;

    // Transfer fee to relayer if fee > 0
    if fee > 0 {
        **ctx.accounts.vault.try_borrow_mut_lamports()? -= fee;
        **ctx.accounts.relayer.try_borrow_mut_lamports()? += fee;
    }

    msg!(
        "✓ Withdrawal complete: {} lamports to recipient, {} fee to relayer",
        recipient_amount,
        fee
    );

    Ok(())
}

/// Initialize VK PDA (separate from upload to avoid BPF heap limits)
/// Multi-pool design: VK PDA includes denomination
#[derive(Accounts)]
pub struct InitializeVkPdaV2Clean<'info> {
    /// State account - denomination validated in handler
    /// CHECK: PDA validated in handler
    #[account(mut)]
    pub pool_state: UncheckedAccount<'info>,

    /// CHECK: VK PDA - will be created by this instruction
    #[account(mut)]
    pub vk_pda: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler_initialize_vk_pda_v2_clean(
    ctx: Context<InitializeVkPdaV2Clean>,
) -> Result<()> {
    // Load and validate state
    let account_data = ctx.accounts.pool_state.try_borrow_data()?;
    let state: &ZerokStateV2Clean = bytemuck::try_from_bytes(&account_data[8..8 + ZerokStateV2Clean::SIZE])
        .map_err(|_| ZerokError::InvalidStateAccount)?;

    let denomination = state.denomination;
    require!(denomination > 0, ZerokError::InvalidDenomination);

    // Validate denomination-based State PDA
    let denomination_bytes_array = denomination.to_le_bytes();
    let expected_state_pda = Pubkey::find_program_address(
        &[ZEROK_STATE_SEED, &denomination_bytes_array[..]],
        ctx.program_id
    ).0;
    require_keys_eq!(
        ctx.accounts.pool_state.key(),
        expected_state_pda,
        ZerokError::InvalidStateAccount
    );

    // Derive and validate VK PDA
    let expected_vk_pda = Pubkey::find_program_address(
        &[VK_V2_CLEAN_SEED, &denomination_bytes_array[..]],
        ctx.program_id
    ).0;
    require_keys_eq!(
        ctx.accounts.vk_pda.key(),
        expected_vk_pda,
        ZerokError::InvalidVKAccount
    );

    // Validate authority
    require_keys_eq!(
        ctx.accounts.authority.key(),
        state.authority,
        ZerokError::Unauthorized
    );

    // Guards
    require!(!state.is_paused(), ZerokError::EmergencyPaused);
    require!(!state.is_vk_finalized(), ZerokError::AlreadyFinalized);
    require!(
        state.vk_uploaded_bytes == 0,
        ZerokError::VKAlreadyInitialized
    );

    let vk_pda = &ctx.accounts.vk_pda;

    // Check if PDA already exists
    require!(
        vk_pda.data_is_empty(),
        ZerokError::VKAlreadyInitialized
    );

    // Create VK PDA with header + data layout
    // Account layout: 49 bytes header (discriminator + state fields) + 1028 bytes VK data
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(VK_ACCOUNT_SIZE as usize);

    use anchor_lang::solana_program::program::invoke_signed;
    use anchor_lang::solana_program::system_instruction;

    let (_, bump) = Pubkey::find_program_address(
        &[VK_V2_CLEAN_SEED, &denomination_bytes_array[..]],
        ctx.program_id
    );

    invoke_signed(
        &system_instruction::create_account(
            ctx.accounts.authority.key,
            vk_pda.key,
            lamports,
            VK_ACCOUNT_SIZE as u64,
            ctx.program_id,
        ),
        &[
            ctx.accounts.authority.to_account_info(),
            vk_pda.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[&[VK_V2_CLEAN_SEED, &denomination_bytes_array[..], &[bump]]],
    )?;

    msg!(
        "✓ VK PDA initialized: {} (size: {} bytes = {} header + {} data)",
        vk_pda.key(),
        VK_ACCOUNT_SIZE,
        VK_HEADER_BYTES,
        VK_TOTAL_BYTES
    );

    Ok(())
}

/// Upload VK chunk (state machine for large VK)
/// Multi-pool design: VK PDA includes denomination
#[derive(Accounts)]
pub struct UploadVKChunkV2Clean<'info> {
    /// State account - denomination validated in handler
    /// CHECK: PDA validated in handler
    #[account(mut)]
    pub pool_state: UncheckedAccount<'info>,

    /// CHECK: VK PDA - created on first chunk, written incrementally
    #[account(mut)]
    pub vk_pda: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: Instructions sysvar for manual deserialization
    #[account(address = solana_program::sysvar::instructions::ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,
}

pub fn handler_upload_vk_chunk_v2_clean(
    ctx: Context<UploadVKChunkV2Clean>,
) -> Result<()> {
    use crate::state_v2_clean::{VK_TOTAL_BYTES, MAX_VK_CHUNK};
    use solana_program::sysvar::instructions::{load_current_index_checked, load_instruction_at_checked};

    // Manual zero-copy deserialization to avoid BPF heap allocation
    // Data layout: discriminator (8) + offset (2) + chunk_len (2) + chunk_data (variable)
    let instruction_sysvar_account_info = &ctx.accounts.instruction_sysvar;
    let current_index = load_current_index_checked(instruction_sysvar_account_info)?;
    let current_instruction = load_instruction_at_checked(current_index as usize, instruction_sysvar_account_info)?;
    let instruction_data = &current_instruction.data;

    // Parse parameters from instruction data
    require!(instruction_data.len() >= 12, ZerokError::InvalidInstruction); // 8 + 2 + 2 minimum

    // Skip discriminator (first 8 bytes)
    let offset = u16::from_le_bytes([instruction_data[8], instruction_data[9]]);
    let chunk_len = u16::from_le_bytes([instruction_data[10], instruction_data[11]]);

    require!(chunk_len > 0, ZerokError::InvalidVKLength);
    require!(chunk_len as usize <= MAX_VK_CHUNK as usize, ZerokError::ChunkTooLarge);
    require!(
        instruction_data.len() >= 12 + chunk_len as usize,
        ZerokError::InvalidInstruction
    );

    let chunk = &instruction_data[12..12 + chunk_len as usize];

    // Validate state account and load denomination
    require_eq!(
        ctx.accounts.pool_state.owner,
        ctx.program_id,
        ZerokError::InvalidOwner
    );

    let account_data = ctx.accounts.pool_state.try_borrow_data()?;
    let discriminator = <ZerokStateV2Clean as anchor_lang::Discriminator>::DISCRIMINATOR;
    require!(
        account_data.len() >= 8 + ZerokStateV2Clean::SIZE && &account_data[0..8] == discriminator,
        ZerokError::InvalidStateAccount
    );

    let state: &ZerokStateV2Clean = bytemuck::from_bytes(&account_data[8..8 + ZerokStateV2Clean::SIZE]);
    let denomination = state.denomination;

    // Validate state PDA matches denomination
    let denomination_bytes = denomination.to_le_bytes();
    let state_key = ctx.accounts.pool_state.key();
    let (expected_state_pda, _) = Pubkey::find_program_address(
        &[ZEROK_STATE_SEED, &denomination_bytes[..]],
        ctx.program_id
    );
    require_keys_eq!(
        state_key,
        expected_state_pda,
        ZerokError::InvalidStateAccount
    );

    // Validate VK PDA matches denomination
    let (expected_vk_pda, _) = Pubkey::find_program_address(
        &[VK_V2_CLEAN_SEED, &denomination_bytes[..]],
        ctx.program_id
    );
    require_keys_eq!(
        ctx.accounts.vk_pda.key(),
        expected_vk_pda,
        ZerokError::InvalidVKAccount
    );

    // Validate authority
    require_keys_eq!(
        ctx.accounts.authority.key(),
        state.authority,
        ZerokError::Unauthorized
    );

    let vk_pda = &ctx.accounts.vk_pda;

    // Guards (write-once state machine)
    require!(!state.is_paused(), ZerokError::EmergencyPaused);
    require!(!state.is_vk_finalized(), ZerokError::AlreadyFinalized);

    // Chunk validation
    require!(chunk.len() > 0, ZerokError::InvalidVKLength);
    require!(chunk.len() <= MAX_VK_CHUNK as usize, ZerokError::ChunkTooLarge);

    // In-order enforcement (KEY: ensures sequential writes and idempotency)
    let vk_uploaded_bytes = state.vk_uploaded_bytes;
    require!(
        offset == vk_uploaded_bytes,
        ZerokError::InvalidChunkOffset
    );
    drop(state); // Release immutable borrow

    // Overflow check
    require!(
        offset as usize + chunk.len() <= VK_TOTAL_BYTES as usize,
        ZerokError::ExceedsExpectedSize
    );

    // VK PDA must already exist (created by initialize_vk_pda_v2_clean instruction)
    require!(!vk_pda.data_is_empty(), ZerokError::VKNotInitialized);
    require_eq!(vk_pda.owner, ctx.program_id, ZerokError::InvalidOwner);
    require_eq!(
        vk_pda.data_len(),
        VK_ACCOUNT_SIZE as usize,
        ZerokError::InvalidVKLength
    );

    // Write chunk to PDA after header (header + offset + chunk)
    let mut vk_account_data = vk_pda.try_borrow_mut_data()?;
    let data_start = VK_HEADER_BYTES as usize + offset as usize;
    let data_end = data_start + chunk.len();
    require!(
        data_end <= VK_ACCOUNT_SIZE as usize,
        ZerokError::ExceedsExpectedSize
    );
    vk_account_data[data_start..data_end].copy_from_slice(&chunk);
    drop(vk_account_data); // Release borrow
    drop(account_data); // Release immutable state borrow

    // Update progress (mutably access state)
    let mut account_data_mut = ctx.accounts.pool_state.try_borrow_mut_data()?;
    let state: &mut ZerokStateV2Clean = bytemuck::from_bytes_mut(&mut account_data_mut[8..8 + ZerokStateV2Clean::SIZE]);

    state.vk_uploaded_bytes = state.vk_uploaded_bytes
        .checked_add(chunk.len() as u16)
        .ok_or(ZerokError::ExceedsExpectedSize)?;

    msg!(
        "✓ VK chunk uploaded: offset {} | {} bytes | total {}/{}",
        offset,
        chunk.len(),
        state.vk_uploaded_bytes,
        VK_TOTAL_BYTES
    );

    Ok(())
}

/// Finalize VK by writing to dedicated PDA
/// Multi-pool design: state and VK PDAs include denomination
#[derive(Accounts)]
pub struct FinalizeVKV2Clean<'info> {
    /// State account - denomination validated in handler
    /// CHECK: PDA validated in handler
    #[account(mut)]
    pub pool_state: UncheckedAccount<'info>,

    /// CHECK: VK PDA - validated in handler (read-only during finalize)
    pub vk_pda: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler_finalize_vk_v2_clean(
    ctx: Context<FinalizeVKV2Clean>,
) -> Result<()> {
    use crate::state_v2_clean::VK_TOTAL_BYTES;

    // Validate state account and load denomination
    require_eq!(
        ctx.accounts.pool_state.owner,
        ctx.program_id,
        ZerokError::InvalidOwner
    );

    let account_data = ctx.accounts.pool_state.try_borrow_data()?;
    let discriminator = <ZerokStateV2Clean as anchor_lang::Discriminator>::DISCRIMINATOR;
    require!(
        account_data.len() >= 8 + ZerokStateV2Clean::SIZE && &account_data[0..8] == discriminator,
        ZerokError::InvalidStateAccount
    );

    let state: &ZerokStateV2Clean = bytemuck::from_bytes(&account_data[8..8 + ZerokStateV2Clean::SIZE]);
    let denomination = state.denomination;

    // Validate state PDA matches denomination
    let denomination_bytes = denomination.to_le_bytes();
    let state_key = ctx.accounts.pool_state.key();
    let (expected_state_pda, _) = Pubkey::find_program_address(
        &[ZEROK_STATE_SEED, &denomination_bytes[..]],
        ctx.program_id
    );
    require_keys_eq!(
        state_key,
        expected_state_pda,
        ZerokError::InvalidStateAccount
    );

    // Validate authority
    require_keys_eq!(
        ctx.accounts.authority.key(),
        state.authority,
        ZerokError::Unauthorized
    );

    // Write-once
    require!(!state.is_vk_finalized(), ZerokError::AlreadyFinalized);

    // Pause check
    require!(!state.is_paused(), ZerokError::EmergencyPaused);

    // Verify all chunks uploaded
    require!(
        state.vk_uploaded_bytes == VK_TOTAL_BYTES,
        ZerokError::IncompleteVk
    );

    // Validate VK PDA matches denomination
    let vk_pda = &ctx.accounts.vk_pda;
    let (expected_vk_pda, _) = Pubkey::find_program_address(
        &[VK_V2_CLEAN_SEED, &denomination_bytes[..]],
        ctx.program_id
    );
    require_keys_eq!(vk_pda.key(), expected_vk_pda, ZerokError::InvalidVKAccount);

    // Validate PDA exists and has correct size
    require_eq!(vk_pda.owner, ctx.program_id, ZerokError::InvalidOwner);
    require_eq!(
        vk_pda.data_len(),
        VK_ACCOUNT_SIZE as usize,
        ZerokError::InvalidVKLength
    );

    // Read VK data from PDA using canonical layout (skip header, hash only the 1028-byte VK data)
    let vk_account_data = vk_pda.try_borrow_data()?;
    let vk_data_slice = crate::vk_layout::vk_data_slice(&vk_account_data)?;

    // Compute and store hash of VK data only (not including header)
    use anchor_lang::solana_program::hash::hash;
    let vk_hash = hash(vk_data_slice);
    let vk_hash_bytes = vk_hash.to_bytes();
    let vk_pda_key = vk_pda.key();
    drop(vk_account_data); // Release borrow
    drop(account_data); // Release immutable borrow

    // Load state mutably to finalize
    let mut account_data_mut = ctx.accounts.pool_state.try_borrow_mut_data()?;
    let state: &mut ZerokStateV2Clean = bytemuck::from_bytes_mut(&mut account_data_mut[8..8 + ZerokStateV2Clean::SIZE]);

    state.vk_hash = vk_hash_bytes;
    state.vk_account = vk_pda_key;
    state.set_vk_finalized(true);

    msg!("✓ VK finalized: PDA {} | hash {:?}", vk_pda_key, vk_hash);
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Admin instructions: Pause / Unpause
// Uses UncheckedAccount + manual validation (same pattern as update_max_fee_bps)
// ═══════════════════════════════════════════════════════════════════════════

// State layout offsets for manual admin operations
const ADMIN_PAUSED_OFFSET: usize = 8990;   // u8: 0=unpaused, 1=paused
const ADMIN_AUTHORITY_OFFSET: usize = 16;   // Pubkey (32 bytes)

/// Validate pool state for admin operations: owner + discriminator + authority.
/// Inline in each handler to avoid lifetime issues with AccountInfo temporaries.
macro_rules! validate_admin_state {
    ($pool_state_info:expr, $program_id:expr, $authority_key:expr) => {{
        require_eq!(*$pool_state_info.owner, *$program_id, ZerokError::InvalidOwner);
        let data = $pool_state_info.try_borrow_mut_data()?;
        let disc = <ZerokStateV2Clean as anchor_lang::Discriminator>::DISCRIMINATOR;
        require!(&data[0..8] == disc, ZerokError::InvalidStateAccount);
        require!(
            &data[16..48] == $authority_key.as_ref(),
            ZerokError::Unauthorized
        );
        data
    }};
}

/// Pause pool — authority-only, manual PDA validation (multi-pool compatible)
#[derive(Accounts)]
pub struct PauseV2Clean<'info> {
    /// CHECK: Pool state PDA — validated manually in handler (supports any denomination)
    #[account(mut)]
    pub pool_state: UncheckedAccount<'info>,

    pub authority: Signer<'info>,
}

pub fn handler_pause_v2_clean(ctx: Context<PauseV2Clean>) -> Result<()> {
    let pool_info = ctx.accounts.pool_state.to_account_info();
    let mut data = validate_admin_state!(pool_info, ctx.program_id, ctx.accounts.authority.key);
    require!(data[ADMIN_PAUSED_OFFSET] == 0, ZerokError::EmergencyPaused);
    data[ADMIN_PAUSED_OFFSET] = 1;
    msg!("Pool paused by authority");
    Ok(())
}

/// Unpause pool — authority-only, manual PDA validation (multi-pool compatible)
#[derive(Accounts)]
pub struct UnpauseV2Clean<'info> {
    /// CHECK: Pool state PDA — validated manually in handler (supports any denomination)
    #[account(mut)]
    pub pool_state: UncheckedAccount<'info>,

    pub authority: Signer<'info>,
}

pub fn handler_unpause_v2_clean(ctx: Context<UnpauseV2Clean>) -> Result<()> {
    let pool_info = ctx.accounts.pool_state.to_account_info();
    let mut data = validate_admin_state!(pool_info, ctx.program_id, ctx.accounts.authority.key);
    require!(data[ADMIN_PAUSED_OFFSET] == 1, ZerokError::EmergencyPaused);
    data[ADMIN_PAUSED_OFFSET] = 0;
    msg!("Pool unpaused by authority");
    Ok(())
}

/// Update max_fee_bps — authority-only, manual PDA validation (multi-pool compatible)
#[derive(Accounts)]
pub struct UpdateMaxFeeBps<'info> {
    /// CHECK: Pool state PDA — validated manually in handler (supports any denomination)
    #[account(mut)]
    pub pool_state: UncheckedAccount<'info>,

    pub authority: Signer<'info>,
}

// CloseLegacyPool removed — all V2 pools already closed (2026-04-06)

/// Close pool — authority-only, requires vault balance = 0.
/// Closes state, vault, VK, ring metadata, and all 20 shard accounts.
/// Returns all rent to the authority wallet.
#[derive(Accounts)]
pub struct ClosePool<'info> {
    /// CHECK: Pool state PDA — validated in handler (authority + empty vault check)
    #[account(mut)]
    pub pool_state: UncheckedAccount<'info>,

    /// CHECK: Vault PDA — must have 0 balance (all funds withdrawn)
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: VK PDA — will be closed
    #[account(mut)]
    pub vk_pda: UncheckedAccount<'info>,

    /// CHECK: Ring metadata PDA — will be closed
    #[account(mut)]
    pub ring_metadata: UncheckedAccount<'info>,

    /// Authority — receives all rent
    #[account(mut)]
    pub authority: Signer<'info>,

    // Remaining accounts: all 20 shard PDAs (mut)
}

/// Get Merkle path for a given leaf index (read-only query)
/// Returns exact siblings and positions as used by deposit instruction
#[derive(Accounts)]
pub struct GetMerklePath<'info> {
    /// State account - read-only
    /// CHECK: PDA validated in handler
    pub pool_state: UncheckedAccount<'info>,
}

pub fn handler_get_merkle_path(
    ctx: Context<GetMerklePath>,
    leaf_index: u32,
) -> Result<()> {
    // Validate state account
    require_eq!(
        ctx.accounts.pool_state.owner,
        ctx.program_id,
        ZerokError::InvalidOwner
    );

    let account_data = ctx.accounts.pool_state.try_borrow_data()?;
    let discriminator = <ZerokStateV2Clean as anchor_lang::Discriminator>::DISCRIMINATOR;
    require!(
        account_data.len() >= 8 + ZerokStateV2Clean::SIZE && &account_data[0..8] == discriminator,
        ZerokError::InvalidStateAccount
    );

    let state: &ZerokStateV2Clean = bytemuck::from_bytes(&account_data[8..8 + ZerokStateV2Clean::SIZE]);

    // Validate leaf_index is within range
    require!(
        leaf_index < state.leaf_count,
        ZerokError::InvalidLeafIndex
    );

    // Compute path using same logic as deposit
    let mut idx = leaf_index;

    msg!("Merkle path for leaf_index {}:", leaf_index);
    msg!("Current root: {:?}", hex::encode(&state.current_root));

    for level in 0..20 {
        let (sibling, position) = if (idx & 1) == 0 {
            // Left child: sibling is zero (to the right)
            (ZERO_CHAIN_BE[level], 0u8)
        } else {
            // Right child: sibling is frontier (to the left)
            (state.merkle_frontier[level], 1u8)
        };

        msg!("Level {}: sibling={:?} position={}", level, hex::encode(&sibling), position);
        idx >>= 1;
    }

    Ok(())
}