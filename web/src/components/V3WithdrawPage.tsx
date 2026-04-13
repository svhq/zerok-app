'use client';

/**
 * V3 Withdrawal Page — Amount-First Send
 *
 * User enters amount → system auto-selects best note combination.
 * Shows denomination cards grouped by size.
 * Advanced toggle reveals manual note selection.
 */

import { useState, useCallback, useMemo } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { V2Note } from '@/types/note';
import { Button } from './ui';
import { getCachedKey } from '@/lib/note-encryption';
import { executeV3Withdrawal, generateV3Proof, submitV3ToRelay, isNoteWithdrawable } from '@/lib/v3-withdraw';
import { downloadNote, parseUploadedNote } from '@/lib/note-export';
import { formatSol } from '@/lib/pool-config';
import { saveNote, updateNoteStatus } from '@/lib/note-cache';
import { batchCheckV2NotesSpent, isRootInHistory } from '@/lib/sdk/poseidon';
import { useRef } from 'react';
import { V2_PROGRAM_ID, deriveV2PoolPDAs } from '@/lib/v2-config';

// ─── Note selection algorithm ───────────────────────────────────────────────

/** Given a target amount, find the best note selection (greedy, largest first, oldest first within same denomination). */
function findBestSelection(targetLamports: bigint, available: V2Note[]): V2Note[] {
  // Sort by denomination descending, then by leafIndex ascending (oldest first)
  const sorted = [...available].sort((a, b) => {
    const da = BigInt(a.amount), db = BigInt(b.amount);
    if (da !== db) return da > db ? -1 : 1;
    return (a.leafIndex ?? 0) - (b.leafIndex ?? 0); // oldest first within same denom
  });
  const picked: V2Note[] = [];
  let remaining = targetLamports;
  for (const note of sorted) {
    if (remaining <= 0n) break;
    const d = BigInt(note.amount);
    if (d <= remaining) {
      picked.push(note);
      remaining -= d;
    }
  }
  return remaining === 0n ? picked : []; // only return if exact match
}

/** Find nearest sendable amounts given available notes. */
function findNearestOptions(targetLamports: bigint, available: V2Note[]): {
  exact: V2Note[] | null;
  lower: { amount: bigint; notes: V2Note[] } | null;
  higher: { amount: bigint; notes: V2Note[] } | null;
} {
  if (targetLamports <= 0n || available.length === 0) return { exact: null, lower: null, higher: null };

  // Try exact
  const exact = findBestSelection(targetLamports, available);
  if (exact.length > 0) return { exact, lower: null, higher: null };

  // Find lower: largest amount <= target using greedy (oldest first within same denom)
  const sorted = [...available].sort((a, b) => {
    const da = BigInt(a.amount), db = BigInt(b.amount);
    if (da !== db) return da > db ? -1 : 1;
    return (a.leafIndex ?? 0) - (b.leafIndex ?? 0);
  });
  const lowerNotes: V2Note[] = [];
  let lowerSum = 0n;
  for (const note of sorted) {
    const d = BigInt(note.amount);
    if (lowerSum + d <= targetLamports) {
      lowerNotes.push(note);
      lowerSum += d;
    }
  }
  const lower = lowerSum > 0n ? { amount: lowerSum, notes: lowerNotes } : null;

  // Find higher: smallest amount > target from all possible combinations
  // Strategy: try (a) single large note, (b) lower set + one more note — pick smallest
  let higher: { amount: bigint; notes: V2Note[] } | null = null;

  // Option A: single note > target (simplest, often best)
  for (const note of sorted) {
    if (BigInt(note.amount) > targetLamports) {
      higher = { amount: BigInt(note.amount), notes: [note] };
      break; // sorted desc, so first match is smallest single note > target
    }
  }

  // Option B: lower set + one more unused note
  const usedNullifiers = new Set(lowerNotes.map(n => n.nullifier));
  const remaining = sorted.filter(n => !usedNullifiers.has(n.nullifier));
  const smallestRemaining = [...remaining].sort((a, b) => {
    const da = BigInt(a.amount), db = BigInt(b.amount);
    return da < db ? -1 : da > db ? 1 : 0;
  });
  for (const note of smallestRemaining) {
    const candidateAmount = lowerSum + BigInt(note.amount);
    if (candidateAmount > targetLamports) {
      // Pick whichever is closer to target: single note or lower+extra
      if (!higher || candidateAmount < higher.amount) {
        higher = { amount: candidateAmount, notes: [...lowerNotes, note] };
      }
      break;
    }
  }

  return { exact: null, lower, higher };
}

