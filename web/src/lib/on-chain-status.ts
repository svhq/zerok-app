import { PublicKey } from '@solana/web3.js';
import { Note, NoteHealth, PoolConfig } from '@/types/note';
import { getPoolConfig } from './pool-config';
import { executeWithRotation } from './resilient-connection';

// PDA seeds
const NULLIFIER_SEED = 'nullifier';

/**
 * Derive nullifier PDA for a note using its pool config
 */
export function deriveNullifierPda(nullifierHash: string, poolConfig: PoolConfig): PublicKey {
  // Remove 0x prefix if present
  const nullifierHashHex = nullifierHash.replace('0x', '');
  const nullifierHashBuffer = Buffer.from(nullifierHashHex, 'hex');

  const statePda = new PublicKey(poolConfig.statePda);
  const programId = new PublicKey(poolConfig.programId);

  const [nullifierPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(NULLIFIER_SEED), statePda.toBuffer(), nullifierHashBuffer],
    programId
  );

  return nullifierPda;
}

/**
 * Check if a single note has been spent on-chain
 * Uses executeWithRotation internally for high rate limits via Helius.
 */
export async function checkNoteSpent(
  note: Note
): Promise<boolean> {
  try {
    const poolConfig = getPoolConfig(note.poolId);
    const nullifierPda = deriveNullifierPda(note.nullifierHash, poolConfig);
    const accountInfo = await executeWithRotation(
      (conn) => conn.getAccountInfo(nullifierPda)
    );
    return accountInfo !== null; // Account exists = note is spent
  } catch (error) {
    console.error('Failed to check note status:', error);
    throw error;
  }
}

export interface NoteOnChainStatus {
  noteId: string;
  isSpent: boolean;
  error?: string;
}

/**
 * Batch check multiple notes for spent status
 * Uses getMultipleAccountsInfo for efficiency
 * Notes can be from different pools - each gets the correct config
 * Uses executeWithRotation internally for high rate limits via Helius.
 */
