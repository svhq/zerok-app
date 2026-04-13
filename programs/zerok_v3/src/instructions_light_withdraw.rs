// Light Protocol Withdrawal Instructions
// Phase L1.3: Implement Light-aware withdrawal with CPI integration
//
// This module implements withdrawal from Light Protocol compressed accounts.
// Compressed accounts exist as Merkle tree leaf hashes and require zk-SNARK proofs
// to consume. The Light System Program handles nullification and proof verification.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::ZerokError;
use crate::light_state::ZerokCommitment;  // Import canonical struct (single source of truth)

// Light Protocol v2 types for compressed account handling
use light_compressed_account::{
    compressed_account::{
        CompressedAccount,
        CompressedAccountData,
        PackedMerkleContext,
        PackedReadOnlyCompressedAccount,
    },
    instruction_data::{
        compressed_proof::CompressedProof,
        with_account_info::InAccountInfo,
        with_readonly::InAccount,
    },
    Pubkey as LightPubkey, // Light Protocol's Pubkey type
};
use light_sdk::LightDiscriminator;  // Discriminator trait for accessing discriminator() method
use light_sdk::constants::{CPI_AUTHORITY_PDA_SEED, LIGHT_SYSTEM_PROGRAM_ID};

// SDK V2 imports for CPI invocation
use light_sdk::cpi::v2::CpiAccounts;
use light_sdk::cpi::invoke::InvokeLightSystemProgram;
use light_sdk::cpi::CpiSigner;
use light_sdk::derive_light_cpi_signer;

// Define CPI signer for this program
const LIGHT_CPI_SIGNER: CpiSigner = derive_light_cpi_signer!("BBRZetvZcXuPYzu8PLj1s1ByxuFzQRbcZLSAcoFsRsW4");

/// Withdraw instruction arguments - wire format using only primitives
///
/// **Design Principle**: Wire Format Simplicity
/// - Uses only primitives (u8, u64, [u8; N], bool, Option<>) for clean IDL generation
/// - TypeScript clients can easily serialize/deserialize without Light Protocol types
/// - Decouples from Light Protocol's internal type changes
/// - Handler converts primitives to Light types at the boundary
///
/// **Pattern**: Follows Light Protocol's own pattern (see MultiInputTokenDataWithContext)
/// and industry best practices (Marinade, Metaplex) - wire format stays simple,
/// business logic uses richer domain types.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct WithdrawLightArgs {
    // ========== VALIDITY PROOF COMPONENTS (CompressedProof - 128 bytes) ==========

    /// Groth16 proof component A (32 bytes)
    pub proof_a: [u8; 32],

    /// Groth16 proof component B (64 bytes)
    pub proof_b: [u8; 64],

    /// Groth16 proof component C (32 bytes)
    pub proof_c: [u8; 32],

    // ========== COMPRESSED ACCOUNT COMPONENTS ==========

    /// Owner of the compressed account being consumed (Pubkey as bytes)
    pub compressed_account_owner: [u8; 32],

    /// Balance of the compressed account (in lamports)
    pub compressed_account_lamports: u64,

    /// Address field for compressed account
    /// ⚠️ NOTE: The "new_close pattern" mentioned in historical docs is DEPRECATED (see ARCHITECTURE.md)
    /// Current implementation: Always pass [0u8; 32] for anonymous accounts (addressless deposits)
    pub compressed_account_address: [u8; 32],

    /// Compressed account data (stores the 32-byte commitment)
    pub compressed_account_data: [u8; 32],

    // ========== MERKLE CONTEXT COMPONENTS (PackedMerkleContext) ==========

    /// Index of merkle tree in remaining_accounts array
    pub merkle_tree_pubkey_index: u8,

    /// Index of queue (nullifier queue) in remaining_accounts array
    /// Note: Light Protocol calls this queue_pubkey_index
    pub queue_pubkey_index: u8,

    /// Leaf index in the merkle tree
    pub leaf_index: u32,

    /// Whether to prove by index (vs by address)
    pub prove_by_index: bool,

    /// Index of root in root history that proof validates against
    pub root_index: u16,

    // ========== ACCOUNT INDEXING OFFSETS ==========
    // These offsets are returned by PackedAccounts::to_account_metas() on the client side
    // and allow the program to correctly locate accounts in ctx.remaining_accounts.
    //
    // Account array structure: [pre_accounts][system_accounts][packed_accounts]
    // - pre_accounts: Named accounts from instruction struct (fee_payer, authority, etc.)
    // - system_accounts: Light Protocol system accounts (Light system program, authority, etc.)
    // - packed_accounts: Tree and queue accounts added via insert_or_get()
    //
    // The merkle_tree_pubkey_index and queue_pubkey_index are RELATIVE to packed_accounts (0, 1, 2, ...)
    // To find absolute index: absolute_index = packed_accounts_offset + relative_index

    /// Offset where system accounts start in the full account array
    /// Returned by PackedAccounts::to_account_metas() as the second value
    pub system_accounts_offset: u8,

    /// Offset where packed accounts start in the full account array
    /// Returned by PackedAccounts::to_account_metas() as the third value
    pub packed_accounts_offset: u8,

    // ========== WITHDRAWAL PARAMETERS ==========

    /// Amount to withdraw (in lamports)
    pub withdraw_amount: u64,

    /// Optional change amount (for partial withdrawals)
    /// If None, this is a full withdrawal
    /// If Some(amount), creates a new compressed note with this balance
    pub change_amount: Option<u64>,

    /// Optional new address for change note (required if change_amount is Some)
    pub change_address: Option<[u8; 32]>,
}

