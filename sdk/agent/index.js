/**
 * ZeroK Agent SDK — Privacy primitives for AI agents
 *
 * Four methods, same primitives a human gets:
 *   const zk = new ZeroK({ network: 'mainnet-beta', wallet: keypair });
 *   await zk.deposit(2.3);                   // deposit 2.3 SOL (auto-splits)
 *   await zk.send(1.0, recipient);           // send 1 SOL privately via gasless relay
 *   const bal = await zk.balance();          // check private balance
 *   await zk.recover();                      // rebuild note state from on-chain after restart
 *
 * Targets the live V3 mainnet program (HVcTokFF...) — sharded root ring,
 * gasless `/v3/withdraw` relay, V3 memo prefix `zerok:v3:`.
 */

'use strict';

const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const { buildPoseidon } = require('circomlibjs');
const snarkjs = require('snarkjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nacl = require('tweetnacl');

const { deposit: v3Deposit } = require('../v3/deposit.js');
const {
  PROGRAM_ID,
  fieldToBytesBE,
  hexToFr,
  serializeProof,
} = require('../v3/canonical.js');
const { greedySplit } = require('../v2-core/planner.js');
const { calculateRelayFee } = require('../v2-core/fee.js');
const { buildV3Witness } = require('../v2-core/v3-witness.js');

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULTS = {
  'mainnet-beta': {
    rpc: 'https://api.mainnet-beta.solana.com',
    relay: 'https://zerok-relay-mainnet-production.up.railway.app',
    relayer: 'BEWNKrbVnLuWxPqVLSszwZpC6o86mC8RoSAWDaWwFivq',
  },
  'devnet': {
    rpc: 'https://api.devnet.solana.com',
    relay: 'https://zerok-relay-v2-production.up.railway.app',
    relayer: 'BEWNKrbVnLuWxPqVLSszwZpC6o86mC8RoSAWDaWwFivq',
  },
};

// V1-style circuit artifacts (live V3 path uses these; 8 public inputs)
const CIRCUIT_WASM = path.join(__dirname, '../../circuits/build/withdraw_fixed_js/withdraw_fixed.wasm');
const CIRCUIT_ZKEY = path.join(__dirname, '../../circuits/build/withdraw_final.zkey');

// =============================================================================
// SHARED HELPERS
// =============================================================================

let _poseidonPromise = null;
function getPoseidon() {
  if (!_poseidonPromise) _poseidonPromise = buildPoseidon();
  return _poseidonPromise;
}

/**
 * Derive the wallet-bound AES-256-GCM key used to encrypt deposit memos.
 * Matches web/src/lib/note-encryption.ts and sdk/v2/cli-encrypt.js exactly:
 * SHA-256(Ed25519 sign of "zerok-note-recovery-v1" with wallet secret).
 */
function deriveEncryptionKey(walletKeypair) {
  const sig = nacl.sign.detached(Buffer.from('zerok-note-recovery-v1'), walletKeypair.secretKey);
  return crypto.createHash('sha256').update(sig).digest();
}

// =============================================================================
// ERROR CLASS
// =============================================================================

class ZeroKError extends Error {
  constructor(code, message, actionable) {
    super(message);
    this.name = 'ZeroKError';
    this.code = code;          // e.g. 'INSUFFICIENT_BALANCE', 'RELAY_UNAVAILABLE'
    this.actionable = actionable; // one-line hint for the agent
  }
  toJSON() {
    return { name: this.name, code: this.code, message: this.message, actionable: this.actionable };
  }
}

// =============================================================================
// ZEROK CLASS
// =============================================================================

class ZeroK {
  /**
   * @param {Object} options
   * @param {string} options.network  - 'mainnet-beta' or 'devnet'
   * @param {Keypair} options.wallet  - Solana Keypair (agent's wallet)
   * @param {string} [options.rpc]    - Custom RPC endpoint
   * @param {string} [options.relay]  - Custom relay URL
   * @param {string} [options.relayer] - Override relayer pubkey (must match relay's actual signer)
   * @param {string} [options.notesDir] - Directory for on-disk note cache (default: ./notes)
   */
  constructor({ network = 'mainnet-beta', wallet, rpc, relay, relayer, notesDir } = {}) {
    if (!wallet) {
      throw new ZeroKError('BAD_SIGNER', 'wallet is required (Solana Keypair)',
        'Pass a Keypair: new ZeroK({ wallet: Keypair.fromSecretKey(...) }).');
    }
    if (!(wallet instanceof Keypair) && !wallet.secretKey) {
      throw new ZeroKError('BAD_SIGNER', 'wallet must be a Solana Keypair (has secretKey)',
        'Reconstruct with Keypair.fromSecretKey(Uint8Array of 64 bytes).');
    }

    const defaults = DEFAULTS[network];
    if (!defaults && (!rpc || !relay)) {
      throw new ZeroKError('BAD_NETWORK', `Unknown network: ${network}`,
        'For custom networks pass rpc and relay manually, or use "mainnet-beta" / "devnet".');
    }

    this.network = network;
    this.wallet = wallet;
    this.rpc = rpc || defaults.rpc;
    this.relayUrl = relay || defaults.relay;
    this.relayerPubkey = new PublicKey(relayer || defaults.relayer);
    this.connection = new Connection(this.rpc, 'confirmed');
    this.notesDir = notesDir || path.join(process.cwd(), 'notes');
    this._encryptionKey = deriveEncryptionKey(wallet);
    this._notes = []; // session cache
    // Layer 1 (instant, no network): hydrate cache from disk if notesDir already
    // has note files from a prior session. Mirrors the website's localStorage
    // hydrate-on-mount behavior. Layer 2 (on-chain) is recover().
    this._loadNotesFromDisk();
  }

  /**
   * Scan notesDir/<denom>/note_*.json and populate the in-memory cache.
   * Idempotent — dedupes by commitment. Same network only.
   */
  _loadNotesFromDisk() {
    try {
      if (!fs.existsSync(this.notesDir)) return 0;
      const expectedNetwork = this.network === 'mainnet-beta' ? 'mainnet' : this.network;
      const seen = new Set(this._notes.map(n => n.commitment));
      let loaded = 0;
      for (const denomDir of fs.readdirSync(this.notesDir)) {
        const dir = path.join(this.notesDir, denomDir);
        if (!fs.statSync(dir).isDirectory() || denomDir.startsWith('.')) continue;
        for (const f of fs.readdirSync(dir)) {
          if (!f.startsWith('note_') || !f.endsWith('.json')) continue;
          try {
            const note = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            if (note.network && note.network !== expectedNetwork) continue;
            if (seen.has(note.commitment)) continue;
            note._path = path.join(dir, f);
            this._notes.push(note);
            seen.add(note.commitment);
            loaded++;
          } catch { /* skip malformed */ }
        }
      }
      return loaded;
    } catch { return 0; }
  }

  /**
   * Deposit SOL into ZeroK pools.
   * Greedy-splits across deployed denominations (0.1, 1, 10, 100, 1000 SOL).
   * Each note is saved to disk before tx is sent (fund-safety invariant).
   *
   * @param {number} solAmount
   * @param {Object} [opts]
   * @param {string} [opts.idempotencyKey] - If set and a prior call with the
   *   same key fully succeeded, returns the cached result without re-submitting.
   *   NOTE: cache is written only on full success. A crash mid-deposit followed
   *   by a retry with the same key WILL replay the whole split (each note is
   *   atomic on-chain; the wallet can end up with extra notes). For per-note
   *   precision, split the call yourself.
   * @returns {Promise<{ notes:number, denominations:string[], signatures:string[] }>}
   */
  async deposit(solAmount, opts = {}) {
    if (opts.idempotencyKey) {
      const cached = this._loadIdempotency('deposit', opts.idempotencyKey);
      if (cached) return cached;
    }
    if (typeof solAmount !== 'number' || !isFinite(solAmount) || solAmount <= 0) {
      throw new ZeroKError('BAD_AMOUNT', `Invalid amount: ${solAmount}`, 'Pass a positive number of SOL.');
    }
    if (solAmount < 0.1) {
      throw new ZeroKError('BAD_AMOUNT', 'Minimum deposit: 0.1 SOL',
        'ZeroK denominations start at 0.1 SOL.');
    }

    const lamports = BigInt(Math.round(Math.round(solAmount * 10) / 10 * 1e9));
    const splits = greedySplit(lamports);
    if (splits.length === 0) {
      throw new ZeroKError('BAD_AMOUNT', `Amount ${solAmount} SOL cannot be split into supported denominations`,
        'Try a multiple of 0.1 SOL.');
    }

    const networkLabel = this.network === 'mainnet-beta' ? 'mainnet' : 'devnet';
    const results = [];

    for (const denom of splits) {
      const denomLabel = (Number(denom) / 1e9).toString().replace('.', 'p');
      try {
        const r = await v3Deposit({
          connection: this.connection,
          denomination: denom,
          wallet: this.wallet,
          options: {
            encryptionKey: this._encryptionKey,
            notesDir: path.join(this.notesDir, denomLabel),
            network: networkLabel,
            poolId: `${this.network}-${denomLabel}sol-v3`,
          },
        });
        const noteContent = JSON.parse(fs.readFileSync(r.notePath, 'utf8'));
        this._notes.push({ ...noteContent, _path: r.notePath });
        results.push({ denomination: denom, signature: r.txSignature, leafIndex: r.leafIndex });
      } catch (e) {
        if (e instanceof ZeroKError) throw e;
        if (/Insufficient balance/i.test(e.message || '')) {
          throw new ZeroKError('INSUFFICIENT_WALLET_SOL', e.message,
            'Top up the agent wallet (need denomination + ~0.01 SOL fee buffer per deposit).');
        }
        throw new ZeroKError('DEPOSIT_FAILED', e.message || String(e),
          'Verify pool state and wallet balance; review notes/<denom>/pending_*.json for stuck tx.');
      }
    }

    const result = {
      notes: results.length,
      denominations: results.map(r => Number(r.denomination) / 1e9 + ' SOL'),
      signatures: results.map(r => r.signature),
    };
    if (opts.idempotencyKey) this._saveIdempotency('deposit', opts.idempotencyKey, result);
    return result;
  }

  /**
   * Send SOL privately to a recipient via the gasless protocol relay.
   * Selects unspent notes greedily (largest first), generates one Groth16 proof
   * per note, POSTs each to /v3/withdraw. Recipient receives `denom - fee`.
   *
   * @param {number} solAmount
   * @param {string|PublicKey} recipient
   * @param {Object} [opts]
   * @param {string} [opts.idempotencyKey] - Retry-safe key. The relay also
   *   dedupes by nullifier independently, so even without a key a duplicate
   *   send returns the original signature instead of double-spending.
   * @returns {Promise<{ sent:number, fee:number, signatures:string[] }>}
   */
  async send(solAmount, recipient, opts = {}) {
    if (opts.idempotencyKey) {
      const cached = this._loadIdempotency('send', opts.idempotencyKey);
      if (cached) return cached;
    }
    if (typeof solAmount !== 'number' || !isFinite(solAmount) || solAmount <= 0) {
      throw new ZeroKError('BAD_AMOUNT', `Invalid amount: ${solAmount}`, 'Pass a positive number of SOL.');
    }
    if (!recipient) {
      throw new ZeroKError('BAD_RECIPIENT', 'recipient is required', 'Pass a base58 pubkey or PublicKey.');
    }
    let recipientPubkey;
    try {
      recipientPubkey = typeof recipient === 'string' ? new PublicKey(recipient) : recipient;
    } catch (e) {
      throw new ZeroKError('BAD_RECIPIENT', `Invalid recipient: ${e.message}`, 'Use a valid base58 Solana address.');
    }

    const target = BigInt(Math.round(Math.round(solAmount * 10) / 10 * 1e9));

    const unspent = this._notes
      .filter(n => n.status !== 'spent' && this._isUsable(n))
      .sort((a, b) => {
        const da = BigInt(a.denomination), db = BigInt(b.denomination);
        if (da !== db) return da > db ? -1 : 1;
        return (a.leafIndex || 0) - (b.leafIndex || 0);
      });

    const selected = [];
    let remaining = target;
    for (const n of unspent) {
      if (remaining <= 0n) break;
      const d = BigInt(n.denomination);
      if (d <= remaining) {
        selected.push(n);
        remaining -= d;
      }
    }

    if (remaining > 0n) {
      const have = unspent.reduce((s, n) => s + BigInt(n.denomination), 0n);
      throw new ZeroKError('INSUFFICIENT_BALANCE',
        `Want ${solAmount} SOL, have ${Number(have) / 1e9} SOL across ${unspent.length} notes.`,
        'Deposit more first via zk.deposit(), or call zk.recover() if notes were created in a previous session.');
    }

    const signatures = [];
    let totalFee = 0n;

    for (const note of selected) {
      const denom = BigInt(note.denomination);
      const fee = calculateRelayFee(denom);
      totalFee += fee;

      const { proofBytes, nullifierHashBE, rootBuf } =
        await this._generateProof(note, recipientPubkey, fee);

      let body;
      let response;
      try {
        response = await fetch(`${this.relayUrl}/v3/withdraw`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            proof: proofBytes.toString('base64'),
            nullifierHash: Buffer.from(nullifierHashBE).toString('base64'),
            root: rootBuf.toString('base64'),
            recipient: recipientPubkey.toBase58(),
            denomination: Number(denom),
            fee: Number(fee),
          }),
        });
      } catch (e) {
        throw new ZeroKError('RELAY_UNAVAILABLE', e.message || 'fetch failed',
          'Network or relay outage. Retry; the proof is reusable on the same root.');
      }

      try {
        body = await response.json();
      } catch (e) {
        throw new ZeroKError('RELAY_UNAVAILABLE', `Non-JSON response (HTTP ${response.status})`,
          'Relay may be restarting; retry shortly.');
      }

      if (!response.ok || !body.signature) {
        const msg = body.error || body.message || `HTTP ${response.status}`;
        // Map known relay errors to actionable codes
        if (/already spent|nullifier/i.test(msg)) {
          throw new ZeroKError('NULLIFIER_ALREADY_SPENT', msg,
            'This note was already withdrawn. Mark it spent locally and pick another.');
        }
        if (/RootNotFound|root.*history|evicted/i.test(msg)) {
          throw new ZeroKError('NOTE_STALE', msg,
            'Pool state evolved past this note\'s root. Call zk.recover() to refresh.');
        }
        if (/fee/i.test(msg)) {
          throw new ZeroKError('FEE_REJECTED', msg,
            'Fee outside on-chain max_fee_bps. Check pool config.');
        }
        throw new ZeroKError('RELAY_REJECTED', msg, `Relay said: ${msg}. Inspect and retry.`);
      }

      // Mark spent — both in-memory and on disk
      note.status = 'spent';
      note.spentTx = body.signature;
      try {
        if (note._path && fs.existsSync(note._path)) {
          const persisted = { ...note };
          delete persisted._path;
          fs.writeFileSync(note._path, JSON.stringify(persisted, null, 2));
        }
      } catch (_) { /* best effort */ }

      signatures.push(body.signature);
    }

    const result = { sent: solAmount, fee: Number(totalFee) / 1e9, signatures };
    if (opts.idempotencyKey) this._saveIdempotency('send', opts.idempotencyKey, result);
    return result;
  }

  /**
   * Synchronous local-cache balance.
   * Reflects only notes the SDK has seen this session (deposits + recovered).
   * Call recover() first if reattaching to a wallet from a previous session.
   *
   * @returns {{ total:number, notes:number, breakdown:Object }}
   */
  balance() {
    const unspent = this._notes.filter(n => n.status !== 'spent' && this._isUsable(n));
    const total = unspent.reduce((s, n) => s + BigInt(n.denomination), 0n);
    const breakdown = {};
    for (const n of unspent) {
      const lbl = Number(BigInt(n.denomination)) / 1e9 + ' SOL';
      breakdown[lbl] = (breakdown[lbl] || 0) + 1;
    }
    return { total: Number(total) / 1e9, notes: unspent.length, breakdown };
  }

  /**
   * Rebuild note state from on-chain memos (handles agent restarts).
   * Implementation lives in ./recover.js (Stage 1 task #37).
   * @returns {Promise<{ recovered:number, notes:Array }>}
   */
  async recover() {
    const { recoverNotes } = require('./recover.js');
    const result = await recoverNotes({
      connection: this.connection,
      wallet: this.wallet,
      encryptionKey: this._encryptionKey,
      network: this.network,
      relayerPubkey: this.relayerPubkey,
      notesDir: this.notesDir,
      existing: this._notes,
    });
    // Merge recovered notes into session cache (dedupe by commitment)
    const seen = new Set(this._notes.map(n => n.commitment));
    for (const n of result.notes) {
      if (!seen.has(n.commitment)) {
        this._notes.push(n);
        seen.add(n.commitment);
      }
    }
    return { recovered: result.notes.length, notes: result.notes };
  }

  /**
   * Returns the agent wallet's public key.
   */
  address() {
    return this.wallet.publicKey.toBase58();
  }

  // ---------------------------------------------------------------------------
  // INTERNALS
  // ---------------------------------------------------------------------------

  _idemPath(scope, key) {
    const safe = String(key).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
    return path.join(this.notesDir, '.idempotency', `${scope}__${safe}.json`);
  }
  _loadIdempotency(scope, key) {
    try {
      const p = this._idemPath(scope, key);
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { return null; }
  }
  _saveIdempotency(scope, key, value) {
    try {
      const p = this._idemPath(scope, key);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(value, null, 2));
    } catch { /* best effort */ }
  }

  _isUsable(note) {
    return note &&
           note.nullifier && note.secret &&
           note.leafIndex !== undefined && note.leafIndex !== null &&
           note.currentRoot &&
           Array.isArray(note.pathElements) && note.pathElements.length === 20 &&
           Array.isArray(note.pathIndices) && note.pathIndices.length === 20;
  }

  /**
   * Generate a Groth16 proof for `note`, committed to recipient + relayer + fee.
   * Returns the wire-encoded inputs for POST /v3/withdraw.
   */
  async _generateProof(note, recipientPubkey, fee) {
    const poseidon = await getPoseidon();
    const nullifier = hexToFr(note.nullifier);
    const secret = hexToFr(note.secret);
    const pathElements = note.pathElements.map(h => hexToFr(h));

    const { witness, nullifierHash, computedRoot } = buildV3Witness(poseidon, {
      nullifier,
      secret,
      pathElements,
      pathIndices: note.pathIndices,
      recipientBytes: recipientPubkey.toBytes(),
      relayerBytes: this.relayerPubkey.toBytes(),
      fee,
    });

    const computedRootHex = fieldToBytesBE(computedRoot).toString('hex');
    if (computedRootHex !== note.currentRoot) {
      throw new ZeroKError('NOTE_STALE',
        `Root mismatch: computed ${computedRootHex.slice(0, 16)}... vs note ${note.currentRoot.slice(0, 16)}...`,
        'Note\'s stored Merkle path is inconsistent with its root. Call recover() to refresh from on-chain.');
    }

    if (!fs.existsSync(CIRCUIT_WASM)) {
      throw new ZeroKError('CIRCUIT_MISSING', `Circuit WASM not found at ${CIRCUIT_WASM}`,
        'Build circuits: `cd circuits && npm install && bash compile.sh` (see circuits/README.md).');
    }
    if (!fs.existsSync(CIRCUIT_ZKEY)) {
      throw new ZeroKError('CIRCUIT_MISSING', `Proving key not found at ${CIRCUIT_ZKEY}`,
        'Run trusted setup or download production zkey (see circuits/TRUSTED_SETUP.md).');
    }

    const { proof } = await snarkjs.groth16.fullProve(witness, CIRCUIT_WASM, CIRCUIT_ZKEY);
    const proofBytes = serializeProof(proof);
    const nullifierHashBE = fieldToBytesBE(nullifierHash);
    const rootBuf = Buffer.from(note.currentRoot, 'hex');

    return {
      proofBytes: Buffer.isBuffer(proofBytes) ? proofBytes : Buffer.from(proofBytes),
      nullifierHashBE,
      rootBuf,
    };
  }
}

module.exports = { ZeroK, ZeroKError, deriveEncryptionKey };
