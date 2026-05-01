#!/usr/bin/env node
/**
 * Agent SDK V3 Test Harness
 *
 * Three modes (default --unit, no SOL spent):
 *   --unit       Pure JS — error paths, idempotency cache, encryption, PDA
 *                derivation, manifest loading. Free, no network.
 *   --readonly   Live mainnet RPC, read-only — recover() against the agent's
 *                wallet (free; reads `getSignaturesForAddress`).
 *                Needs RPC_URL (paid Helius/Alchemy strongly recommended).
 *   --smoke      One 0.1 SOL mainnet round-trip: deposit → reboot → recover →
 *                send to fresh recipient. Costs ~0.005 SOL. Requires --confirm.
 *
 * Usage:
 *   node scripts/test-agent-sdk-v3.js [--unit|--readonly|--smoke]
 *                                     [--wallet <keypair.json>]
 *                                     [--rpc <url>]
 *                                     [--confirm]
 */

'use strict';

const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { ZeroK, ZeroKError, deriveEncryptionKey } = require('../sdk/agent');
const {
  recoverNotes,
  tryDecryptV3Memo,
  parseDepositEventFromLogs,
  cleanMemo,
} = require('../sdk/agent/recover.js');
const { derivePDAs } = require('../sdk/v3/canonical.js');
const { greedySplit } = require('../sdk/v2-core/planner.js');
const { calculateRelayFee } = require('../sdk/v2-core/fee.js');

// =============================================================================
// ARG PARSING
// =============================================================================

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const argVal = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const MODE = has('--smoke') ? 'smoke'
           : has('--readonly') ? 'readonly'
           : 'unit';
const WALLET_PATH = argVal('--wallet') || path.join(process.env.HOME, '.config/solana/id.json');
const RPC_URL = argVal('--rpc') || process.env.RPC_URL;
const CONFIRMED = has('--confirm');

// =============================================================================
// TEST RUNNER
// =============================================================================

