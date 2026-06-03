/**
 * ZeroK Agent SDK — Pool-PDA Note Recovery (Node)
 *
 * Same wallet → same notes, on any device. The agent reboots, calls
 * `zk.recover()`, and gets back every unspent note it ever created on this
 * network — without any backup file.
 *
 * Mechanism:
 *   1. For each pool in manifests/<network>.json:
 *        getSignaturesForAddress(statePda) — bounded, ZeroK-only history
 *   2. Filter signatures whose memo contains "zerok:v3:"
 *   3. AES-GCM-decrypt each candidate memo with the wallet-derived key.
 *      Wrong key (other people's notes) silently fails.
 *   4. For successful decrypts: fetch the full tx, parse its DepositProofData
 *      event for leafIndex + Merkle path.
 *   5. Skip notes whose nullifier PDA already exists (already withdrawn).
 *   6. Persist a per-pool checkpoint so subsequent recoveries are incremental.
 *
 * Privacy: identical to reading the public chain. No wallet identifier is
 * disclosed. Try-decrypt is a local-only operation.
 *
 * Memo formats: v3 JSON (this SDK's writer), v4 binary, and v5 batch-seed
 * (both written by app.zerok.app) are all read here via sdk/v2-core/memo.js.
 * A single v5 batch memo expands to N notes; each is matched to its on-chain
 * leaf event by Merkle-root consistency (parseAllDepositEventsFromLogs).
 */

'use strict';

const { Connection, PublicKey } = require('@solana/web3.js');
const { buildPoseidon } = require('circomlibjs');
const fs = require('fs');
const path = require('path');

const {
  PROGRAM_ID,
  SEEDS,
  STATE_OFFSETS,
  ACCOUNT_SIZES,
  ROOT_HISTORY_SIZE,
  SHARD_CAPACITY,
  fieldToBytesBE,
  hexToFr,
  derivePDAs,
  deriveNullifierPda,
  deriveAllShardPdas,
  computeRoot,
} = require('../v3/canonical.js');
const { decodeMemo, isZerokMemo } = require('../v2-core/memo.js');

const TX_FETCH_BATCH = 8;
const SIG_PAGE_LIMIT = 1000;

// =============================================================================
// HELPERS
// =============================================================================

let _poseidonPromise = null;
function getPoseidon() {
  if (!_poseidonPromise) _poseidonPromise = buildPoseidon();
  return _poseidonPromise;
}

/**
 * Strip Solana RPC memo wrapping. Examples:
 *   "[261] zerok:v3:..."     → "zerok:v3:..."
 *   '["zerok:v3:..."]'        → "zerok:v3:..."
 */
function cleanMemo(raw) {
  let s = raw;
  const prefixMatch = s.match(/^\[\d+\]\s*/);
  if (prefixMatch) s = s.slice(prefixMatch[0].length);
  if (s.startsWith('["')) s = s.slice(2);
  if (s.endsWith('"]')) s = s.slice(0, -2);
  if (s.startsWith('"')) s = s.slice(1);
  if (s.endsWith('"')) s = s.slice(0, -1);
  return s.trim();
}

/**
 * Parse ALL `DepositProofData` events from a tx's log messages.
 * Layout (per event): disc(8) + leaf_index(u32 LE, 4) + root_after(BE, 32)
 *   + siblings_be(20×32=640) + positions(20×u8=20) = 704 bytes.
 *
 * A single-deposit tx (v3/v4) emits one event; a v5 batch tx emits one event
 * per leaf inserted. Returns events in log order.
 */
function parseAllDepositEventsFromLogs(logs) {
  const events = [];
  if (!Array.isArray(logs)) return events;
  for (const log of logs) {
    if (!log.startsWith('Program data: ')) continue;
    let buf;
    try {
      buf = Buffer.from(log.slice('Program data: '.length), 'base64');
    } catch {
      continue;
    }
    if (buf.length < 704) continue;

    let off = 8; // skip discriminator
    const leafIndex = buf.readUInt32LE(off); off += 4;
    const rootAfter = buf.slice(off, off + 32).toString('hex'); off += 32;
    const siblings = [];
    for (let i = 0; i < 20; i++) {
      siblings.push(buf.slice(off, off + 32).toString('hex'));
      off += 32;
    }
    const positions = [];
    for (let i = 0; i < 20; i++) positions.push(buf.readUInt8(off + i));
    events.push({ leafIndex, rootAfter, siblings, positions });
  }
  return events;
}

