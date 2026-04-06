/**
 * ZeroK v3 — Per-Note Local Persistence with Chain Fingerprinting
 *
 * Each note is stored independently by nullifier, scoped to chain.
 * Notes from different networks/validator sessions auto-isolate.
 *
 * Storage:
 *   zerok:v3:note:<chainId>:<wallet>:<nullifier>  → JSON(V2Note)
 *   zerok:v3:index:<chainId>:<wallet>             → JSON(string[])
 *
 * Chain fingerprint: first 8 chars of genesis hash.
 * Hardcoded for mainnet/devnet (no RPC call needed).
 * Dynamic for localnet (one getGenesisHash() call at startup).
 */

import { V2Note, V2NoteStatus } from '@/types/note';

// ─── Chain fingerprint ──────────────────────────────────────────────────────

const KNOWN_GENESIS: Record<string, string> = {
  'mainnet-beta': '5eykt4Us',  // 5eykt4UsFv2P6zt3S6dGrWHK3z5SxeKYXj2vJ9xLac1d
  'devnet':       'EtWTRABZ',  // EtWTRABZaYq6iMfeYKUcRjzwx6y51gAaiUs3cEjBoVj
  'testnet':      '4uhcVJyU',  // 4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY
};

let _chainId = '';

/**
 * Initialize chain fingerprint. Must be called before any cache operations.
 * For mainnet/devnet/testnet: uses hardcoded genesis (no RPC call).
 * For localnet/unknown: calls connection.getGenesisHash() once.
 */
export async function initChainId(
  networkId: string,
  connection?: { getGenesisHash: () => Promise<string> },
): Promise<void> {
  if (_chainId) return; // already initialized

  const known = KNOWN_GENESIS[networkId];
  if (known) {
    _chainId = known;
    console.log(`[NoteCache] Chain ID: ${_chainId} (${networkId})`);
    return;
  }

  // Localnet or unknown — dynamic lookup
  if (connection) {
    try {
      const genesis = await connection.getGenesisHash();
      _chainId = genesis.slice(0, 8);
      console.log(`[NoteCache] Chain ID: ${_chainId} (dynamic, ${networkId})`);
      return;
    } catch (e) {
      console.warn('[NoteCache] getGenesisHash failed, using fallback');
    }
  }

  // Fallback: use networkId itself (better than nothing)
  _chainId = networkId.slice(0, 8) || 'unknown';
  console.log(`[NoteCache] Chain ID: ${_chainId} (fallback)`);
}

/** Get current chain ID (for logging/debugging). */
export function getChainId(): string { return _chainId; }

// ─── Key generation (chain-scoped) ──────────────────────────────────────────

const NOTE_PREFIX = 'zerok:v3:note:';
const INDEX_PREFIX = 'zerok:v3:index:';

function noteKey(wallet: string, nullifier: string): string {
  return NOTE_PREFIX + _chainId + ':' + wallet + ':' + nullifier;
}

function indexKey(wallet: string): string {
  return INDEX_PREFIX + _chainId + ':' + wallet;
}

