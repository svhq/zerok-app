export interface Note {
  id: string;              // commitment hash (unique identifier)
  poolId: string;          // pool identifier
  commitment: string;      // commitment hash
  nullifierSecret: string; // secret for nullifier
  noteSecret: string;      // secret for note
  nullifierHash: string;   // computed nullifier hash
  leafIndex: number;       // position in Merkle tree
  rootAfter: string;       // Merkle root after insertion
  siblings: string[];      // Merkle path siblings
  depositTx: string;       // deposit transaction signature
  createdAt: string;       // ISO timestamp
  status: NoteStatus;
  spentTx?: string;        // withdrawal transaction signature (if spent)
  spentAt?: string;        // ISO timestamp of withdrawal
}

export type NoteStatus = 'pending' | 'confirmed' | 'spent' | 'expired';

// ─── v2 JoinSplit note ────────────────────────────────────────────────────────

/**
 * Note lifecycle: unspent → pending_spend → spent
 *
 * - unspent:       available for withdrawal (included in spendable balance)
 * - pending_spend: withdrawal in progress, not yet confirmed on-chain
 *                  (excluded from spendable balance, reverts to unspent on failure)
 * - spent:         nullifier PDA exists on-chain (irreversible)
 */
export type V2NoteStatus = 'unspent' | 'pending_spend' | 'spent';

// v2 notes hold arbitrary amounts (not fixed denominations).
// Recovered from `zerok:v2:` memos in the wallet's tx history.
export interface V2Note {
  id: string;           // commitment hash (hex)
  amount: string;       // lamports as string (arbitrary amount, not denomination)
  nullifier: string;    // field element as decimal string
  secret: string;       // field element as decimal string
  commitment: string;   // Poseidon(amount, nullifier, secret) as decimal string
  nullifierHash: string;// Poseidon(nullifier) — public spend tag
  leafIndex: number;    // position in v2 Merkle tree
  merkleRoot: string;   // root after insertion (hex)
  pathElements: string[];// Merkle path (decimal strings)
  pathIndices: number[];
  status: V2NoteStatus; // on-chain state is source of truth (set ONLY by reconcile pipeline or withdrawal lifecycle)
  withdrawable?: boolean; // computed: has valid path + root in history (set by reconcile pipeline, never determines spend status)
  depositTx?: string;
  withdrawTx?: string;
  createdAt: string;    // ISO timestamp
  noteVersion?: 1 | 2 | 3; // Protocol version — explicit tag for routing spent-checks/withdrawals
}

export interface NoteHealth {
  depositsRemaining: number;
  healthPercent: number;
  status: 'ready' | 'expiring' | 'expired';
}

export interface PoolConfig {
  poolId: string;
  programId: string;
  statePda: string;
  vaultPda: string;
  vkPda: string;
  metadataPda: string;      // Root ring metadata PDA
  rootRingPda: string;      // Root ring PDA (legacy K=128 ring buffer)
  shardPdas: string[];      // Array of shard PDAs
  denominationLamports: number;  // Store as number to avoid hydration issues
  denominationDisplay: string;
  rpcUrl: string;
  relayerWallet: string;
  ringCapacity: number;
  // Shard configuration
  shardCapacity?: number;
  numShards?: number;
  allocatedShards?: number;
  // Protocol version — 'v1' = fixed denomination, 'v2' = arbitrary amount JoinSplit
  version?: 'v1' | 'v2';
}