/**
 * Build the set of every root currently valid for a pool — the in-state
 * 256-entry ring plus all 20 shard rings — in ONE state fetch + ONE batched
 * shard fetch. A note whose `currentRoot` is absent here belongs to a prior
 * pool deployment (its tree was reset/redeployed): it is no longer withdrawable
 * on that root, so we drop it. Mirrors the web client's root-in-history filter,
 * but checks shards too (strictly keeps more valid, rotated-out notes).
 *
 * Returns null if state can't be read (filter then becomes a no-op — fail open).
 */
async function buildCurrentRootSet(connection, statePda) {
  let stateInfo;
  try {
    stateInfo = await connection.getAccountInfo(statePda);
  } catch {
    return null;
  }
  if (!stateInfo) return null;
  const roots = new Set();
  const sd = stateInfo.data;
  for (let i = 0; i < ROOT_HISTORY_SIZE; i++) {
    const off = STATE_OFFSETS.ROOT_HISTORY + i * 32;
    if (off + 32 <= sd.length) roots.add(sd.slice(off, off + 32).toString('hex'));
  }
  try {
    const shardInfos = await connection.getMultipleAccountsInfo(deriveAllShardPdas(statePda));
    for (const info of shardInfos) {
      if (!info) continue;
      for (let e = 0; e < SHARD_CAPACITY; e++) {
        const off = ACCOUNT_SIZES.SHARD_HEADER + e * ACCOUNT_SIZES.SHARD_ENTRY;
        if (off + 32 <= info.data.length) roots.add(info.data.slice(off, off + 32).toString('hex'));
      }
    }
  } catch {
    /* shards unreadable — fall back to in-state ring only */
  }
  return roots;
}

/**
 * Load a manifests/{network}.json pool catalog. Returns an array of:
 *   { poolId, denomination(BigInt), statePda(PublicKey) }
 */
function loadPools(network) {
  const networkLabel = network === 'mainnet-beta' ? 'mainnet' : network;
  const manifestPath = path.join(__dirname, '..', '..', 'manifests', `${networkLabel}.json`);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Pool manifest not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const pools = [];
  for (const [poolId, p] of Object.entries(manifest.pools || {})) {
    if (p.status && p.status !== 'active') continue;
    const denom = BigInt(p.denomination);
    // Trust manifest's stated state PDA, but also derive it for sanity check.
    const derived = derivePDAs(denom).statePda.toBase58();
    const stated = p.pdas?.state;
    if (stated && stated !== derived) {
      // Manifest was generated for a different program ID — skip.
      continue;
    }
    pools.push({
      poolId,
      denomination: denom,
      statePda: new PublicKey(stated || derived),
    });
  }
  return pools;
}

/**
 * Per-pool checkpoint helpers.
 * Stored at notesDir/.checkpoints/<wallet>__<poolId>.json
 */