/** Group notes by denomination for card display. */
function groupByDenom(noteList: V2Note[]): { denom: bigint; denomSol: number; count: number; notes: V2Note[] }[] {
  const map = new Map<string, V2Note[]>();
  for (const n of noteList) {
    const key = n.amount;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(n);
  }
  return Array.from(map.entries())
    .map(([key, notes]) => ({ denom: BigInt(key), denomSol: Number(BigInt(key)) / 1e9, count: notes.length, notes }))
    .sort((a, b) => a.denom > b.denom ? -1 : a.denom < b.denom ? 1 : 0);
}

// ─── Nearest options display (recommends nearest, not always lower) ─────────

function NearestOptions({ options, sendLamports, onSelect }: {
  options: { lower: { amount: bigint } | null; higher: { amount: bigint } | null };
  sendLamports: bigint;
  onSelect: (val: string) => void;
}) {
  const lo = options.lower?.amount;
  const hi = options.higher?.amount;
  let recAmount = lo, altAmount = hi;
  if (lo && hi) {
    const distLo = sendLamports - lo;
    const distHi = hi - sendLamports;
    if (distHi <= distLo) { recAmount = hi; altAmount = lo; }
  } else if (!lo && hi) { recAmount = hi; altAmount = undefined; }

  return (
    <div className="text-zk-text-muted space-y-1">
      <span className="text-yellow-400/80">No exact match</span>
      {recAmount && (
        <div>
          <span className="text-zk-text-muted/60">Recommended: </span>
          <button onClick={() => onSelect(String(Number(recAmount!) / 1e9))}
            className="text-zk-teal hover:text-zk-teal/80 font-medium">
            {Number(recAmount) / 1e9} SOL
          </button>
        </div>
      )}
      {altAmount && (
        <div>
          <span className="text-zk-text-muted/60">Or send: </span>
          <button onClick={() => onSelect(String(Number(altAmount!) / 1e9))}
            className="text-zk-text-muted/80 hover:text-zk-text font-medium">
            {Number(altAmount) / 1e9} SOL
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

interface Props {
  notes: V2Note[];
  setNotes: (fn: (prev: V2Note[]) => V2Note[]) => void;
  onRecoveryScan?: () => void;
}

export default function V3WithdrawPage({ notes, setNotes, onRecoveryScan }: Props) {
  const { publicKey } = useWallet();
  const { connection } = useConnection();

  const [sendAmountStr, setSendAmountStr] = useState('');
  const [recipient, setRecipient] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<'idle' | 'withdrawing' | 'done' | 'error'>('idle');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [lastSig, setLastSig] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── Derived state ──────────────────────────────────────────────────────

  const seen = new Set<string>();
  const unspent = notes.filter(n => {
    if (n.status !== 'unspent') return false;
    if (seen.has(n.nullifier)) return false;
    seen.add(n.nullifier);
    return true;
  });
  // Filter by withdrawable flag (set by reconcile via isRootInHistory) — excludes ghost notes from closed programs
  const withdrawable = unspent.filter(n => n.withdrawable !== false && n.pathElements.length > 0 && n.merkleRoot);
  const needsPath = unspent.filter(n => n.withdrawable !== false && (n.pathElements.length === 0 || !n.merkleRoot));
  const totalBalance = withdrawable.reduce((s, n) => s + BigInt(n.amount), 0n);

  // Parse send amount
  const sendLamports = useMemo(() => {
    const n = parseFloat(sendAmountStr);
    if (isNaN(n) || n <= 0) return 0n;
    return BigInt(Math.round(Math.round(n * 10) / 10 * 1e9)); // snap to 0.1
  }, [sendAmountStr]);

  // Auto-compute best selection
  const options = useMemo(() => {
    if (sendLamports <= 0n) return null;
    return findNearestOptions(sendLamports, withdrawable);
  }, [sendLamports, withdrawable]);

  // Determine which notes are auto-selected
  const autoSelected = useMemo(() => {
    if (!options) return [];
    if (options.exact) return options.exact;
    if (options.lower) return options.lower.notes;
    return [];
  }, [options]);

  const autoSelectedAmount = autoSelected.reduce((s, n) => s + BigInt(n.amount), 0n);
  const autoSelectedSet = useMemo(() => new Set(autoSelected.map(n => n.nullifier)), [autoSelected]);

  // For manual mode, compute selected balance
  const manualSelectedBalance = Array.from(selected).reduce((s, id) => {
    const note = unspent.find(n => n.nullifier === id);
    return s + (note ? BigInt(note.amount) : 0n);
  }, 0n);

  // The actual notes to withdraw (auto or manual)
  const effectiveSelection = showAdvanced ? selected : autoSelectedSet;
  const effectiveAmount = showAdvanced ? manualSelectedBalance : autoSelectedAmount;

  // Denomination card groups
  const allGroups = useMemo(() => groupByDenom(unspent), [unspent]);

  // ─── Handlers ─────────────────────────────────────────────────────────

  const toggleNote = (nullifier: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(nullifier)) next.delete(nullifier);
      else next.add(nullifier);
      return next;
    });
  };

  const tryFixPaths = useCallback(async () => {
    // V3 notes should always have paths from the deposit event.
    // If paths are missing, a full recovery scan is needed (disconnect/reconnect).
    if (!connection || needsPath.length === 0) return;
    console.log(`[V3] ${needsPath.length} notes missing paths — reconnect wallet to trigger recovery scan`);
  }, [needsPath, connection]);

  async function handleWithdraw() {
    if (!publicKey || effectiveSelection.size === 0) return;
    setError(null);
    setPhase('withdrawing');

    const recipientAddr = recipient.trim() || publicKey.toBase58();
    let recipientPubkey: PublicKey;
    try {
      recipientPubkey = new PublicKey(recipientAddr);
    } catch {
      setError('Invalid recipient address');
      setPhase('error');
      return;
    }

    const aesKey = getCachedKey(publicKey.toBase58());
    if (!aesKey) {
      setError('Encryption key not ready. Reconnect your wallet.');
      setPhase('error');
      return;
    }

    const candidates = unspent.filter(n => effectiveSelection.has(n.nullifier) && n.pathElements.length > 0);

    // Pre-flight: validate each note BEFORE spending 30s on proof generation
    setProgress('Verifying notes are still valid...');
    const toWithdraw: typeof candidates = [];
    for (const note of candidates) {
      const ok = await isNoteWithdrawable(note, connection);
      if (ok) {
        toWithdraw.push(note);
      } else {
        // Note is not withdrawable right now (stale root or missing path).
        // Do NOT mark as "spent" — it may still be valid, just needs a fresh path.
        // The V3 spent-check in reconciliation will handle actual spent detection.
        console.warn(`[V3] Note leaf=${note.leafIndex} not withdrawable (stale root or missing path) — skipping, NOT marking spent`);
      }
    }
    if (toWithdraw.length === 0) {
      setError('No valid notes to withdraw. They may already be spent or have expired roots.');
      setPhase('error');
      setProgress('');
      return;
    }
    if (toWithdraw.length < candidates.length) {
      console.log(`[V3] Pre-flight: ${candidates.length - toWithdraw.length} notes filtered (already spent or stale)`);
    }

    let lastSigResult = '';
    const pipelineStart = performance.now();

    // 2-wide relay pipeline: keep up to 2 relay calls in-flight while generating proofs.
    // When proof > relay: behaves like 1-wide (relay finishes before queue fills).
    // When proof < relay: 2nd slot absorbs the difference, eliminating wait time.
    const MAX_INFLIGHT = 2;
    const relayQueue: Array<{
      promise: Promise<{ signature: string }>;
      note: typeof toWithdraw[0];
      idx: number;
    }> = [];

    // Helper: drain oldest relay from queue, mark note as spent
    const drainOldest = async () => {
      const oldest = relayQueue.shift()!;
      const result = await oldest.promise;
      lastSigResult = result.signature;
      setNotes(prev => prev.map(n => n.nullifier === oldest.note.nullifier ? { ...n, status: 'spent' as const } : n));
      if (publicKey) updateNoteStatus(publicKey.toBase58(), oldest.note.nullifier, 'spent');
      return oldest;
    };

    for (let i = 0; i < toWithdraw.length; i++) {
      const note = toWithdraw[i];
      const denomSol = Number(BigInt(note.amount)) / 1e9;

      setNotes(prev => prev.map(n => n.nullifier === note.nullifier ? { ...n, status: 'pending_spend' as const } : n));

      // Generate proof (CPU-bound, sequential)
      setProgress(`Proving ${denomSol} SOL (${i + 1}/${toWithdraw.length})...`);
      let proofData;
      try {
        proofData = await generateV3Proof({
          note,
          recipient: recipientPubkey,
          onProgress: (msg: string) => setProgress(`(${i + 1}/${toWithdraw.length}) ${msg}`),
        });
      } catch (e: any) {
        // Proof failed — drain all pending relays, then abort
        for (const entry of relayQueue) {
          try { await entry.promise; } catch { /* ignore during abort */ }
        }
        setNotes(prev => prev.map(n => n.nullifier === note.nullifier ? { ...n, status: 'unspent' as const } : n));
        if (publicKey) updateNoteStatus(publicKey.toBase58(), note.nullifier, 'unspent');
        setError(`Failed: ${e.message}`);
        setPhase('error');
        setProgress('');
        return;
      }

      // If queue full (2 relays in-flight), wait for oldest to complete
      if (relayQueue.length >= MAX_INFLIGHT) {
        try {
          const drained = await drainOldest();
          console.log(`[V3Pipeline] Note ${drained.idx + 1} relay done, overlapped with note ${i + 1} proof (queue was full)`);
        } catch (e: any) {
          // Relay failed — revert all pending + current notes
          for (const entry of relayQueue) {
            setNotes(prev => prev.map(n => n.nullifier === entry.note.nullifier ? { ...n, status: 'unspent' as const } : n));
            if (publicKey) updateNoteStatus(publicKey.toBase58(), entry.note.nullifier, 'unspent');
          }
          setNotes(prev => prev.map(n => n.nullifier === note.nullifier ? { ...n, status: 'unspent' as const } : n));
          if (publicKey) updateNoteStatus(publicKey.toBase58(), note.nullifier, 'unspent');
          setError(`Failed: ${e.message}`);
          setPhase('error');
          setProgress('');
          return;
        }
      }

      // Fire relay (don't await — add to queue)
      setProgress(`Submitting ${denomSol} SOL (${i + 1}/${toWithdraw.length})...`);
      relayQueue.push({
        promise: submitV3ToRelay(proofData, (msg: string) => setProgress(`(${i + 1}/${toWithdraw.length}) ${msg}`)),
        note,
        idx: i,
      });
    }

    // Drain remaining queue (1-2 entries)
    while (relayQueue.length > 0) {
      try {
        const drained = await drainOldest();
        console.log(`[V3Pipeline] Note ${drained.idx + 1} relay done (draining queue)`);
      } catch (e: any) {
        for (const entry of relayQueue) {
          setNotes(prev => prev.map(n => n.nullifier === entry.note.nullifier ? { ...n, status: 'unspent' as const } : n));
          if (publicKey) updateNoteStatus(publicKey.toBase58(), entry.note.nullifier, 'unspent');
        }
        setError(`Failed: ${e.message}`);
        setPhase('error');
        setProgress('');
        return;
      }
    }

    const pipelineEnd = performance.now();
    console.log(`[V3Pipeline] ${toWithdraw.length} notes withdrawn in ${((pipelineEnd - pipelineStart) / 1000).toFixed(1)}s (2-wide pipeline)`);

    setLastSig(lastSigResult);
    setPhase('done');
    setProgress('');
    setSendAmountStr('');
    setTimeout(() => onRecoveryScan?.(), 3000);
  }

  // ─── Upload handler (unchanged logic) ─────────────────────────────────

  async function handleUploadedFiles(files: File[]) {
    if (!connection) return;
    let added = 0, skipped = 0, invalid = 0, spent = 0, wrongChain = 0;
    const parsed: V2Note[] = [];

    for (const file of files) {
      if (!file.name.endsWith('.json')) { invalid++; continue; }
      const note = await parseUploadedNote(file);
      if (note) {
        if (notes.some(n => n.nullifier === note.nullifier)) { skipped++; continue; }
        parsed.push(note);
      } else { invalid++; }
    }

    if (parsed.length > 0) {
      const validParsed: V2Note[] = [];
      const poolStateCache = new Map<string, Uint8Array | null>();
      for (const note of parsed) {
        const denomStr = note.amount;
        if (!poolStateCache.has(denomStr)) {
          try {
            const { statePda } = deriveV2PoolPDAs(BigInt(denomStr));
            const acct = await connection.getAccountInfo(statePda);
            poolStateCache.set(denomStr, acct?.data ? new Uint8Array(acct.data) : null);
          } catch { poolStateCache.set(denomStr, null); }
        }
        const stateData = poolStateCache.get(denomStr);
        if (!stateData) { wrongChain++; continue; }
        if (note.merkleRoot && note.pathElements.length > 0) {
          if (!isRootInHistory(note.merkleRoot, stateData)) {
            wrongChain++;
            console.log(`[Upload] Rejected note (${Number(BigInt(note.amount))/1e9} SOL leaf ${note.leafIndex}) — root not in pool history`);
            continue;
          }
        }
        validParsed.push(note);
      }
      if (wrongChain > 0) console.log(`[Upload] Rejected ${wrongChain} notes — not valid on this chain`);

      try {
        const flags = await batchCheckV2NotesSpent(connection, validParsed, V2_PROGRAM_ID);
        for (let i = 0; i < validParsed.length; i++) {
          if (flags[i]) { validParsed[i].status = 'spent'; spent++; }
          else { added++; }
        }
      } catch { added = validParsed.length; }
      if (validParsed.length > 0) {
        setNotes(prev => [...prev, ...validParsed]);
        if (publicKey) { for (const note of validParsed) saveNote(publicKey.toBase58(), note); }
      }
    }

    const parts = [];
    if (added > 0) parts.push(`${added} note${added > 1 ? 's' : ''} restored`);
    if (spent > 0) parts.push(`${spent} already spent`);
    if (wrongChain > 0) parts.push(`${wrongChain} from wrong chain`);
    if (skipped > 0) parts.push(`${skipped} duplicate${skipped > 1 ? 's' : ''}`);
    if (invalid > 0) parts.push(`${invalid} invalid`);
    setUploadMsg(parts.join(', ') || 'No notes found');
    setTimeout(() => setUploadMsg(null), 5000);
  }

  // ─── Render ───────────────────────────────────────────────────────────

  const busy = phase === 'withdrawing';
  const hasInput = sendLamports > 0n;

  return (
    <div className="space-y-4">
      {/* Amount input */}
      <div>
        <label className="text-xs text-zk-text-muted mb-1.5 block">Amount to send (SOL)</label>
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.0"
              value={sendAmountStr}
              onChange={e => {
                let val = e.target.value.replace(/[^0-9.]/g, '');
                const dotIdx = val.indexOf('.');
                if (dotIdx !== -1) val = val.slice(0, dotIdx + 1) + val.slice(dotIdx + 1).replace(/\./g, '').slice(0, 1);
                setSendAmountStr(val);
                setPhase('idle');
                setError(null);
              }}
              onBlur={() => {
                // Only auto-snap when amount exceeds balance (clear user error)
                if (sendLamports > 0n && sendLamports > totalBalance && totalBalance > 0n) {
                  setSendAmountStr(String(Number(totalBalance) / 1e9));
                }
                // Don't auto-snap to nearest — let the user click Recommended/Or send buttons
              }}
              disabled={busy}
              className="w-full bg-zk-surface border border-zk-border rounded-lg px-4 py-3 pr-14 text-lg text-zk-text
                         placeholder-zk-text-muted focus:outline-none focus:border-zk-teal disabled:opacity-50"
            />
            <button
              onClick={() => { if (totalBalance > 0n) setSendAmountStr(String(Number(totalBalance) / 1e9)); }}
              disabled={busy || totalBalance === 0n}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zk-teal/50 hover:text-zk-teal disabled:opacity-30"
            >MAX</button>
          </div>
          <div className="flex items-center px-3 bg-zk-surface border border-zk-border rounded-lg text-sm text-zk-text-muted">
            SOL
          </div>
        </div>
      </div>

      {/* Recipient */}
      <div>
        <label className="text-xs text-zk-text-muted mb-1.5 block">Recipient (leave empty for self)</label>
        <input
          type="text"
          placeholder="Fresh wallet address..."
          value={recipient}
          onChange={e => setRecipient(e.target.value)}
          disabled={busy}
          className="w-full bg-zk-surface border border-zk-border rounded-lg px-4 py-2.5 text-sm text-zk-text
                     placeholder-zk-text-muted/40 focus:outline-none focus:border-zk-teal disabled:opacity-50"
        />
      </div>

      {/* Constraint feedback */}
      {hasInput && !busy && phase !== 'done' && options && (
        <div className="text-sm rounded-lg px-3 py-2.5">
          {options.exact ? (
            <span className="text-emerald-400">You can send exactly {Number(sendLamports) / 1e9} SOL</span>
          ) : sendLamports > totalBalance ? (
            <span className="text-red-400">Insufficient balance ({formatSol(totalBalance)} SOL available)</span>
          ) : (
            <NearestOptions options={options} sendLamports={sendLamports} onSelect={setSendAmountStr} />
          )}
        </div>
      )}

      {/* Denomination cards — show what's being used and what's available */}
      {!showAdvanced && unspent.length > 0 && (
        <div className="space-y-2">
          {hasInput && autoSelected.length > 0 && (() => {
            const summary = groupByDenom(autoSelected)
              .map(g => g.count > 1 ? `${g.denomSol} SOL \u00D7 ${g.count}` : `${g.denomSol} SOL`)
              .join(' + ');
            return <span className="text-xs text-zk-text-muted">Using: {summary}</span>;
          })()}
          {allGroups.map(group => {
            const selectedInGroup = group.notes.filter(n => autoSelectedSet.has(n.nullifier)).length;
            const isUsed = selectedInGroup > 0;
            return (
              <div
                key={group.denom.toString()}
                className={`flex items-center justify-between px-4 py-3 rounded-lg border transition-colors
                  ${isUsed ? 'border-zk-teal bg-zk-teal/10' : 'border-zk-border bg-zk-surface'}`}
              >
                <div className="flex items-center gap-3">
                  {isUsed && <span className="text-zk-teal text-sm">{'\u2713'}</span>}
                  <span className={`text-sm font-medium ${isUsed ? 'text-zk-text' : 'text-zk-text-muted'}`}>
                    {group.denomSol} SOL
                  </span>
                </div>
                <span className={`text-sm ${isUsed ? 'text-zk-teal' : 'text-zk-text-muted/60'}`}>
                  {isUsed ? `${selectedInGroup} of ${group.count}` : `${group.count} available`}
                </span>
              </div>
            );
          })}
          {unspent.length === 0 && (
            <div className="text-sm text-zk-text-muted text-center py-4">
              No funds available. Deposit some SOL first.
            </div>
          )}
        </div>
      )}

      {/* Advanced: manual note selection */}
      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="text-xs text-zk-text-muted/60 hover:text-zk-text-muted transition-colors"
      >
        {showAdvanced ? '\u25B2 Hide manual selection' : '\u25BC Choose notes manually'}
      </button>

      {showAdvanced && (() => {
        // Group notes by denomination for quantity stepper
        const groups = groupByDenom(unspent);
        // Count how many from each group are in `selected`
        const getSelectedCount = (groupNotes: V2Note[]) =>
          groupNotes.filter(n => selected.has(n.nullifier)).length;

        const setGroupCount = (groupNotes: V2Note[], count: number) => {
          const withdrawableInGroup = groupNotes.filter(n => n.pathElements.length > 0 && n.merkleRoot);
          setSelected(prev => {
            const next = new Set(prev);
            // Remove all from this group first
            for (const n of groupNotes) next.delete(n.nullifier);
            // Add back the desired count
            for (let i = 0; i < Math.min(count, withdrawableInGroup.length); i++) {
              next.add(withdrawableInGroup[i].nullifier);
            }
            return next;
          });
        };

        return (
          <div className="space-y-2">
            {groups.map(group => {
              const count = getSelectedCount(group.notes);
              const maxCount = group.notes.filter(n => n.pathElements.length > 0 && n.merkleRoot).length;
              return (
                <div key={group.denom.toString()}
                  className="flex items-center justify-between px-4 py-3 rounded-lg border border-zk-border bg-zk-surface"
                >
                  <span className="text-sm font-medium text-zk-text">{group.denomSol} SOL</span>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setGroupCount(group.notes, Math.max(0, count - 1))}
                      disabled={count === 0 || busy}
                      className="w-7 h-7 rounded border border-zk-border text-zk-text-muted hover:border-zk-teal
                                 hover:text-zk-teal disabled:opacity-30 disabled:cursor-not-allowed text-sm"
                    >{'\u2212'}</button>
                    <span className={`text-sm font-medium min-w-[2ch] text-center ${count > 0 ? 'text-zk-teal' : 'text-zk-text-muted/60'}`}>
                      {count}
                    </span>
                    <button
                      onClick={() => setGroupCount(group.notes, Math.min(maxCount, count + 1))}
                      disabled={count >= maxCount || busy}
                      className="w-7 h-7 rounded border border-zk-border text-zk-text-muted hover:border-zk-teal
                                 hover:text-zk-teal disabled:opacity-30 disabled:cursor-not-allowed text-sm"
                    >+</button>
                    <span className="text-xs text-zk-text-muted/40 min-w-[3ch]">of {group.count}</span>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* Progress */}
      {busy && (
        <div className="flex items-center gap-2 text-sm text-zk-teal">
          <span className="animate-spin inline-block w-4 h-4 border-2 border-zk-teal border-t-transparent rounded-full" />
          {progress}
        </div>
      )}

      {phase === 'done' && (
        <div className="text-sm text-emerald-400 bg-emerald-900/20 rounded-lg p-3 text-center">
          <div className="font-medium">Sent successfully</div>
          {lastSig && <span className="text-xs opacity-60 block mt-1">tx: {lastSig.slice(0, 20)}...</span>}
        </div>
      )}

      {error && (
        <p className="text-xs text-red-400 bg-red-900/20 rounded-lg p-2.5 break-all">{error}</p>
      )}

      {/* Send button */}
      <Button
        onClick={phase === 'done' ? () => setPhase('idle') : handleWithdraw}
        disabled={(phase !== 'done' && effectiveSelection.size === 0) || busy || !publicKey}
        className="w-full h-12 text-base"
      >
        {busy ? 'Processing...' :
         phase === 'done' ? (unspent.length > 0 ? 'Send more' : 'Done') :
         effectiveAmount > 0n ? `Send ${formatSol(effectiveAmount)} SOL privately` :
         hasInput ? 'Select an amount' :
         'Enter amount to send'}
      </Button>

      {/* Recovery upload */}
      {needsPath.length > 0 && (
        <button onClick={tryFixPaths} className="text-xs text-yellow-400 hover:text-yellow-300 w-full text-center">
          {needsPath.length} note{needsPath.length > 1 ? 's' : ''} preparing...
        </button>
      )}

      <div className="pt-3 border-t border-zk-border/30">
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          multiple
          className="hidden"
          onChange={async (e) => {
            const files = e.target.files;
            if (!files || files.length === 0) return;
            await handleUploadedFiles(Array.from(files));
            e.target.value = '';
          }}
        />
        <div
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-zk-teal', 'bg-zk-teal/5'); }}
          onDragLeave={(e) => { e.currentTarget.classList.remove('border-zk-teal', 'bg-zk-teal/5'); }}
          onDrop={async (e) => {
            e.preventDefault();
            e.currentTarget.classList.remove('border-zk-teal', 'bg-zk-teal/5');
            const files = e.dataTransfer.files;
            if (!files || files.length === 0) return;
            await handleUploadedFiles(Array.from(files));
          }}
          className="w-full border border-dashed border-zk-border/40 rounded-lg py-3 px-4 cursor-pointer
                     hover:border-zk-teal/40 transition-colors text-center"
        >
          <span className="text-xs text-zk-text-muted/60">
            &#128206; Restore notes from backup
          </span>
        </div>
        {uploadMsg && (
          <p className="text-xs text-center mt-1.5 text-zk-teal">{uploadMsg}</p>
        )}
      </div>
    </div>
  );
}
