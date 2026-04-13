use anchor_lang::prelude::*;

/// Commitment uniqueness guard - existence means commitment used
/// Mathematical guarantee: commitment → PDA mapping is bijective
/// Leverages Solana's account model for O(1) uniqueness enforcement
#[account]
pub struct CommitmentRecord {}

/// Nullifier double-spend prevention - existence means note spent
/// Elegant O(1) lookup leveraging Solana's account model
/// Based on proven pattern from solana-mixer-core
#[account]
pub struct Nullifier {}