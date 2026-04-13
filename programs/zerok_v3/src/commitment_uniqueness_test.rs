#[cfg(test)]
mod commitment_uniqueness_tests {
    use super::*;
    use anchor_lang::prelude::*;
    use anchor_lang::system_program;
    use solana_program_test::*;
    use solana_sdk::{
        account::Account,
        instruction::{AccountMeta, Instruction},
        pubkey::Pubkey,
        rent::Rent,
        signature::{Keypair, Signer},
        system_instruction,
        transaction::Transaction,
    };
    use std::str::FromStr;

    // Test constants
    const TEST_DENOMINATION: u64 = 1_000_000_000; // 1 SOL
    const TEST_VK: [u8; 1024] = [1u8; 1024]; // Mock verifying key

    /// Test that duplicate commitments are prevented
    ///
    /// ⚠️ REQUIRES BPF ENVIRONMENT: This test uses solana-program-test which requires
    /// BPF program processor. Run with `cargo test-sbf` instead.
    ///
    /// See: tests/README.md#known-test-environment-limitations
    #[tokio::test]
    #[ignore = "Requires BPF environment for program processor"]
    async fn test_duplicate_commitment_prevention() {
        let program_id = Pubkey::from_str("9GfWYyfpBF3ZzX5vKC9SUBCZmG3fxg4vCQQNA7rAG3F").unwrap();
        let mut context = setup_test_context().await;
        
        // Initialize zerok state
        let authority = Keypair::new();
        let (pool_state, _) = Pubkey::find_program_address(
            &[b"zerok"],
            &program_id,
        );
        
        let (vault, _) = Pubkey::find_program_address(
            &[b"vault", pool_state.as_ref()],
            &program_id,
        );

        // Fund authority for initialization
        let airdrop_tx = context.banks_client
            .process_transaction(Transaction::new_signed_with_payer(
                &[system_instruction::transfer(
                    &context.payer.pubkey(),
                    &authority.pubkey(),
                    10 * anchor_lang::solana_program::native_token::LAMPORTS_PER_SOL,
                )],
                Some(&context.payer.pubkey()),
                &[&context.payer],
                context.last_blockhash,
            ))
            .await
            .unwrap();

        // Initialize zerok state with mock VK
        let init_data = create_initialize_instruction(
            &program_id,
            &pool_state,
            &vault, 
            &authority.pubkey(),
            TEST_DENOMINATION,
            TEST_VK.to_vec(),
        ).unwrap();

        let init_tx = Transaction::new_signed_with_payer(
            &[init_data],
            Some(&authority.pubkey()),
            &[&authority],
            context.last_blockhash,
        );

        context.banks_client.process_transaction(init_tx).await.unwrap();

        // Test duplicate commitment prevention
        let test_commitment = [1u8; 32]; // Fixed commitment for testing
        
        // Derive commitment PDA
        let (commitment_pda, _) = Pubkey::find_program_address(
            &[b"commitment", test_commitment.as_ref()],
            &program_id,
        );

        println!("🔍 Testing commitment: {:?}", hex::encode(&test_commitment));
        println!("🔍 Expected commitment PDA: {}", commitment_pda);

        // Create depositor keypairs
        let depositor1 = Keypair::new();
        let depositor2 = Keypair::new();

        // Fund depositors
        for depositor in [&depositor1, &depositor2] {
            let fund_tx = Transaction::new_signed_with_payer(
                &[system_instruction::transfer(
                    &context.payer.pubkey(),
                    &depositor.pubkey(),
                    5 * anchor_lang::solana_program::native_token::LAMPORTS_PER_SOL,
                )],
                Some(&context.payer.pubkey()),
                &[&context.payer],
                context.last_blockhash,
            );
            context.banks_client.process_transaction(fund_tx).await.unwrap();
        }

        // First deposit should succeed
        println!("🚀 Attempting first deposit...");
        let first_deposit = create_deposit_instruction(
            &program_id,
            &pool_state,
            &vault,
            &commitment_pda,
            &depositor1.pubkey(),
            test_commitment,
        ).unwrap();

        let first_tx = Transaction::new_signed_with_payer(
            &[first_deposit],
            Some(&depositor1.pubkey()),
            &[&depositor1],
            context.last_blockhash,
        );

        let first_result = context.banks_client.process_transaction(first_tx).await;
        assert!(first_result.is_ok(), "First deposit should succeed: {:?}", first_result);
        println!("✅ First deposit succeeded");

        // Verify commitment PDA was created
        let commitment_account = context.banks_client
            .get_account(commitment_pda)
            .await
            .unwrap();
        assert!(commitment_account.is_some(), "Commitment PDA should exist after first deposit");
        println!("✅ Commitment PDA created: {}", commitment_pda);

        // Second deposit with same commitment should fail
        println!("🚀 Attempting second deposit with same commitment...");
        let second_deposit = create_deposit_instruction(
            &program_id,
            &pool_state,
            &vault,
            &commitment_pda,
            &depositor2.pubkey(),
            test_commitment, // Same commitment!
        ).unwrap();

        let second_tx = Transaction::new_signed_with_payer(
            &[second_deposit],
            Some(&depositor2.pubkey()),
            &[&depositor2],
            context.last_blockhash,
        );

        let second_result = context.banks_client.process_transaction(second_tx).await;
        assert!(second_result.is_err(), "Second deposit should fail due to duplicate commitment");
        
        // Verify it's the right error
        let error_msg = format!("{:?}", second_result.unwrap_err());
        assert!(
            error_msg.contains("already in use") || 
            error_msg.contains("AccountAlreadyInUse") ||
            error_msg.contains("already exists"),
            "Should fail with account already exists error, got: {}", error_msg
        );
        
        println!("✅ Second deposit correctly failed: duplicate commitment prevented");
    }

