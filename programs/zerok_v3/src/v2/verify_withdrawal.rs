//! Withdrawal proof verification helper
//! Isolated in separate function to reduce parent stack frame

use anchor_lang::prelude::*;
use groth16_solana::groth16::{Groth16Verifier, Groth16Verifyingkey};
use crate::ZerokError;

/// Verify withdrawal proof using Groth16
///
/// This function is #[inline(never)] to keep all verification locals
/// (VK struct, proof arrays, verifier) in a separate stack frame
/// that is freed when the function returns.
///
/// # Arguments
/// * `vk_bytes` - Borrowed VK buffer from state (no copy)
/// * `proof` - Borrowed proof bytes (no copy)
/// * `public_inputs` - 8 public inputs as 32-byte arrays
///
/// # Stack Impact
/// - VK deserialization: ~1,040B (freed on return)
/// - Proof parsing: ~256B (freed on return)
/// - Verifier: ~200B (freed on return)
/// - Total: ~1,500B isolated in this frame
#[inline(never)]
pub fn verify_withdrawal_proof(
    vk_bytes: &[u8],
    proof: &[u8],
    public_inputs: &[[u8; 32]; 8],
) -> Result<()> {
    // Validate proof length
    require!(
        proof.len() == 256,
        ZerokError::InvalidProofLength
    );

    // Deserialize VK from borrowed buffer (no copies in parent)
    // VK length is validated during deserialization based on nr_pubinputs
    let vk = crate::deserialize_verifying_key(vk_bytes)?;

    // Parse proof components from borrowed buffer
    // Use Box to keep arrays on heap, not stack
    let proof_a: Box<[u8; 64]> = proof[0..64]
        .to_vec()
        .into_boxed_slice()
        .try_into()
        .map_err(|_| ZerokError::InvalidProofFormat)?;

    let proof_b: Box<[u8; 128]> = proof[64..192]
        .to_vec()
        .into_boxed_slice()
        .try_into()
        .map_err(|_| ZerokError::InvalidProofFormat)?;

    let proof_c: Box<[u8; 64]> = proof[192..256]
        .to_vec()
        .into_boxed_slice()
        .try_into()
        .map_err(|_| ZerokError::InvalidProofFormat)?;

    // Step 1 Invariant: Log proof component previews (program-side, pre-verification)
    msg!("🔐 Step 1 Invariants (Program-side, received proof components):");
    msg!("  pi_a[0..8]:   {:02x?}", &proof_a[0..8]);
    msg!("  pi_a[32..40]: {:02x?}", &proof_a[32..40]);
    msg!("  pi_b[0..8]:   {:02x?}", &proof_b[0..8]);
    msg!("  pi_b[64..72]: {:02x?}", &proof_b[64..72]);
    msg!("  pi_c[0..8]:   {:02x?}", &proof_c[0..8]);

    // DIAGNOSTIC: Log public inputs digest for Phase B comparison
    use anchor_lang::solana_program::keccak;
    let mut pi_flat = [0u8; 256];
    for (i, input) in public_inputs.iter().enumerate() {
        pi_flat[i*32..(i+1)*32].copy_from_slice(input);
    }
    // Diagnostic logging removed to save compute units (proof components verified correct)

    // Create and run verifier using native syscalls
    // Note: groth16-solana negates proof_a internally (we pass raw A from snarkjs)
    let mut verifier = Groth16Verifier::new(
        &proof_a,
        &proof_b,
        &proof_c,
        public_inputs,
        &vk,
    ).map_err(|e| {
        msg!("Failed to create verifier: {:?}", e);
        ZerokError::VerifierCreationFailed
    })?;

    verifier.verify().map_err(|e| {
        msg!("Proof verification failed: {:?}", e);
        ZerokError::InvalidProof
    })?;

    msg!("✓ Proof verified successfully");
    Ok(())
}