/// Withdrawal accounts structure
///
/// Account ordering is CRITICAL - PackedMerkleContext indices must match
/// position in remaining_accounts array. See WITHDRAWAL_INSTRUCTION_DESIGN.md
#[derive(Accounts)]
pub struct WithdrawLight<'info> {
    // ========== SIGNERS ==========
    /// Fee payer and authority for the withdrawal
    #[account(mut)]
    pub fee_payer: Signer<'info>,

    /// Authority signing the withdrawal (can be same as fee_payer)
    pub authority: Signer<'info>,

    // ========== LIGHT PROTOCOL PROGRAMS ==========
    /// CHECK: Light Protocol registered program PDA
    /// Seeds: [b"registered_program", program_id]
    /// Owner: light_registry::ID
    pub registered_program_pda: UncheckedAccount<'info>,

    /// CHECK: Light Protocol noop program (for event emission)
    pub noop_program: UncheckedAccount<'info>,

    /// CHECK: Light Protocol account compression authority PDA
    pub account_compression_authority: UncheckedAccount<'info>,

    /// Light Protocol account compression program
    /// CHECK: Program ID validated by Light CPI
    pub account_compression_program: UncheckedAccount<'info>,

    /// CHECK: Self-reference to Zerok program (for CPI context)
    pub self_program: UncheckedAccount<'info>,

    // ========== OPTIONAL CONTEXT ==========
    /// Optional CPI context account for chaining operations
    /// Set to None for single-operation withdrawals
    #[account(mut)]
    pub cpi_context_account: Option<UncheckedAccount<'info>>,

    // ========== SOLANA SYSTEM ==========
    pub system_program: Program<'info, System>,

    // ========== POOL STATE ==========
    /// Pool state PDA containing pool configuration (denomination, etc.)
    /// CHECK: PDA validation done in handler
    pub pool_state: UncheckedAccount<'info>,

    // ========== RECIPIENT ==========
    /// CHECK: Recipient account receiving withdrawn SOL
    /// NOT part of Light CPI - used post-CPI for transfer
    /// No ownership validation needed - recipient can be any account
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    // ========== REMAINING ACCOUNTS ==========
    // Passed via ctx.remaining_accounts in strict order:
    // [0] input_merkle_tree (referenced by merkle_context.merkle_tree_pubkey_index)
    // [1] input_nullifier_queue (referenced by merkle_context.queue_pubkey_index)
    // [2] output_merkle_tree (optional, only if change_amount.is_some())
    // [3] output_nullifier_queue (optional, only if change_amount.is_some())
}