function loadIndex(wallet: string): string[] {
  try {
    const raw = localStorage.getItem(indexKey(wallet));
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveIndex(wallet: string, nullifiers: string[]): void {
  try {
    localStorage.setItem(indexKey(wallet), JSON.stringify(nullifiers));
  } catch { /* localStorage full — non-fatal */ }
}

// ─── Public API (unchanged signatures) ──────────────────────────────────────

/**
 * Save a single note. Adds to index if new.
 */
export function saveNote(walletPubkey: string, note: V2Note): void {
  try {
    localStorage.setItem(noteKey(walletPubkey, note.nullifier), JSON.stringify(note));
    const idx = loadIndex(walletPubkey);
    if (!idx.includes(note.nullifier)) {
      idx.push(note.nullifier);
      saveIndex(walletPubkey, idx);
    }
  } catch { /* non-fatal */ }
}

/**
 * Update a single note's status without touching other notes.
 */
export function updateNoteStatus(walletPubkey: string, nullifier: string, status: V2NoteStatus): void {
  try {
    const raw = localStorage.getItem(noteKey(walletPubkey, nullifier));
    if (!raw) return;
    const note: V2Note = JSON.parse(raw);
    note.status = status;
    localStorage.setItem(noteKey(walletPubkey, nullifier), JSON.stringify(note));
  } catch { /* non-fatal */ }
}

// Bump CACHE_SCHEMA_VERSION when note format changes (auto-clears old caches → fresh recovery)
const CACHE_SCHEMA_VERSION = 4;

function checkCacheSchemaVersion(wallet: string): boolean {
  const key = indexKey(wallet) + ':schema';
  try {
    const stored = localStorage.getItem(key);
    if (stored !== String(CACHE_SCHEMA_VERSION)) {
      console.log(`[NoteCache] Cache schema version mismatch (${stored ?? 'none'} → ${CACHE_SCHEMA_VERSION}), clearing cache`);
      clearCachedNotes(wallet);
      localStorage.setItem(key, String(CACHE_SCHEMA_VERSION));
      return false;
    }
    return true;
  } catch { return true; }
}

/**
 * Load all cached notes for a wallet (current chain only).
 * Auto-clears cache on schema version mismatch.
 */
export function loadCachedNotes(walletPubkey: string): V2Note[] {
  if (!checkCacheSchemaVersion(walletPubkey)) return []; // Schema mismatch → fresh start
  const idx = loadIndex(walletPubkey);
  const notes: V2Note[] = [];
  for (const nullifier of idx) {
    try {
      const raw = localStorage.getItem(noteKey(walletPubkey, nullifier));
      if (raw) notes.push(JSON.parse(raw));
    } catch { continue; }
  }
  return notes;
}

/**
 * Convenience: save all notes (calls saveNote per note).
 */
export function saveCachedNotes(walletPubkey: string, notes: V2Note[]): void {
  for (const note of notes) {
    saveNote(walletPubkey, note);
  }
}

/**
 * Atomically rebuild cache — clears all old entries and writes only the given notes.
 * Prevents stale note re-inflation from race conditions.
 */
export function rebuildCache(walletPubkey: string, notes: V2Note[]): void {
  clearCachedNotes(walletPubkey);
  for (const note of notes) {
    saveNote(walletPubkey, note);
  }
}

/**
 * Clear all cached notes for a wallet (current chain only).
 */
export function clearCachedNotes(walletPubkey: string): void {
  try {
    const idx = loadIndex(walletPubkey);
    for (const nullifier of idx) {
      localStorage.removeItem(noteKey(walletPubkey, nullifier));
    }
    localStorage.removeItem(indexKey(walletPubkey));
  } catch { /* non-fatal */ }
}

// ─── Pool Scan Checkpoints ──────────────────────────────────────────────────
//
// Tracks the newest signature scanned per pool so subsequent visits only
// fetch new deposits.  Key: zerok:v3:scan:<chainId>:<wallet>:<denomination>

const SCAN_PREFIX = 'zerok:v3:scan:';

function scanKey(wallet: string, denomination: string): string {
  return SCAN_PREFIX + _chainId + ':' + wallet + ':' + denomination;
}

// Bump CHECKPOINT_VERSION when scan logic changes (auto-invalidates old checkpoints → full rescan)
const CHECKPOINT_VERSION = 5;

export interface ScanCheckpoint {
  version?: number;          // auto-invalidate old checkpoints on version mismatch
  lastSignature: string;     // newest tx sig from last scan
  lastSlot: number;          // slot of newest sig
  knownNullifiers: string[]; // already-recovered note nullifiers
  timestamp: number;         // when last scan completed
}

export function saveScanCheckpoint(wallet: string, denomination: string, cp: ScanCheckpoint): void {
  try {
    cp.version = CHECKPOINT_VERSION;
    localStorage.setItem(scanKey(wallet, denomination), JSON.stringify(cp));
  } catch { /* non-fatal */ }
}

export function loadScanCheckpoint(wallet: string, denomination: string): ScanCheckpoint | null {
  try {
    const raw = localStorage.getItem(scanKey(wallet, denomination));
    if (!raw) return null;
    const cp = JSON.parse(raw) as ScanCheckpoint;
    // Auto-invalidate old checkpoints → triggers full rescan
    if (!cp.version || cp.version < CHECKPOINT_VERSION) {
      console.log(`[NoteCache] Checkpoint version mismatch (${cp.version ?? 'none'} < ${CHECKPOINT_VERSION}), clearing → full rescan`);
      localStorage.removeItem(scanKey(wallet, denomination));
      return null;
    }
    return cp;
  } catch { return null; }
}

/**
 * Clear scan checkpoint(s). If denomination is omitted, clears ALL pool checkpoints for this wallet.
 * Used by the "Full Rescan" button.
 */
export function clearScanCheckpoint(wallet: string, denomination?: string): void {
  try {
    if (denomination) {
      localStorage.removeItem(scanKey(wallet, denomination));
    } else {
      // Clear all checkpoints for this wallet on this chain
      const prefix = SCAN_PREFIX + _chainId + ':' + wallet + ':';
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) keysToRemove.push(k);
      }
      for (const k of keysToRemove) localStorage.removeItem(k);
    }
  } catch { /* non-fatal */ }
}