    /// Test that different commitments succeed
    ///
    /// ⚠️ REQUIRES BPF ENVIRONMENT: This test uses solana-program-test which requires
    /// BPF program processor. Run with `cargo test-sbf` instead.
    ///
    /// See: tests/README.md#known-test-environment-limitations
    #[tokio::test]
    #[ignore = "Requires BPF environment for program processor"]
    async fn test_different_commitments_succeed() {
        let program_id = Pubkey::from_str("9GfWYyfpBF3ZzX5vKC9SUBCZmG3fxg4vCQQNA7rAG3F").unwrap();
        let mut context = setup_test_context().await;
        
        // Initialize zerok state (similar setup as above)
        let authority = Keypair::new();
        let (pool_state, _) = Pubkey::find_program_address(&[b"zerok"], &program_id);
        let (vault, _) = Pubkey::find_program_address(&[b"vault", pool_state.as_ref()], &program_id);

        // Fund and initialize
        let fund_auth_tx = Transaction::new_signed_with_payer(
            &[system_instruction::transfer(
                &context.payer.pubkey(),
                &authority.pubkey(),
                10 * anchor_lang::solana_program::native_token::LAMPORTS_PER_SOL,
            )],
            Some(&context.payer.pubkey()),
            &[&context.payer],
            context.last_blockhash,
        );
        context.banks_client.process_transaction(fund_auth_tx).await.unwrap();

        let init_data = create_initialize_instruction(
            &program_id, &pool_state, &vault, &authority.pubkey(),
            TEST_DENOMINATION, TEST_VK.to_vec(),
        ).unwrap();
        let init_tx = Transaction::new_signed_with_payer(
            &[init_data], Some(&authority.pubkey()), &[&authority], context.last_blockhash,
        );
        context.banks_client.process_transaction(init_tx).await.unwrap();

        // Test different commitments
        let commitment1 = [1u8; 32];
        let commitment2 = [2u8; 32];
        
        let (commitment_pda1, _) = Pubkey::find_program_address(
            &[b"commitment", commitment1.as_ref()], &program_id,
        );
        let (commitment_pda2, _) = Pubkey::find_program_address(
            &[b"commitment", commitment2.as_ref()], &program_id,
        );

        // Different PDAs should be generated
        assert_ne!(commitment_pda1, commitment_pda2, "Different commitments should generate different PDAs");
        println!("✅ Different commitments generate different PDAs");

        // Create depositors
        let depositor1 = Keypair::new();
        let depositor2 = Keypair::new();

        // Fund depositors
        for depositor in [&depositor1, &depositor2] {
            let fund_tx = Transaction::new_signed_with_payer(
                &[system_instruction::transfer(
                    &context.payer.pubkey(), &depositor.pubkey(),
                    5 * anchor_lang::solana_program::native_token::LAMPORTS_PER_SOL,
                )],
                Some(&context.payer.pubkey()), &[&context.payer], context.last_blockhash,
            );
            context.banks_client.process_transaction(fund_tx).await.unwrap();
        }

        // Both deposits should succeed (different commitments)
        let deposit1 = create_deposit_instruction(
            &program_id, &pool_state, &vault, &commitment_pda1, &depositor1.pubkey(), commitment1,
        ).unwrap();
        let deposit2 = create_deposit_instruction(
            &program_id, &pool_state, &vault, &commitment_pda2, &depositor2.pubkey(), commitment2,
        ).unwrap();

        let tx1 = Transaction::new_signed_with_payer(
            &[deposit1], Some(&depositor1.pubkey()), &[&depositor1], context.last_blockhash,
        );
        let tx2 = Transaction::new_signed_with_payer(
            &[deposit2], Some(&depositor2.pubkey()), &[&depositor2], context.last_blockhash,
        );

        let result1 = context.banks_client.process_transaction(tx1).await;
        let result2 = context.banks_client.process_transaction(tx2).await;

        assert!(result1.is_ok(), "First deposit (commitment1) should succeed: {:?}", result1);
        assert!(result2.is_ok(), "Second deposit (commitment2) should succeed: {:?}", result2);
        
        println!("✅ Both deposits with different commitments succeeded");
    }

