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
  protocolWallet: string;
  ringCapacity: number;
  // Shard configuration
  shardCapacity?: number;
  numShards?: number;
  allocatedShards?: number;
}