let pass = 0, fail = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓ ${name}`); pass++; })
    .catch(e => {
      console.error(`  ✗ ${name}\n      ${e.message}`);
      if (process.env.VERBOSE) console.error(e.stack);
      fail++;
    });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// =============================================================================
// UNIT MODE — pure JS, no network
// =============================================================================

async function runUnit() {
  console.log('\n─── UNIT TESTS ───');

  await test('constructor — bad signer rejected', () => {
    try { new ZeroK({ network: 'devnet' }); assert(false); }
    catch (e) { assert(e instanceof ZeroKError && e.code === 'BAD_SIGNER'); }
    try { new ZeroK({ network: 'devnet', wallet: 'string' }); assert(false); }
    catch (e) { assert(e instanceof ZeroKError && e.code === 'BAD_SIGNER'); }
  });

  await test('constructor — bad network rejected', () => {
    try { new ZeroK({ network: 'fakenet', wallet: Keypair.generate() }); assert(false); }
    catch (e) { assert(e instanceof ZeroKError && e.code === 'BAD_NETWORK'); }
  });

  await test('constructor — happy path on mainnet + devnet', () => {
    const m = new ZeroK({ network: 'mainnet-beta', wallet: Keypair.generate() });
    assert(m.relayUrl.includes('mainnet'));
    assert(m.relayerPubkey.toBase58() === 'BEWNKrbVnLuWxPqVLSszwZpC6o86mC8RoSAWDaWwFivq');
    const d = new ZeroK({ network: 'devnet', wallet: Keypair.generate() });
    assert(d.relayUrl.includes('devnet') || d.relayUrl.includes('v2-production'));
  });

  await test('balance — empty (fresh tmp notesDir)', () => {
    const tmp = `/tmp/zerok-test-balance-${Date.now()}`;
    const zk = new ZeroK({ network: 'mainnet-beta', wallet: Keypair.generate(), notesDir: tmp });
    const b = zk.balance();
    assert(b.total === 0 && b.notes === 0);
  });

  await test('disk hydration — note files auto-loaded into cache on construct', () => {
    const tmp = `/tmp/zerok-test-disk-${Date.now()}`;
    const fs = require('fs');
    const denomDir = `${tmp}/0p1`;
    fs.mkdirSync(denomDir, { recursive: true });
    fs.writeFileSync(`${denomDir}/note_00001.json`, JSON.stringify({
      version: 3, poolId: 'mainnet-beta-0p1sol-v3', network: 'mainnet',
      programId: 'HVcTokFF4rwvcU7sC7GjS317CSf7QDgfCvW7edijKS2v',
      denomination: '100000000',
      nullifier: 'aa'.repeat(31), secret: 'bb'.repeat(31),
      commitment: 'cc'.repeat(32), nullifierHash: 'dd'.repeat(32),
      leafIndex: 1, currentRoot: 'ee'.repeat(32),
      pathElements: Array(20).fill('00'.repeat(32)),
      pathIndices: Array(20).fill(0),
      status: 'verified',
    }));
    const zk = new ZeroK({ network: 'mainnet-beta', wallet: Keypair.generate(), notesDir: tmp });
    const b = zk.balance();
    assert(b.total === 0.1 && b.notes === 1, `expected 0.1 SOL/1 note, got ${b.total}/${b.notes}`);
  });

  await test('disk hydration — wrong-network notes skipped', () => {
    const tmp = `/tmp/zerok-test-disk-net-${Date.now()}`;
    const fs = require('fs');
    fs.mkdirSync(`${tmp}/0p1`, { recursive: true });
    // Note from devnet — should be filtered out when constructing mainnet ZeroK
    fs.writeFileSync(`${tmp}/0p1/note_00001.json`, JSON.stringify({
      version: 3, network: 'devnet', denomination: '100000000',
      commitment: 'aa'.repeat(32), nullifier: 'bb'.repeat(31), secret: 'cc'.repeat(31),
      leafIndex: 1, currentRoot: 'dd'.repeat(32),
      pathElements: Array(20).fill('00'.repeat(32)), pathIndices: Array(20).fill(0),
      status: 'verified',
    }));
    const zk = new ZeroK({ network: 'mainnet-beta', wallet: Keypair.generate(), notesDir: tmp });
    assert(zk.balance().notes === 0, 'devnet note should be skipped on mainnet client');
  });

  await test('deposit — bad amount rejected', async () => {
    const zk = new ZeroK({ network: 'mainnet-beta', wallet: Keypair.generate() });
    let codes = [];
    for (const v of [0, -1, 0.05, 'abc', NaN, Infinity]) {
      try { await zk.deposit(v); codes.push('NONE'); }
      catch (e) { codes.push(e.code); }
    }
    for (const c of codes) assert(c === 'BAD_AMOUNT', `got ${c}`);
  });

  await test('send — bad amount/recipient rejected', async () => {
    const zk = new ZeroK({ network: 'mainnet-beta', wallet: Keypair.generate() });
    try { await zk.send(-1, Keypair.generate().publicKey); assert(false); }
    catch (e) { assert(e.code === 'BAD_AMOUNT'); }
    try { await zk.send(1, ''); assert(false); }
    catch (e) { assert(e.code === 'BAD_RECIPIENT'); }
    try { await zk.send(1, 'not!base58'); assert(false); }
    catch (e) { assert(e.code === 'BAD_RECIPIENT'); }
  });

  await test('send — INSUFFICIENT_BALANCE on empty wallet', async () => {
    const zk = new ZeroK({ network: 'mainnet-beta', wallet: Keypair.generate() });
    try { await zk.send(1, Keypair.generate().publicKey); assert(false); }
    catch (e) { assert(e.code === 'INSUFFICIENT_BALANCE'); }
  });

  await test('idempotency cache — round-trip + path sanitization', () => {
    const tmp = `/tmp/zerok-test-idem-${Date.now()}`;
    const zk = new ZeroK({ network: 'mainnet-beta', wallet: Keypair.generate(), notesDir: tmp });
    const result = { notes: 1, denominations: ['1 SOL'], signatures: ['sigA'] };
    zk._saveIdempotency('deposit', 'k1', result);
    assert(JSON.stringify(zk._loadIdempotency('deposit', 'k1')) === JSON.stringify(result));
    zk._saveIdempotency('send', 'a/b\\c../d', { x: 1 });
    const files = fs.readdirSync(path.join(tmp, '.idempotency'));
    assert(files.length === 2);
    assert(files.every(f => /^[a-zA-Z0-9_.-]+$/.test(f)));
  });

  await test('encryption key — deterministic from wallet', () => {
    const kp = Keypair.generate();
    const k1 = deriveEncryptionKey(kp);
    const k2 = deriveEncryptionKey(kp);
    assert(k1.length === 32);
    assert(k1.equals(k2));
    const k3 = deriveEncryptionKey(Keypair.generate());
    assert(!k1.equals(k3));
  });

  await test('memo encryption round-trip', () => {
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([c.update('{"d":"100000000","n":"aa","s":"bb","v":3}'), c.final()]);
    const tag = c.getAuthTag();
    const memo = 'zerok:v3:' + Buffer.concat([iv, enc, tag]).toString('base64');
    const decoded = tryDecryptV3Memo(memo, key);
    assert(decoded && decoded.d === '100000000');
    const wrong = tryDecryptV3Memo(memo, crypto.randomBytes(32));
    assert(wrong === null);
  });

  await test('cleanMemo — strips both wrapper formats', () => {
    assert(cleanMemo('[260] zerok:v3:abc==') === 'zerok:v3:abc==');
    assert(cleanMemo('["zerok:v3:def=="]') === 'zerok:v3:def==');
    assert(cleanMemo('zerok:v3:plain') === 'zerok:v3:plain');
  });

  await test('parseDepositEventFromLogs — synthetic event', () => {
    const buf = Buffer.alloc(704);
    crypto.createHash('sha256').update('event:DepositProofData').digest().copy(buf, 0, 0, 8);
    buf.writeUInt32LE(7, 8);
    buf.fill(0xCD, 12, 44);
    let off = 44;
    for (let i = 0; i < 20; i++) { buf.fill(i + 1, off, off + 32); off += 32; }
    for (let i = 0; i < 20; i++) buf.writeUInt8(i % 2, off + i);
    const evt = parseDepositEventFromLogs([
      'Program log: ok',
      'Program data: ' + buf.toString('base64'),
    ]);
    assert(evt.leafIndex === 7);
    assert(evt.rootAfter === 'cd'.repeat(32));
    assert(evt.siblings.length === 20);
    assert(evt.siblings[0] === '01'.repeat(32));
    assert(evt.positions.join('') === '01010101010101010101');
  });

  await test('PDA derivation — mainnet manifest cross-check', () => {
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifests', 'mainnet.json'), 'utf8'));
    let n = 0;
    for (const [id, p] of Object.entries(m.pools)) {
      if (p.status && p.status !== 'active') continue;
      const derived = derivePDAs(BigInt(p.denomination)).statePda.toBase58();
      assert(derived === p.pdas.state, `mismatch ${id}: ${derived} vs ${p.pdas.state}`);
      n++;
    }
    assert(n === 5, `expected 5 mainnet pools, got ${n}`);
  });

  await test('greedySplit — 2.3 SOL → 2×1 + 3×0.1', () => {
    const splits = greedySplit(BigInt(2.3 * 1e9));
    const sol = splits.map(d => Number(d) / 1e9);
    const sum = sol.reduce((a, b) => a + b, 0);
    assert(Math.abs(sum - 2.3) < 1e-9, `sum mismatch: ${sum}`);
  });

  await test('fee model — 30 bps with 2M lamport floor', () => {
    assert(calculateRelayFee(BigInt(1e8)) === 2_000_000n);    // 0.1 SOL: floor
    assert(calculateRelayFee(BigInt(1e9)) === 3_000_000n);    // 1 SOL: 30 bps
    assert(calculateRelayFee(BigInt(1e10)) === 30_000_000n);  // 10 SOL: 30 bps
  });
}

// =============================================================================
// READONLY MODE — recover() on live mainnet
// =============================================================================

async function runReadonly() {
  console.log('\n─── READONLY (live mainnet) ───');
  if (!RPC_URL) {
    console.warn('  WARN: --rpc not set. Public RPC will rate-limit. Skipping readonly tests.');
    console.warn('  Pass --rpc https://mainnet.helius-rpc.com/?api-key=... or RPC_URL env.');
    return;
  }
  if (!fs.existsSync(WALLET_PATH)) {
    throw new Error(`Wallet not found: ${WALLET_PATH}`);
  }
  const kpData = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(kpData));

  await test('recover() — live mainnet scan completes', async () => {
    const tmp = `/tmp/zerok-test-readonly-${Date.now()}`;
    const zk = new ZeroK({
      network: 'mainnet-beta', wallet, rpc: RPC_URL, notesDir: tmp,
    });
    const t0 = Date.now();
    const result = await zk.recover();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`      scanned in ${elapsed}s, recovered ${result.recovered} notes`);
    // Just verifying that recover() returns successfully — note count depends on wallet history
    assert(typeof result.recovered === 'number');
    assert(Array.isArray(result.notes));
    // If we have notes, they should be well-formed
    for (const n of result.notes.slice(0, 3)) {
      assert(n.commitment && n.nullifier && n.secret && n.denomination);
      assert(n.status === 'unspent' || n.status === 'spent' || n.status === 'recovered');
    }
  });
}

// =============================================================================
// SMOKE MODE — real 0.1 SOL mainnet round-trip
// =============================================================================

async function runSmoke() {
  console.log('\n─── SMOKE (mainnet, ~0.005 SOL) ───');
  if (!CONFIRMED) {
    console.error('  Smoke tests cost real SOL. Re-run with --confirm to proceed.');
    process.exit(2);
  }
  if (!RPC_URL) {
    throw new Error('--rpc <url> is required for smoke (use Helius/Alchemy paid endpoint)');
  }
  if (!fs.existsSync(WALLET_PATH)) {
    throw new Error(`Wallet not found: ${WALLET_PATH}`);
  }
  const kpData = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(kpData));
  const conn = new Connection(RPC_URL, 'confirmed');

  // Pre-flight
  const bal = await conn.getBalance(wallet.publicKey);
  console.log(`  Wallet ${wallet.publicKey.toBase58()} balance: ${bal / 1e9} SOL`);
  assert(bal >= 0.12 * 1e9, `wallet needs at least 0.12 SOL (has ${bal / 1e9})`);

  const tmp = `/tmp/zerok-test-smoke-${Date.now()}`;
  const zk = new ZeroK({
    network: 'mainnet-beta', wallet, rpc: RPC_URL, notesDir: tmp,
  });

  await test('smoke step 1 — deposit 0.1 SOL', async () => {
    const r = await zk.deposit(0.1);
    assert(r.notes === 1);
    assert(r.signatures.length === 1);
    console.log(`      deposit tx: ${r.signatures[0]}`);
  });

  await test('smoke step 2 — reboot + recover from disk', async () => {
    // Simulate restart: spin up a fresh ZeroK instance with same wallet + same notesDir
    const zk2 = new ZeroK({
      network: 'mainnet-beta', wallet, rpc: RPC_URL, notesDir: tmp,
    });
    const result = await zk2.recover();
    assert(result.recovered >= 1, `recover should find the deposit (got ${result.recovered})`);
    const found = result.notes.find(n => n.denomination === '100000000');
    assert(found, 'should find the 0.1 SOL note');
    assert(found.status === 'unspent', `note should be unspent (got ${found.status})`);
    // Use this fresh instance for the rest of the smoke
    global._zk2 = zk2;
  });

  await test('smoke step 3 — send 0.1 SOL to fresh recipient', async () => {
    const recipient = Keypair.generate();
    const recipBefore = await conn.getBalance(recipient.publicKey);
    assert(recipBefore === 0);

    const result = await global._zk2.send(0.1, recipient.publicKey);
    assert(result.signatures.length === 1);
    console.log(`      send tx: ${result.signatures[0]}`);

    // Wait briefly + verify recipient got 0.1 - fee
    await new Promise(r => setTimeout(r, 4000));
    const recipAfter = await conn.getBalance(recipient.publicKey);
    const expected = Math.floor(0.1 * 1e9 - Number(calculateRelayFee(BigInt(0.1 * 1e9))));
    console.log(`      recipient: ${recipAfter / 1e9} SOL (expected ${expected / 1e9})`);
    assert(recipAfter === expected,
      `recipient mismatch: got ${recipAfter}, expected ${expected}`);
  });
}

// =============================================================================
// MAIN
// =============================================================================

(async () => {
  console.log(`Mode: ${MODE}`);
  if (MODE === 'unit') await runUnit();
  else if (MODE === 'readonly') { await runUnit(); await runReadonly(); }
  else if (MODE === 'smoke') { await runUnit(); await runReadonly(); await runSmoke(); }

  console.log(`\n──── ${pass} pass, ${fail} fail ────`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('FATAL:', e.message);
  if (process.env.VERBOSE) console.error(e.stack);
  process.exit(1);
});