    #[tokio::test]
    async fn test_commitment_pda_derivation() {
        let program_id = Pubkey::from_str("9GfWYyfpBF3ZzX5vKC9SUBCZmG3fxg4vCQQNA7rAG3F").unwrap();
        
        // Test PDA derivation consistency
        let test_commitment = [42u8; 32];
        
        let (pda1, bump1) = Pubkey::find_program_address(
            &[b"commitment", test_commitment.as_ref()],
            &program_id,
        );
        
        let (pda2, bump2) = Pubkey::find_program_address(
            &[b"commitment", test_commitment.as_ref()],
            &program_id,
        );

        // PDA derivation should be deterministic
        assert_eq!(pda1, pda2, "PDA derivation should be deterministic");
        assert_eq!(bump1, bump2, "Bump should be deterministic");
        
        // Different commitments should produce different PDAs
        let different_commitment = [43u8; 32];
        let (pda3, _) = Pubkey::find_program_address(
            &[b"commitment", different_commitment.as_ref()],
            &program_id,
        );
        
        assert_ne!(pda1, pda3, "Different commitments should produce different PDAs");
        
        println!("✅ PDA derivation is deterministic and unique");
        println!("   Commitment: {:?}", hex::encode(&test_commitment));
        println!("   PDA: {}", pda1);
        println!("   Bump: {}", bump1);
    }

    // Helper functions
    async fn setup_test_context() -> ProgramTestContext {
        let program_id = Pubkey::from_str("9GfWYyfpBF3ZzX5vKC9SUBCZmG3fxg4vCQQNA7rAG3F").unwrap();
        let mut program_test = ProgramTest::new(
            "zerok",
            program_id,
            None, // Use the compiled BPF program
        );
        
        program_test.start_with_context().await
    }

    fn create_initialize_instruction(
        program_id: &Pubkey,
        pool_state: &Pubkey,
        vault: &Pubkey,
        authority: &Pubkey,
        denomination: u64,
        verifying_key: Vec<u8>,
    ) -> Result<Instruction> {
        // This is a simplified version - in real implementation would use Anchor's instruction builder
        let accounts = vec![
            AccountMeta::new(*pool_state, false),
            AccountMeta::new(*vault, false),
            AccountMeta::new(*authority, true),
            AccountMeta::new_readonly(system_program::ID, false),
        ];

        // Simplified instruction data (in reality would use Anchor's serialization)
        let mut data = vec![175, 175, 109, 31, 13, 152, 155, 237]; // Initialize discriminator
        data.extend_from_slice(&denomination.to_le_bytes());
        data.extend_from_slice(&(verifying_key.len() as u32).to_le_bytes());
        data.extend_from_slice(&verifying_key);

        Ok(Instruction {
            program_id: *program_id,
            accounts,
            data,
        })
    }

    fn create_deposit_instruction(
        program_id: &Pubkey,
        pool_state: &Pubkey,
        vault: &Pubkey,
        commitment_record: &Pubkey,
        depositor: &Pubkey,
        commitment: [u8; 32],
    ) -> Result<Instruction> {
        let accounts = vec![
            AccountMeta::new(*pool_state, false),
            AccountMeta::new(*vault, false),
            AccountMeta::new(*commitment_record, false),
            AccountMeta::new(*depositor, true),
            AccountMeta::new_readonly(system_program::ID, false),
        ];

        // Simplified instruction data
        let mut data = vec![242, 35, 198, 137, 82, 225, 242, 182]; // Deposit discriminator
        data.extend_from_slice(&commitment);

        Ok(Instruction {
            program_id: *program_id,
            accounts,
            data,
        })
    }
}

// Helper for hex encoding in tests
mod hex {
    pub fn encode(data: &[u8]) -> String {
        data.iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>()
    }
}