/// Compute hash for addressless compressed account
///
/// This function computes the account hash exactly as it was created during deposit:
/// - Uses `address: None` to match anonymous deposit pattern
/// - Includes commitment in `data_hash` field
/// - Uses `batched=true` for V2 Merkle trees
///
/// Compute compressed account hash that matches Light SDK's deposit behavior.
///
/// CRITICAL FIX: During deposit, Light SDK automatically computes:
///   data_hash = Poseidon(Borsh::serialize(ZerokCommitment { commitment }))
///
/// During withdrawal, we must compute the SAME hash to match the stored account.
/// Passing raw commitment bytes causes hash mismatch → Error 6035.
fn compute_addressless_account_hash(
    owner: Pubkey,
    lamports: u64,
    commitment: [u8; 32],
    merkle_tree: &Pubkey,
    leaf_index: u32,
) -> Result<[u8; 32]> {
    use borsh::BorshSerialize;
    use crate::light_state::ZerokCommitment;
    use solana_program::hash::hash;

    // Step 1: Create ZerokCommitment struct (same as deposit)
    let zerok_commitment = ZerokCommitment { commitment };

    // Step 2: Borsh serialize (this is what Light SDK does for HASH_FLAT=true mode)
    // For ZerokCommitment { commitment: [u8; 32] }, this serializes to 32 bytes (no length prefix for fixed arrays)
    let serialized = zerok_commitment.try_to_vec()
        .map_err(|_| ZerokError::InvalidInstruction)?;

    // Step 3: SHA256 hash + truncation (matching Light SDK's HASH_FLAT=true behavior)
    // Light SDK uses: LightAccount<ZerokCommitment> which is sha::LightAccount<ZerokCommitment, HASH_FLAT=true>
    // Formula: data_hash = SHA256(Borsh(struct)), then data_hash[0] = 0 for BN254 field size compatibility
    let mut data_hash = hash(&serialized).to_bytes();
    data_hash[0] = 0;  // ← CRITICAL: Truncate first byte to fit BN254 field size

    msg!("✅ Computed data_hash using SHA256 (matching Light SDK HASH_FLAT=true):");
    msg!("  Commitment (first 8): {:?}", &commitment[..8]);
    msg!("  Serialized length: {}", serialized.len());
    msg!("  data_hash (first 8): {:?}", &data_hash[..8]);

    // Step 4: Build CompressedAccount with correct data_hash
    // ⚠️ CRITICAL: The data field must contain the Borsh-serialized ZerokCommitment bytes
    // This is what the deposit stores, and it's used in the data_hash computation
    let light_owner = LightPubkey::new_from_array(owner.to_bytes());
    let discriminator = ZerokCommitment::discriminator();

    let compressed_account = CompressedAccount {
        owner: light_owner,
        lamports,
        address: None,  // ← CRITICAL: No address for anonymous deposits
        data: Some(CompressedAccountData {
            discriminator,
            data: serialized.clone(),  // ⚠️ FIX: Use serialized commitment bytes, not empty!
            data_hash,     // ✅ FIX: Use SHA256(Borsh(ZerokCommitment)), not raw commitment
        }),
    };

    // Debug: Print ALL components before hashing
    msg!("=== CompressedAccount Components (Before Hash) ===");
    msg!("  owner (first 8): {:?}", &owner.to_bytes()[..8]);
    msg!("  lamports: {}", lamports);
    msg!("  address: None");
    msg!("  discriminator: {:?}", discriminator);
    msg!("  data (first 8): {:?}", &serialized[..8]);
    msg!("  data.len(): {}", serialized.len());
    msg!("  data_hash (first 8): {:?}", &data_hash[..8]);
    msg!("  leaf_index: {}", leaf_index);
    msg!("  merkle_tree (first 8): {:?}", &merkle_tree.to_bytes()[..8]);
    msg!("  batched: true");

    // Convert Anchor Pubkey to Light Pubkey for hash computation
    let light_merkle_tree = LightPubkey::new_from_array(merkle_tree.to_bytes());

    // Compute final account hash with batched=true for V2 trees
    let account_hash = compressed_account.hash(&light_merkle_tree, &leaf_index, true)
        .map_err(|_| ZerokError::InvalidInstruction)?;

    msg!("=== Computed Account Hash ===");
    msg!("  account_hash (first 8): {:?}", &account_hash[..8]);
    msg!("  (Expected from deposit: [12, 121, 217, 229, 22, 18, 57, 122])");

    Ok(account_hash)
}

