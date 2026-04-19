# Week 2: Three-Layer Note Recovery — Your Wallet is Your Key

## The Problem

In most privacy protocols, if you lose the file containing your private note, your funds are gone forever. This is the single biggest barrier to mainstream adoption — users are terrified of losing access.

We needed to solve this without compromising privacy.

## The Solution: Three Layers of Note Persistence

ZeroK uses a defense-in-depth approach to note recovery. Each layer independently protects the user, and they stack for maximum resilience.

### Layer 1: Local Cache (Instant)

Every note is saved to browser localStorage the moment it's created, scoped by chain ID and wallet address. This survives:
- Page refreshes
- Tab closures
- Browser restarts

The cache uses schema versioning (`CACHE_SCHEMA_VERSION = 4`) to auto-clear on breaking changes. Notes are stored per-wallet, per-chain — so devnet notes never interfere with mainnet.

**Code**: `web/src/lib/note-cache.ts`

### Layer 2: On-Chain Encrypted Memos (Cross-Device Recovery)

This is the breakthrough. When you deposit, ZeroK encrypts your note using a key derived from your wallet's signature:

```
wallet.signMessage("zerok-note-recovery-v1") → SHA-256 → AES-256-GCM key
```

The encrypted note is embedded directly in the deposit transaction as a Solana Memo instruction. It's stored **on-chain forever** alongside your deposit.

To recover: reconnect the same wallet on any browser, any device. ZeroK scans the pool's transaction history, finds memos encrypted with your wallet's key, decrypts them locally, and restores your private balance.

**Key innovations**:
- **V5 Seed Memos**: Instead of one memo per note (expensive), we use one seed per batch. A single 157-byte memo can recover 6+ notes. This is an 80% reduction in memo overhead.
- **Pool-based scanning**: We scan the pool's state PDA (bounded, ZeroK-only transactions) — not your wallet's full history. This is faster and more private.
- **Checkpoint system**: Recovery scans resume from where they left off, not from genesis. Reconnecting after the first scan is near-instant.

**Code**: `web/src/lib/note-encryption.ts`, `web/src/lib/note-recovery.ts`

### Layer 3: Downloadable Note Files (Offline Backup)

For users who want maximum control, ZeroK supports downloading note files. Each file contains the cryptographic secrets needed for withdrawal — nullifier, secret, leaf index, Merkle path, and root.

This is the traditional "belt and suspenders" approach: even if you lose your wallet AND clear your browser, a saved note file can still withdraw your funds.

**Code**: `web/src/lib/note-export.ts`

## How They Work Together

| Scenario | Layer 1 (Cache) | Layer 2 (On-Chain) | Layer 3 (File) |
|----------|:---:|:---:|:---:|
| Refresh page | ✅ | — | — |
| Clear browser data | ❌ | ✅ | ✅ |
| Switch to new device | ❌ | ✅ | ✅ |
| Lose wallet seed phrase | ❌ | ❌ | ✅ |
| Lose everything | ❌ | ❌ | ❌ |

The only way to permanently lose funds is to lose **both** the wallet seed phrase **and** any downloaded backup files. Layer 2 (on-chain memos) means that for most users, their wallet IS their recovery key — no file management needed.

## Verified on Mainnet

- Cross-browser recovery tested: deposited in Edge, recovered in Chrome — 11 notes, all withdrawn
- Interrupted session tested: closed browser mid-deposit, reopened, all notes recovered
- V5 seed memo: `[PoolRecovery] V5 seed memo → 9 notes (sig=...)` — one memo recovers 9 notes

## Files Changed

- `web/src/lib/note-encryption.ts` — V3/V4/V5 memo encryption + wallet-derived key derivation
- `web/src/lib/note-recovery.ts` — Pool-based scanning with checkpoint system and V5 seed decryption
- `web/src/lib/deposit-event.ts` — Multi-event parsing for batch deposits (parse all DepositProofData events from one tx)
- `web/src/types/note.ts` — V2Note type with protocol version routing