function checkpointPath(notesDir, walletPubkey, poolId) {
  const dir = path.join(notesDir, '.checkpoints');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${walletPubkey}__${poolId}.json`);
}
function loadCheckpoint(notesDir, walletPubkey, poolId) {
  try {
    return JSON.parse(fs.readFileSync(checkpointPath(notesDir, walletPubkey, poolId), 'utf8'));
  } catch { return null; }
}
function saveCheckpoint(notesDir, walletPubkey, poolId, cp) {
  try {
    fs.writeFileSync(checkpointPath(notesDir, walletPubkey, poolId), JSON.stringify(cp, null, 2));
  } catch { /* best effort */ }
}

// =============================================================================
// MAIN RECOVERY
// =============================================================================

/**
 * Recover all v3 deposit notes belonging to `wallet` across every active pool
 * on `network`. Optionally pass `existing` (notes already in memory) to skip
 * decrypt+parse for known commitments.
 *
 * @param {Object} args
 * @param {Connection} args.connection
 * @param {Keypair}   args.wallet
 * @param {Buffer}    args.encryptionKey  - 32-byte AES key (deriveEncryptionKey)
 * @param {string}    args.network        - 'mainnet-beta' | 'devnet'
 * @param {PublicKey} args.relayerPubkey  - reserved (not currently used)
 * @param {string}    args.notesDir       - checkpoint location
 * @param {Array}     [args.existing]     - notes already in memory (dedupe by commitment)
 * @returns {Promise<{ notes: Array, scanned: number, decrypted: number, spent: number }>}
 */
async function recoverNotes({ connection, wallet, encryptionKey, network, notesDir, existing = [] }) {
  if (!encryptionKey || encryptionKey.length !== 32) {
    throw new Error('encryptionKey must be a 32-byte Buffer');
  }
  if (!notesDir) {
    throw new Error('notesDir is required for checkpoint persistence');
  }

  const walletPubkey = wallet.publicKey.toBase58();
  const pools = loadPools(network);
  if (pools.length === 0) {
    return { notes: [], scanned: 0, decrypted: 0, spent: 0 };
  }

  const knownCommitments = new Set(existing.map(n => n.commitment).filter(Boolean));
  const allRecovered = [];
  let totalScanned = 0;
  let totalDecrypted = 0;
  let totalSpent = 0;

  for (const pool of pools) {
    const checkpoint = loadCheckpoint(notesDir, walletPubkey, pool.poolId);

    // ---- Phase 1: paginate signatures (incremental via `until`) ----
    const sigs = [];
    let before = undefined;
    let firstSig = null;
    while (true) {
      const opts = { limit: SIG_PAGE_LIMIT };
      if (before) opts.before = before;
      if (checkpoint?.lastSignature) opts.until = checkpoint.lastSignature;

      let page;
      try {
        page = await connection.getSignaturesForAddress(pool.statePda, opts);
      } catch (e) {
        // Soft-fail one pool; continue with others.
        page = [];
      }
      if (page.length === 0) break;
      if (!firstSig) firstSig = page[0].signature;
      sigs.push(...page);
      before = page[page.length - 1].signature;
      if (page.length < SIG_PAGE_LIMIT) break;
    }
    totalScanned += sigs.length;

    if (sigs.length === 0) continue;

    // ---- Phase 2: filter by memo + decrypt (no RPC) ----
    // decodeMemo handles v3 (JSON), v4 (binary) and v5 (batch-seed → N notes);
    // each call returns 0+ payloads of the uniform shape { d, n, s, v }.
    const memoSupported = sigs.some(s => s.memo != null);
    const candidates = memoSupported
      ? sigs.filter(s => s.memo && isZerokMemo(cleanMemo(s.memo)))
      : sigs; // slow path: must fetch full tx to find memo

    // A v5 batch can span multiple pools, so one batch tx appears in EVERY
    // touched pool's signature history and its memo decodes to notes of several
    // denominations. Keep only the notes whose denomination is THIS pool's, so
    // each note is recovered exactly once (in its own pool) — no cross-pool dupes.
    const ownDeposits = []; // { signature, payload }
    const keepForPool = (payload) => BigInt(payload.d) === pool.denomination;
    if (memoSupported) {
      for (const s of candidates) {
        const cleaned = cleanMemo(s.memo);
        for (const payload of decodeMemo(cleaned, encryptionKey)) {
          if (keepForPool(payload)) ownDeposits.push({ signature: s.signature, payload });
        }
      }
    } else {
      // Slow path — fetch txs, scan instructions for memo program data
      for (let b = 0; b < candidates.length; b += TX_FETCH_BATCH) {
        const chunk = candidates.slice(b, b + TX_FETCH_BATCH);
        const txs = await Promise.all(
          chunk.map(s => connection.getTransaction(s.signature, {
            maxSupportedTransactionVersion: 0, commitment: 'confirmed',
          }).catch(() => null))
        );
        for (let i = 0; i < chunk.length; i++) {
          const tx = txs[i];
          const memo = extractMemoFromTx(tx);
          if (!memo) continue;
          const cleaned = cleanMemo(memo);
          if (!isZerokMemo(cleaned)) continue;
          for (const payload of decodeMemo(cleaned, encryptionKey)) {
            if (keepForPool(payload)) ownDeposits.push({ signature: chunk[i].signature, payload });
          }
        }
      }
    }
    totalDecrypted += ownDeposits.length;

    // ---- Phase 3: fetch full txs for own notes, parse events, dedupe ----
    const poseidon = await getPoseidon();
    const newDeposits = ownDeposits.filter(d => {
      // Compute commitment to dedupe vs in-memory notes
      const nullifier = BigInt('0x' + d.payload.n);
      const secret = BigInt('0x' + d.payload.s);
      const commitment = poseidon.F.toObject(poseidon([nullifier, secret]));
      const commHex = fieldToBytesBE(commitment).toString('hex');
      d._commitment = commHex;
      return !knownCommitments.has(commHex);
    });

    if (newDeposits.length === 0) {
      if (firstSig) saveCheckpoint(notesDir, walletPubkey, pool.poolId, { lastSignature: firstSig });
      continue;
    }

    // Group by signature (cheap dedupe of tx fetches)
    const sigsToFetch = [...new Set(newDeposits.map(d => d.signature))];
    const txMap = new Map();
    for (let b = 0; b < sigsToFetch.length; b += TX_FETCH_BATCH) {
      const chunk = sigsToFetch.slice(b, b + TX_FETCH_BATCH);
      const txs = await Promise.all(
        chunk.map(sig => connection.getTransaction(sig, {
          maxSupportedTransactionVersion: 0, commitment: 'confirmed',
        }).catch(() => null))
      );
      chunk.forEach((sig, i) => txMap.set(sig, txs[i]));
    }

    // ---- Phase 4: build full notes ----
    // A v5 batch tx emits one DepositProofData event per leaf. Match each note
    // to ITS event by Merkle-root consistency: the event whose (siblings,
    // positions) re-hash this note's commitment up to event.rootAfter is the
    // right leaf. Single-deposit txs (v3/v4) fall back to the lone event.
    const poolNotes = [];
    const seenCommitments = new Set(); // guard signature-pagination overlap within a pool
    for (const dep of newDeposits) {
      if (seenCommitments.has(dep._commitment)) continue; // same leaf seen twice this run
      const tx = txMap.get(dep.signature);
      const allEvents = tx?.meta?.logMessages
        ? parseAllDepositEventsFromLogs(tx.meta.logMessages)
        : [];

      const nullifierHex = dep.payload.n;       // nullifier hex (no 0x)
      const secretHex = dep.payload.s;
      const denomination = String(dep.payload.d);

      // Compute nullifierHash for spent check
      const nullifier = BigInt('0x' + nullifierHex);
      const nullifierHashField = poseidon.F.toObject(poseidon([nullifier]));
      const nullifierHashBE = fieldToBytesBE(nullifierHashField);
      const nullifierHashHex = nullifierHashBE.toString('hex');

      // Match this note's commitment to the event that produced its leaf.
      const commitmentBig = BigInt('0x' + dep._commitment);
      let event = null;
      for (const ev of allEvents) {
        const pathEls = ev.siblings.map(h => BigInt('0x' + h));
        const computed = computeRoot(poseidon, commitmentBig, pathEls, ev.positions);
        if (fieldToBytesBE(computed).toString('hex') === ev.rootAfter.replace(/^0x/, '')) {
          event = ev;
          break;
        }
      }
      if (!event && allEvents.length === 1) event = allEvents[0]; // v3/v4 fallback

      // No leaf for this note. If the tx DID emit leaf events and none is ours,
      // the memo over-declared a note that was never inserted on-chain (a v5
      // batch quirk): it holds no funds and can never be spent — drop it. Keep
      // it only when we couldn't read any events (logs unavailable), so a real
      // note isn't lost; it stays pathless and send() will treat it as stale.
      if (!event && allEvents.length > 0) continue;

      seenCommitments.add(dep._commitment);
      poolNotes.push({
        version: dep.payload.v || 3,
        poolId: pool.poolId,
        network,
        programId: PROGRAM_ID.toBase58(),
        denomination,
        nullifier: nullifierHex,
        secret: secretHex,
        commitment: dep._commitment,
        nullifierHash: nullifierHashHex,
        leafIndex: event ? event.leafIndex : null,
        currentRoot: event ? event.rootAfter : null,
        pathElements: event ? event.siblings : null,
        pathIndices: event ? event.positions : null,
        depositTx: dep.signature,
        depositSlot: tx?.slot ?? null,
        recoveredAt: new Date().toISOString(),
        status: 'recovered', // promoted to 'unspent' below if nullifier not on-chain
      });
    }

    // ---- Phase 4.5: drop notes from prior pool deployments (stale roots) ----
    // A redeployed/reset pool reuses leaf indices, so two distinct commitments
    // can each claim e.g. leaf 3 — one current, one from the old tree. Keep only
    // notes whose post-insert root is still valid in THIS pool's current rings.
    let livePoolNotes = poolNotes;
    if (poolNotes.length > 0) {
      const rootSet = await buildCurrentRootSet(connection, pool.statePda);
      if (rootSet) {
        livePoolNotes = poolNotes.filter(n => {
          if (!n.currentRoot) return true; // can't check — keep (fail open)
          return rootSet.has(n.currentRoot.replace(/^0x/, ''));
        });
      }
    }

    // ---- Phase 5: spent-check via nullifier PDA existence ----
    const stateDerived = derivePDAs(pool.denomination).statePda;
    const nullifierPdas = livePoolNotes.map(n => deriveNullifierPda(stateDerived, Buffer.from(n.nullifierHash, 'hex')));
    let spentInfos = [];
    try {
      // getMultipleAccountsInfo accepts up to 100 keys per call
      for (let b = 0; b < nullifierPdas.length; b += 100) {
        const chunk = nullifierPdas.slice(b, b + 100);
        const infos = await connection.getMultipleAccountsInfo(chunk);
        spentInfos.push(...infos);
      }
    } catch (e) {
      // Best effort — if it fails, mark all as 'recovered' and let send() fail per-note
      spentInfos = livePoolNotes.map(() => null);
    }

    for (let i = 0; i < livePoolNotes.length; i++) {
      const isSpent = spentInfos[i] != null;
      livePoolNotes[i].status = isSpent ? 'spent' : 'unspent';
      if (isSpent) totalSpent++;
    }

    allRecovered.push(...livePoolNotes);

    // Save checkpoint at the most recent signature scanned
    if (firstSig) saveCheckpoint(notesDir, walletPubkey, pool.poolId, { lastSignature: firstSig });
  }

  return {
    notes: allRecovered,
    scanned: totalScanned,
    decrypted: totalDecrypted,
    spent: totalSpent,
  };
}

/**
 * Extract a Memo-program instruction's data from a parsed transaction.
 * Returns the memo string or null. Used only on the slow path (RPCs without sig.memo).
 */
function extractMemoFromTx(tx) {
  if (!tx) return null;
  const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
  const msg = tx.transaction?.message;
  if (!msg) return null;
  const accountKeys = msg.staticAccountKeys
    ? msg.staticAccountKeys.map(k => k.toBase58())
    : (msg.accountKeys || []).map(k => typeof k === 'string' ? k : k.toBase58());
  const instructions = msg.compiledInstructions || msg.instructions || [];
  for (const ix of instructions) {
    const programId = accountKeys[ix.programIdIndex];
    if (programId !== MEMO_PROGRAM_ID) continue;
    const dataBytes = typeof ix.data === 'string' ? Buffer.from(ix.data, 'base64') : Buffer.from(ix.data);
    return dataBytes.toString('utf8');
  }
  return null;
}

module.exports = {
  recoverNotes,
  // exported for tests / advanced callers
  parseAllDepositEventsFromLogs,
  cleanMemo,
};