export async function batchCheckNotesSpent(
  notes: Note[]
): Promise<NoteOnChainStatus[]> {
  if (notes.length === 0) return [];

  try {
    // Derive all nullifier PDAs (each note uses its own pool config)
    const nullifierPdas = notes.map(note => {
      const poolConfig = getPoolConfig(note.poolId);
      return deriveNullifierPda(note.nullifierHash, poolConfig);
    });

    // Batch fetch account info (max 100 per request)
    const batchSize = 100;
    const results: NoteOnChainStatus[] = [];

    for (let i = 0; i < nullifierPdas.length; i += batchSize) {
      const batch = nullifierPdas.slice(i, i + batchSize);
      const batchNotes = notes.slice(i, i + batchSize);

      const accountInfos = await executeWithRotation(
        (conn) => conn.getMultipleAccountsInfo(batch)
      );

      for (let j = 0; j < accountInfos.length; j++) {
        results.push({
          noteId: batchNotes[j].id,
          isSpent: accountInfos[j] !== null,
        });
      }
    }

    return results;
  } catch (error) {
    console.error('Failed to batch check note status:', error);
    // Return error status for all notes
    return notes.map(note => ({
      noteId: note.id,
      isSpent: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/**
 * Fetch current leaf count from pool metadata account
 * This is needed to calculate note health
 * Uses executeWithRotation internally for high rate limits via Helius.
 *
 * For sharded pools, the global_head is stored in the RootRingMetadata account:
 * - Offset 0-8: discriminator (8 bytes)
 * - Offset 8-16: version (u64)
 * - Offset 16-20: total_capacity (u32)
 * - Offset 20-24: shard_capacity (u32)
 * - Offset 24-28: num_shards (u32)
 * - Offset 28-32: global_head (u32) <- this is what we need
 */
export async function fetchCurrentLeafCount(
  poolConfig: PoolConfig
): Promise<number> {
  try {
    // Read from metadata account for sharded pools
    const metadataPda = new PublicKey(poolConfig.metadataPda);
    const accountInfo = await executeWithRotation(
      (conn) => conn.getAccountInfo(metadataPda)
    );

    if (!accountInfo || !accountInfo.data) {
      throw new Error('Pool metadata account not found');
    }

    const data = accountInfo.data;

    // Read global_head (u32) at offset 28
    // Layout: 8 disc + 8 version + 4 total_cap + 4 shard_cap + 4 num_shards = 28
    const globalHead = data.readUInt32LE(28);

    return globalHead;
  } catch (error) {
    console.error('Failed to fetch current leaf count:', error);
    // Return a safe default that won't mark notes as expired
    return 0;
  }
}

/**
 * Calculate note health based on current pool state
 *
 * The "health" of a note represents how many more deposits can occur before
 * this note's commitment gets pushed out of the Merkle tree ring buffer.
 *
 * Formula: depositsRemaining = (leafIndex + ringCapacity) - currentLeafCount
 *
 * If leafIndex is -1 (not yet parsed from logs), we estimate it as the most
 * recent deposit position (currentLeafCount - 1).
 */
export function calculateNoteHealth(
  leafIndex: number,
  currentLeafCount: number,
  ringCapacity: number
): NoteHealth {
  // Handle unknown leafIndex (-1 placeholder from deposit)
  // Assume it's a recent deposit at the current head position
  const effectiveLeafIndex = leafIndex >= 0 ? leafIndex : Math.max(0, currentLeafCount - 1);

  // Formula: depositsRemaining = (leafIndex + ringCapacity) - currentLeafCount
  const depositsRemaining = (effectiveLeafIndex + ringCapacity) - currentLeafCount;

  // Health is percentage of remaining deposits vs ring capacity
  const healthPercent = Math.max(0, Math.min(100, (depositsRemaining / ringCapacity) * 100));

  let status: NoteHealth['status'] = 'ready';
  if (depositsRemaining <= 0) {
    status = 'expired';
  } else if (healthPercent < 30) {
    status = 'expiring';
  }

  return {
    depositsRemaining: Math.max(0, depositsRemaining),
    healthPercent,
    status,
  };
}

/**
 * Full status check for a list of notes
 * Checks both on-chain spent status and calculates health
 */
export interface FullNoteStatus {
  noteId: string;
  isSpent: boolean;
  health: NoteHealth;
  finalStatus: 'ready' | 'expiring' | 'spent' | 'expired' | 'error';
  error?: string;
}

/**
 * Full status check for a list of notes
 * Checks both on-chain spent status and calculates health
 * Uses executeWithRotation internally for high rate limits via Helius.
 */
export async function getFullNoteStatuses(
  notes: Note[]
): Promise<FullNoteStatus[]> {
  if (notes.length === 0) return [];

  // Group notes by pool to fetch leaf counts efficiently
  const poolIds = [...new Set(notes.map(n => n.poolId))];
  const poolConfigs = new Map<string, PoolConfig>();
  for (const poolId of poolIds) {
    poolConfigs.set(poolId, getPoolConfig(poolId));
  }

  // Fetch leaf counts for each pool and check spent status in parallel
  const leafCountPromises = poolIds.map(async poolId => {
    const config = poolConfigs.get(poolId)!;
    const count = await fetchCurrentLeafCount(config);
    return { poolId, count };
  });

  const [leafCountResults, spentStatuses] = await Promise.all([
    Promise.all(leafCountPromises),
    batchCheckNotesSpent(notes),
  ]);

  // Build leaf count map
  const leafCountMap = new Map<string, number>();
  for (const { poolId, count } of leafCountResults) {
    leafCountMap.set(poolId, count);
  }

  // Build results
  return notes.map((note, index) => {
    const spentStatus = spentStatuses[index];
    const poolConfig = poolConfigs.get(note.poolId)!;
    const currentLeafCount = leafCountMap.get(note.poolId) ?? 0;
    const health = calculateNoteHealth(note.leafIndex, currentLeafCount, poolConfig.ringCapacity);

    let finalStatus: FullNoteStatus['finalStatus'];
    if (spentStatus.error) {
      finalStatus = 'error';
    } else if (spentStatus.isSpent) {
      finalStatus = 'spent';
    } else if (health.status === 'expired') {
      finalStatus = 'expired';
    } else if (health.status === 'expiring') {
      finalStatus = 'expiring';
    } else {
      finalStatus = 'ready';
    }

    return {
      noteId: note.id,
      isSpent: spentStatus.isSpent,
      health,
      finalStatus,
      error: spentStatus.error,
    };
  });
}