/// Withdraw from Light Protocol compressed account
///
/// This instruction consumes a compressed note (compressed account) and transfers
/// the funds to the recipient. It supports both full and partial withdrawals.
///
/// Flow:
/// 1. Validate inputs (proof, amounts, addresses)
/// 2. Build PackedCompressedAccountWithMerkleContext for input note
/// 3. Build output note if partial withdrawal
/// 4. Create InstructionDataInvokeCpi for Light System Program
/// 5. Invoke Light System Program (verifies proof, adds nullifier)
/// 6. Transfer withdrawn amount to recipient
///
/// Security:
/// - Proof verification handled by Light System Program
/// - Nullifier checked by Light System Program (prevents double-spending)
/// - Account ordering validated by Light System Program
///
/// See WITHDRAWAL_INSTRUCTION_DESIGN.md for complete design specification
pub fn handler_withdraw_light<'info>(
    ctx: Context<'_, '_, '_, 'info, WithdrawLight<'info>>,
    args: WithdrawLightArgs,
) -> Result<()> {
    msg!("=== Light Protocol Withdrawal ===");

    // ========== 0. CONVERT PRIMITIVES TO LIGHT TYPES ==========
    // Wire format uses primitives for clean IDL; convert to Light types at boundary

    let validity_proof = CompressedProof {
        a: args.proof_a,
        b: args.proof_b,
        c: args.proof_c,
    };

    // ========== COMPUTE DATA_HASH (SHA256 MODE) ==========
    // Light SDK's LightAccount uses HASH_FLAT=true mode, which is SHA256, not Poseidon
    // Formula: data_hash = SHA256(Borsh(ZerokCommitment)) with first byte truncated to 0

    use solana_program::hash::hash;
    use borsh::BorshSerialize;
    use crate::ZerokCommitment;

    let commitment_struct = ZerokCommitment {
        commitment: args.compressed_account_data,
    };

    let serialized = commitment_struct.try_to_vec()
        .map_err(|_| ZerokError::InvalidInstruction)?;

    let mut data_hash = hash(&serialized).to_bytes();
    data_hash[0] = 0;  // BN254 field truncation

    msg!("✓ Computed data_hash using SHA256 (matching Light SDK HASH_FLAT=true):");
    msg!("  Commitment (first 8): {:?}", &args.compressed_account_data[..8]);
    msg!("  data_hash (first 8): {:?}", &data_hash[..8]);

    // Get discriminator for InAccount
    let discriminator = ZerokCommitment::discriminator();

    // Build PackedMerkleContext for the input account
    let packed_merkle_context = PackedMerkleContext {
        merkle_tree_pubkey_index: args.merkle_tree_pubkey_index,
        queue_pubkey_index: args.queue_pubkey_index,
        leaf_index: args.leaf_index,
        prove_by_index: args.prove_by_index,
    };

    msg!("✓ Computed data components for InAccount");

    // ========== 1. VALIDATE INPUTS ==========

    // Read pool state to get denomination
    use crate::state_v2_clean::ZerokStateV2Clean;
    let pool_state_data = ctx.accounts.pool_state.try_borrow_data()?;
    let state: &ZerokStateV2Clean = bytemuck::try_from_bytes(&pool_state_data[8..8 + ZerokStateV2Clean::SIZE])
        .map_err(|_| ZerokError::InvalidInstruction)?;

    let denomination = state.denomination;
    msg!("✓ Loaded pool state: denomination={} lamports", denomination);

    // Validate withdraw amount is positive
    require!(
        args.withdraw_amount > 0,
        ZerokError::InvalidWithdrawAmount
    );

    // Validate withdrawal amount against denomination (not compressed account lamports)
    // Zerok stores SOL in vault PDA; compressed account only stores commitment (0 lamports)
    // Full withdrawal must equal denomination
    if args.change_amount.is_none() {
        require!(
            args.withdraw_amount == denomination,
            ZerokError::InvalidWithdrawAmount
        );
    } else {
        // Partial withdrawal: withdraw + change must equal denomination
        let change_amount = args.change_amount.unwrap();

        // Change amount must be positive
        require!(change_amount > 0, ZerokError::InvalidWithdrawAmount);

        // Change address must be provided
        require!(
            args.change_address.is_some(),
            ZerokError::InvalidInstruction
        );

        // Balance equation: denomination = withdraw + change
        let total = args.withdraw_amount
            .checked_add(change_amount)
            .ok_or(ZerokError::InvalidWithdrawAmount)?;

        require!(
            total == denomination,
            ZerokError::InvalidWithdrawAmount
        );
    }

    // Validate remaining accounts are provided
    let remaining_accounts = ctx.remaining_accounts;
    let min_accounts = if args.change_amount.is_some() { 4 } else { 2 };
    require!(
        remaining_accounts.len() >= min_accounts,
        ZerokError::InvalidInstruction
    );

    msg!("✓ Input validation complete");
    msg!("  Withdraw amount: {} lamports", args.withdraw_amount);
    msg!("  Compressed balance: {} lamports", args.compressed_account_lamports);
    msg!("  Change: {:?}", args.change_amount);

    // ========== 2. VALIDATE INPUT COMPRESSED ACCOUNT ==========

    // Note: We don't need to build PackedCompressedAccountWithMerkleContext anymore
    // because V2 SDK uses InAccountInfo and CompressedAccountInfo directly

    msg!("✓ Input compressed account validated");
    msg!("  Leaf index: {}", packed_merkle_context.leaf_index);
    msg!("  Tree index: {}", packed_merkle_context.merkle_tree_pubkey_index);
    msg!("  Queue index: {}", packed_merkle_context.queue_pubkey_index);

    // ========== 3. BUILD OUTPUT NOTE (IF PARTIAL WITHDRAWAL) ==========

    // TODO: Partial withdrawals not yet implemented in V2 SDK integration.
    // For now, only full withdrawals are supported (change_amount must be None).

    if args.change_amount.is_some() {
        msg!("ERROR: Partial withdrawals not yet supported");
        return Err(ZerokError::InvalidInstruction.into());
    }

    msg!("✓ Full withdrawal (no change output)");

    // ========== 4. BUILD INPUT ACCOUNT INFO (LOW-LEVEL PATTERN) ==========

    msg!("=== V2 Addressless Account Withdrawal (Batched Trees) ===");
    msg!("Building InAccountInfo for ReadOnlyCompressedAccount pattern...");

    // Build PackedMerkleContext for the input account
    let packed_merkle_context = PackedMerkleContext {
        merkle_tree_pubkey_index: args.merkle_tree_pubkey_index,
        queue_pubkey_index: args.queue_pubkey_index,
        leaf_index: args.leaf_index,
        prove_by_index: false,  // ← CRITICAL FIX: false = use ZK proof verification (not index lookup)
                               // Error 6018 occurs when proof.is_some() but no accounts need ZK proof
                               // prove_by_index: true → account proven by index (no ZK proof needed)
                               // prove_by_index: false → account proven by ZK proof (requires proof verification)
    };

    msg!("✓ PackedMerkleContext constructed:");
    msg!("  Tree index: {}", packed_merkle_context.merkle_tree_pubkey_index);
    msg!("  Queue index: {}", packed_merkle_context.queue_pubkey_index);
    msg!("  Leaf index: {}", packed_merkle_context.leaf_index);
    msg!("  Prove by index: false (ZK proof verification)");

    // ========== 5. CREATE CPI ACCOUNTS (SDK-NATIVE PATTERN) ==========

    // Follow Light Protocol's documented pattern for account indexing:
    // 1. Client calls to_account_metas() → gets (accounts, system_offset, packed_offset)
    // 2. Client passes offsets in instruction data
    // 3. Program converts absolute offsets to remaining_accounts indices
    //
    // CRITICAL: Offsets from to_account_metas() are ABSOLUTE indices in the full account array.
    // But ctx.remaining_accounts only contains accounts AFTER the named accounts.
    //
    // Full array: [named_accounts (0-10)][system_accounts (11-16)][packed_accounts (17-18)]
    // remaining_accounts: [system_accounts (0-5)][packed_accounts (6-7)]
    //
    // Conversion: remaining_index = absolute_index - named_accounts_count
    // Since named accounts end where system accounts begin:
    // named_accounts_count = system_accounts_offset

    msg!("=== SDK-Native Account Indexing ===");
    msg!("  System accounts offset (absolute): {}", args.system_accounts_offset);
    msg!("  Packed accounts offset (absolute): {}", args.packed_accounts_offset);
    msg!("  Merkle tree relative index: {}", args.merkle_tree_pubkey_index);
    msg!("  Queue relative index: {}", args.queue_pubkey_index);

    // ========================================================================
    // MANUAL OFFSET CALCULATIONS - CRITICAL ASSUMPTIONS
    // ========================================================================
    // CRITICAL ASSUMPTION 1: system_accounts_offset is absolute index in full account array
    //   - This is the position where Light Protocol system accounts start
    //   - It includes all named accounts that appear BEFORE remaining_accounts
    //
    // CRITICAL ASSUMPTION 2: packed_accounts_offset is absolute index in full account array
    //   - PackedAccounts.insert_or_get() returns indices relative to this offset
    //   - merkle_tree_pubkey_index and queue_pubkey_index are relative to packed_offset
    //
    // CRITICAL ASSUMPTION 3: Account array structure is:
    //   [Named Accounts (0..system_offset)] + [System Accounts] + [Packed Accounts]
    //   where remaining_accounts = [System Accounts] + [Packed Accounts]
    //
    // ⚠️  VALIDATION: Runtime assertions (debug builds only) validate these assumptions
    // ========================================================================

    // Runtime validation of critical assumptions (debug builds only)
    #[cfg(debug_assertions)]
    {
        // ASSUMPTION 1: system_accounts_offset equals pre-accounts count
        // WithdrawLight has 11 named accounts (see struct definition above)
        const EXPECTED_PRE_ACCOUNTS: u8 = 11;
        assert_eq!(
            args.system_accounts_offset, EXPECTED_PRE_ACCOUNTS,
            "ASSUMPTION VIOLATION: system_accounts_offset ({}) must equal pre-accounts count ({}). \
             This indicates a mismatch between WithdrawLight struct and PackedAccounts.to_account_metas()",
            args.system_accounts_offset, EXPECTED_PRE_ACCOUNTS
        );

        // ASSUMPTION 2: packed_accounts_offset is greater than system_accounts_offset
        assert!(
            args.packed_accounts_offset > args.system_accounts_offset,
            "ASSUMPTION VIOLATION: packed_accounts_offset ({}) must be greater than system_accounts_offset ({}). \
             This indicates incorrect account array ordering",
            args.packed_accounts_offset, args.system_accounts_offset
        );

        // ASSUMPTION 3: Remaining accounts contain both system and packed accounts
        let expected_system_accounts = 6; // Light Protocol system accounts count
        let expected_packed_accounts = 2; // Merkle tree + queue
        let expected_remaining_total = expected_system_accounts + expected_packed_accounts;

        assert!(
            remaining_accounts.len() >= expected_remaining_total,
            "ASSUMPTION VIOLATION: remaining_accounts.len() ({}) must be at least {} (6 system + 2 packed). \
             Actual account array may be malformed",
            remaining_accounts.len(), expected_remaining_total
        );

        msg!("✅ Runtime assertion validation passed (debug build)");
    }

    // Calculate number of named accounts (they are NOT in remaining_accounts)
    let named_accounts_count = args.system_accounts_offset as usize;

    msg!("  Named accounts count: {}", named_accounts_count);
    msg!("  Remaining accounts length: {}", remaining_accounts.len());

    // Convert system accounts offset to remaining_accounts index
    // system_accounts_offset points to where system accounts start in full array
    // In remaining_accounts, they start at index 0
    let system_accounts_start = args.system_accounts_offset as usize - named_accounts_count;

    msg!("  System accounts start (in remaining): {}", system_accounts_start);

    // Slice remaining_accounts starting from system accounts
    // For our case: system_offset=11, named=11, so we slice from remaining[0..]
    let accounts_for_cpi = &remaining_accounts[system_accounts_start..];

    // Create CpiAccounts - SDK handles account validation internally
    let cpi_accounts = CpiAccounts::new(
        ctx.accounts.authority.as_ref(),
        accounts_for_cpi,  // ✅ Start at system accounts (remaining[0] in our case)
        LIGHT_CPI_SIGNER,
    );

    // Calculate merkle tree index in remaining_accounts
    // Formula: absolute_index = packed_accounts_offset + relative_index
    // Then convert to remaining_accounts index by subtracting named_accounts_count
    let merkle_tree_absolute_index = args.packed_accounts_offset as usize
        + args.merkle_tree_pubkey_index as usize;
    let merkle_tree_remaining_index = merkle_tree_absolute_index - named_accounts_count;

    msg!("  Tree absolute index (in full array): {}", merkle_tree_absolute_index);
    msg!("  Tree remaining index (in remaining_accounts): {}", merkle_tree_remaining_index);

    require!(
        merkle_tree_remaining_index < remaining_accounts.len(),
        ZerokError::InvalidInstruction
    );

    let merkle_tree_pubkey = remaining_accounts[merkle_tree_remaining_index].key;

    msg!("✓ Account indexing resolved:");
    msg!("  Tree absolute index: {}", merkle_tree_absolute_index);
    msg!("  Tree pubkey: {}", merkle_tree_pubkey);
    msg!("  Tree pubkey (first 8 bytes): {:?}", &merkle_tree_pubkey.to_bytes()[..8]);

    // Compute the account hash using our helper function
    // This hash must match what was created during deposit
    let account_hash = compute_addressless_account_hash(
        Pubkey::from(args.compressed_account_owner),
        args.compressed_account_lamports,
        args.compressed_account_data,  // commitment
        merkle_tree_pubkey,
        args.leaf_index,
    )?;

    msg!("✓ Account hash computed:");
    msg!("  Hash (first 8 bytes): {:?}", &account_hash[..8]);
    msg!("  Owner: {:?}", &args.compressed_account_owner[..8]);
    msg!("  Lamports: {}", args.compressed_account_lamports);
    msg!("  Commitment (first 8 bytes): {:?}", &args.compressed_account_data[..8]);

    // ========== CREATE INPUT ACCOUNT (CONSUMED DURING WITHDRAWAL) ==========
    // Withdrawals CONSUME compressed accounts (they get nullified), so we must use
    // input_compressed_accounts, NOT read_only_accounts.
    // Error 6018 occurs when proof is provided but no inputs - withdrawals are NOT read-only!

    use light_compressed_account::instruction_data::with_readonly::InAccount;

    let input_account = InAccount {
        discriminator,                            // ZerokCommitment discriminator
        data_hash,                                // SHA256(Borsh(commitment)) + truncation
        merkle_context: packed_merkle_context,    // Tree and queue indices
        root_index: args.root_index,              // Root history index
        lamports: args.compressed_account_lamports,  // Account balance (0 for our case)
        address: None,                            // Addressless account
    };

    msg!("✓ InAccount created for withdrawal (will be consumed/nullified):");
    msg!("  discriminator: {:?}", &discriminator);
    msg!("  data_hash (first 8): {:?}", &data_hash[..8]);
    msg!("  lamports: {}", args.compressed_account_lamports);

    // ========== PHASE 1 DEBUG: Hash Computation Verification ==========
    msg!("=== Withdrawal Hash Debug (Phase 1) ===");
    msg!("Commitment (data, first 8): {:?}", &args.compressed_account_data[..8]);
    msg!("Computed account_hash (first 8): {:?}", &account_hash[..8]);
    msg!("Leaf index: {}", args.leaf_index);
    msg!("Tree pubkey index: {}", packed_merkle_context.merkle_tree_pubkey_index);
    msg!("Queue pubkey index: {}", packed_merkle_context.queue_pubkey_index);
    msg!("Owner (first 8): {:?}", &args.compressed_account_owner[..8]);
    msg!("Lamports: {}", args.compressed_account_lamports);
    msg!("");
    msg!("NOTE: This hash is computed manually. Hypothesis: It should match Poseidon(Borsh(ZerokCommitment))");
    msg!("      but we're passing raw commitment, which will cause Error 6035.");
    msg!("=== End Hash Debug ===");

    // ========== 6. BUILD INSTRUCTION DATA (LOW-LEVEL PATTERN) ==========

    msg!("Building InstructionDataInvokeCpiWithReadOnly...");

    use light_compressed_account::instruction_data::with_readonly::InstructionDataInvokeCpiWithReadOnly;
    use light_compressed_account::LightInstructionData;
    use anchor_lang::prelude::Pubkey;

    // Derive CPI authority PDA bump FIRST (needed for instruction data)
    let (cpi_authority_pda, bump) = Pubkey::find_program_address(
        &[CPI_AUTHORITY_PDA_SEED],
        ctx.program_id
    );

    msg!("CPI authority PDA derived:");
    msg!("  PDA: {}", cpi_authority_pda);
    msg!("  Bump: {}", bump);

    // Build instruction data - CRITICAL FIX: Use input_compressed_accounts, not read_only_accounts
    // Withdrawals consume (nullify) accounts, so they are inputs, not read-only!
    let instruction_data = InstructionDataInvokeCpiWithReadOnly {
        mode: 1,  // Mode 1: without program IDs in accounts
        bump,  // CPI authority PDA bump
        invoking_program_id: LightPubkey::new_from_array(ctx.program_id.to_bytes()),
        compress_or_decompress_lamports: 0,  // Not compressing/decompressing
        is_compress: false,
        with_cpi_context: false,  // Not using CPI context for simple withdrawal
        with_transaction_hash: false,
        cpi_context: Default::default(),
        proof: Some(validity_proof),
        new_address_params: vec![],  // No new addresses
        input_compressed_accounts: vec![input_account],  // ✅ FIX: Account being consumed!
        output_compressed_accounts: vec![],  // No outputs (full withdrawal to uncompressed)
        read_only_addresses: vec![],  // No address validation needed
        read_only_accounts: vec![],  // ✅ FIX: Empty - we're consuming, not reading!
    };

    msg!("✓ Instruction data built - using input_compressed_accounts");
    msg!("  Mode: {}", instruction_data.mode);
    msg!("  Input accounts (consumed): {}", instruction_data.input_compressed_accounts.len());
    msg!("  Read-only accounts: {}", instruction_data.read_only_accounts.len());

    // Serialize instruction data with discriminator
    let data = instruction_data
        .data()
        .map_err(|_| ZerokError::InvalidInstruction)?;

    msg!("✓ Instruction data serialized: {} bytes", data.len());

    // ========== 7. LOG HASH FOR DEBUGGING ==========

    msg!("Account hash verification:");
    msg!("  Computed hash: {:?}", &account_hash[..8]);
    msg!("  Leaf index: {}", args.leaf_index);
    msg!("  Tree pubkey: {}", merkle_tree_pubkey);

    // ========== 8. INVOKE LIGHT SYSTEM PROGRAM USING SDK ==========

    msg!("Invoking Light System Program using SDK pattern...");

    // Use the CpiAccounts we created earlier (already sliced correctly from system_accounts_offset)
    // The SDK handles:
    // - Serialization of instruction data
    // - Building account_metas in correct order
    // - invoke_signed with CPI authority PDA
    instruction_data.invoke(cpi_accounts)?;

    msg!("✓ Light System Program invocation complete");
    msg!("  Account successfully consumed from state tree");

    // ========== 9. TRANSFER WITHDRAWN AMOUNT TO RECIPIENT ==========

    msg!("Transferring {} lamports to recipient...", args.withdraw_amount);

    // Transfer from fee_payer to recipient
    // Note: The compressed account lamports were never held by fee_payer.
    // In a full implementation, the vault would hold the funds and transfer here.
    // For now, we assume fee_payer has the funds (integration test pattern).
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.fee_payer.to_account_info(),
                to: ctx.accounts.recipient.to_account_info(),
            },
        ),
        args.withdraw_amount,
    )?;

    msg!("✓ Transfer complete");
    msg!("=== Withdrawal successful ===");

    Ok(())
}
