/**
 * Deposit Session Journal — persists multi-batch deposit progress to localStorage.
 *
 * Closes the safety gap where notes are only saved after ALL batches confirm.
 * If the browser crashes mid-deposit, the journal enables recovery on reconnect.
 *
 * Write-before-send rule: session is persisted BEFORE sending the first batch.
 *
 * Complementary to memo-based recovery: if journal is lost (localStorage cleared),
 * on-chain memo recovery still works. Belt and suspenders.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type SessionStatus = 'sending' | 'partial' | 'complete' | 'failed';

export interface BatchEntry {
  index: number;
  noteCount: number;
  seedHex: string;          // batch seed as hex string
  denominations: string[];  // lamports as strings per note in batch
  signature?: string;       // set after successful send
  confirmed: boolean;
  notesSaved: boolean;
}

export interface DepositSession {
  sessionId: string;
  createdAt: string;
  walletPubkey: string;
  programId: string;
  totalAmountLamports: string;
  splitPlan: string[];       // denomination lamports in greedySplit order
  batches: BatchEntry[];
  status: SessionStatus;
}

// ─── Storage Keys ────────────────────────────────────────────────────────────

function sessionKey(wallet: string): string {
  return `zerok:deposit-session:${wallet}`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Create and persist a new deposit session BEFORE sending any batches. */
export function createSession(
  wallet: string,
  programId: string,
  totalAmountLamports: bigint,
  splitPlan: bigint[],
  batchSeeds: Uint8Array[],
  batchDenominations: bigint[][],
): DepositSession {
  const session: DepositSession = {
    sessionId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    walletPubkey: wallet,
    programId,
    totalAmountLamports: totalAmountLamports.toString(),
    splitPlan: splitPlan.map(d => d.toString()),
    batches: batchSeeds.map((seed, i) => ({
      index: i,
      noteCount: batchDenominations[i].length,
      seedHex: Array.from(seed).map(b => b.toString(16).padStart(2, '0')).join(''),
      denominations: batchDenominations[i].map(d => d.toString()),
      signature: undefined,
      confirmed: false,
      notesSaved: false,
    })),
    status: 'sending',
  };
  saveSession(wallet, session);
  console.log(`[DepositSession] Created: ${session.sessionId}, ${session.batches.length} batches, ${Number(totalAmountLamports) / 1e9} SOL`);
  return session;
}

/** Update a batch after it's been sent (signature received). */
export function markBatchSent(wallet: string, batchIndex: number, signature: string): void {
  const session = loadSession(wallet);
  if (!session) return;
  const batch = session.batches[batchIndex];
  if (batch) {
    batch.signature = signature;
  }
  console.log(`[DepositSession] Batch ${batchIndex + 1}/${session.batches.length} SENT: sig=${signature.slice(0, 20)}...`);
  saveSession(wallet, session);
}

/** Update a batch after on-chain confirmation. */
export function markBatchConfirmed(wallet: string, batchIndex: number): void {
  const session = loadSession(wallet);
  if (!session) return;
  const batch = session.batches[batchIndex];
  if (batch) {
    batch.confirmed = true;
  }
  // Check if all batches are confirmed
  const allConfirmed = session.batches.every(b => b.confirmed);
  if (!allConfirmed && session.batches.some(b => b.confirmed)) {
    session.status = 'partial';
    console.log(`[DepositSession] Batch ${batchIndex + 1}/${session.batches.length} CONFIRMED (session: partial)`);
  } else if (allConfirmed) {
    console.log(`[DepositSession] Batch ${batchIndex + 1}/${session.batches.length} CONFIRMED (all batches confirmed)`);
  } else {
    console.log(`[DepositSession] Batch ${batchIndex + 1}/${session.batches.length} CONFIRMED`);
  }
  saveSession(wallet, session);
}

/** Update a batch after notes have been saved to localStorage. */
export function markBatchNotesSaved(wallet: string, batchIndex: number): void {
  const session = loadSession(wallet);
  if (!session) return;
  const batch = session.batches[batchIndex];
  if (batch) {
    batch.notesSaved = true;
  }
  // Check if session is complete
  const allSaved = session.batches.every(b => b.notesSaved);
  if (allSaved) {
    session.status = 'complete';
    console.log(`[DepositSession] Complete: ${session.sessionId}`);
  }
  saveSession(wallet, session);
}

/** Mark session as complete (all batches confirmed and notes saved). */
export function markSessionComplete(wallet: string): void {
  const session = loadSession(wallet);
  if (!session) return;
  session.status = 'complete';
  saveSession(wallet, session);
  console.log(`[DepositSession] Complete: ${session.sessionId}`);
}

/** Mark session as failed. */
export function markSessionFailed(wallet: string): void {
  const session = loadSession(wallet);
  if (!session) return;
  session.status = 'failed';
  console.warn(`[DepositSession] Session FAILED: ${session.sessionId}, ${session.batches.filter(b => b.confirmed).length}/${session.batches.length} confirmed`);
  saveSession(wallet, session);
}

/** Load the current session for a wallet, or null if none/complete. */
export function loadSession(wallet: string): DepositSession | null {
  try {
    const raw = localStorage.getItem(sessionKey(wallet));
    if (!raw) return null;
    return JSON.parse(raw) as DepositSession;
  } catch {
    return null;
  }
}

/** Load incomplete session (status !== 'complete'). Returns null if no incomplete session. */
export function loadIncompleteSession(wallet: string): DepositSession | null {
  const session = loadSession(wallet);
  if (!session || session.status === 'complete') return null;
  return session;
}

/** Clear session for wallet. */
export function clearSession(wallet: string): void {
  try {
    localStorage.removeItem(sessionKey(wallet));
  } catch { /* non-fatal */ }
}

/** Get summary of incomplete session for UI display. */
export function getSessionSummary(session: DepositSession): {
  totalSol: number;
  depositedSol: number;
  confirmedBatches: number;
  totalBatches: number;
  unsavedBatches: number;
  unsentBatches: number;
} {
  const totalSol = Number(BigInt(session.totalAmountLamports)) / 1e9;
  let depositedLamports = 0n;
  let confirmedBatches = 0;
  let unsavedBatches = 0;
  let unsentBatches = 0;

  for (const batch of session.batches) {
    if (batch.confirmed) {
      confirmedBatches++;
      const batchTotal = batch.denominations.reduce((sum, d) => sum + BigInt(d), 0n);
      depositedLamports += batchTotal;
      if (!batch.notesSaved) unsavedBatches++;
    } else if (!batch.signature) {
      unsentBatches++;
    }
  }

  return {
    totalSol,
    depositedSol: Number(depositedLamports) / 1e9,
    confirmedBatches,
    totalBatches: session.batches.length,
    unsavedBatches,
    unsentBatches,
  };
}

// ─── Internal ────────────────────────────────────────────────────────────────

function saveSession(wallet: string, session: DepositSession): void {
  try {
    localStorage.setItem(sessionKey(wallet), JSON.stringify(session));
  } catch { /* localStorage full — non-fatal */ }
}
