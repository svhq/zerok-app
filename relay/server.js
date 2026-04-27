#!/usr/bin/env node
/**
 * ZeroK Relay — V3 Mainnet Path
 *
 * Stateless protocol-paid withdrawal relay. Receives a Groth16 proof + public
 * inputs, signs and submits the on-chain `withdraw_v2_clean` instruction,
 * pays the network fee + nullifier-PDA rent from the relay's own balance,
 * and returns the signature.
 *
 * - JSON instruction format (not opaque binary)
 * - Per-request validation against on-chain state
 * - In-memory LRU cache for nullifier deduplication (replay protection)
 * - Sanitized logging (no recipient/proof bodies)
 * - Concurrency limiting + RPC failover
 *
 * No indexer, no database, no catch-up state.
 */

const Fastify = require('fastify');
const cors = require('@fastify/cors');
const {
  Connection,
  Keypair,
  TransactionInstruction,
  PublicKey,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const crypto_module = require('crypto');

// ─── Configuration ──────────────────────────────────────────────────────────
const NETWORK = process.env.NETWORK || 'mainnet';
const RPC_URL = process.env.RPC_URL;
const RPC_URLS = process.env.RPC_URLS
  ? process.env.RPC_URLS.split(',').map(u => u.trim())
  : (RPC_URL ? [RPC_URL] : []);
const PORT = parseInt(process.env.PORT || '8789', 10);
const CONFIG_PATH = process.env.CONFIG_PATH || `../generated/config/${NETWORK}.json`;
const RELAY_MODE = process.env.RELAY_MODE || 'subsidized';
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '4', 10);

const NULLIFIER_CACHE_SIZE = 1000;
const NULLIFIER_CACHE_TTL_MS = 10 * 60 * 1000;

// ─── Replay-protection: nullifier dedup cache ───────────────────────────────
class NullifierCache {
  constructor(maxSize = NULLIFIER_CACHE_SIZE, ttlMs = NULLIFIER_CACHE_TTL_MS) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }
  has(key) {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }
  add(key) {
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { timestamp: Date.now() });
  }
  markComplete(key, signature) {
    const entry = this.cache.get(key);
    if (entry) { entry.signature = signature; entry.complete = true; }
  }
  getExisting(key) {
    const entry = this.cache.get(key);
    return entry?.complete ? entry.signature : null;
  }
}

// ─── Concurrency limiter (max in-flight submissions) ───────────────────────
class ConcurrencyLimiter {
  constructor(max) { this.max = max; this.current = 0; }
  async acquire() {
    while (this.current >= this.max) await new Promise(r => setTimeout(r, 100));
    this.current++;
  }
  release() { this.current--; }
}

// ─── Pool config & relayer keypair loaders ──────────────────────────────────
function loadPoolConfig() {
  const poolConfigJson = process.env.POOL_CONFIG_JSON;
  if (poolConfigJson) {
    try {
      const config = JSON.parse(poolConfigJson);
      return new Map(config.pools.map(p => [p.poolId, p]));
    } catch (err) {
      throw new Error(`Failed to parse POOL_CONFIG_JSON: ${err.message}`);
    }
  }
  const configPath = path.resolve(__dirname, CONFIG_PATH);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Pool config not found: ${configPath}. Set POOL_CONFIG_JSON env var.`);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return new Map(config.pools.map(p => [p.poolId, p]));
}

function loadRelayerKeypair() {
  const privateKeyJson = process.env.RELAYER_PRIVATE_KEY;
  if (privateKeyJson) {
    try {
      const data = JSON.parse(privateKeyJson);
      return Keypair.fromSecretKey(new Uint8Array(data));
    } catch (err) {
      throw new Error(`Failed to parse RELAYER_PRIVATE_KEY: ${err.message}`);
    }
  }
  const keypairPath = process.env.TSOL_FEE_PAYER;
  if (!keypairPath) {
    throw new Error('RELAYER_PRIVATE_KEY or TSOL_FEE_PAYER environment variable required');
  }
  if (!fs.existsSync(keypairPath)) {
    throw new Error(`Relayer keypair not found: ${keypairPath}`);
  }
  const data = JSON.parse(fs.readFileSync(keypairPath, 'utf8'));
  return Keypair.fromSecretKey(new Uint8Array(data));
}

// ─── RPC endpoint manager with failover ─────────────────────────────────────
class RpcEndpointManager {
  constructor(urls) {
    this.urls = urls.length > 0 ? urls : ['https://api.mainnet-beta.solana.com'];
    this.currentIndex = 0;
    this.failedEndpoints = new Map();
    this.cooldownMs = 60000;
  }
  getCurrentUrl() {
    const now = Date.now();
    for (const [url, ts] of this.failedEndpoints.entries()) {
      if (now - ts > this.cooldownMs) this.failedEndpoints.delete(url);
    }
    for (let i = 0; i < this.urls.length; i++) {
      const url = this.urls[(this.currentIndex + i) % this.urls.length];
      if (!this.failedEndpoints.has(url)) return url;
    }
    this.failedEndpoints.clear();
    return this.urls[this.currentIndex];
  }
  markFailed(url) {
    this.failedEndpoints.set(url, Date.now());
    this.currentIndex = (this.currentIndex + 1) % this.urls.length;
  }
  createConnection() {
    return new Connection(this.getCurrentUrl(), 'confirmed');
  }
}

// ─── Constants: program ID & memo program ───────────────────────────────────
const V2_PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID_V2 || 'HVcTokFF4rwvcU7sC7GjS317CSf7QDgfCvW7edijKS2v'
);
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

async function main() {
  if (RPC_URLS.length === 0) {
    console.error('ERROR: RPC_URL or RPC_URLS environment variable not set');
    process.exit(1);
  }
  if (RELAY_MODE === 'disabled') {
    console.error('ERROR: RELAY_MODE is disabled');
    process.exit(1);
  }

  const pools = loadPoolConfig();
  const relayerKeypair = loadRelayerKeypair();
  const rpcManager = new RpcEndpointManager(RPC_URLS);
  const nullifierCache = new NullifierCache();
  const concurrencyLimiter = new ConcurrencyLimiter(MAX_CONCURRENCY);

  const server = Fastify({
    logger: {
      level: 'info',
      transport: { target: 'pino-pretty', options: { colorize: true } },
      // PRIVACY: never log request/response bodies (proofs, recipients)
      serializers: {
        req(request) {
          return { method: request.method, url: request.url, hostname: request.hostname };
        },
        res(reply) { return { statusCode: reply.statusCode }; }
      }
    }
  });
  await server.register(cors, { origin: true, methods: ['GET', 'POST'] });

  console.log('='.repeat(60));
  console.log('  ZEROK RELAY — V3 mainnet path');
  console.log('='.repeat(60));
  console.log(`  Network:      ${NETWORK}`);
  console.log(`  Relayer:      ${relayerKeypair.publicKey.toBase58()}`);
  console.log(`  Pools:        ${pools.size}`);
  console.log(`  Concurrency:  ${MAX_CONCURRENCY}`);
  console.log(`  Endpoints:    ${RPC_URLS.length}`);
  console.log('='.repeat(60));

  // ─── Health & info ────────────────────────────────────────────────────────
  server.get('/health', async () => ({
    status: 'ok',
    network: NETWORK,
    relayer: relayerKeypair.publicKey.toBase58(),
    pools: Array.from(pools.keys()),
    rpc: { total_endpoints: rpcManager.urls.length, failed_count: rpcManager.failedEndpoints.size }
  }));

  server.get('/pools', async () => ({
    network: NETWORK,
    relayer: relayerKeypair.publicKey.toBase58(),
    pools: Array.from(pools.values()).map(p => ({
      poolId: p.poolId,
      denomination: p.denominationDisplay,
      denominationLamports: p.denominationLamports
    }))
  }));

  // ════════════════════════════════════════════════════════════════════════
  // POST /v3/withdraw
  // Body: {
  //   proof:         base64(256 bytes) — Groth16 A+B+C
  //   nullifierHash: base64(32 bytes)
  //   root:          base64(32 bytes)
  //   recipient:     base58 pubkey
  //   denomination:  number (lamports) — which pool
  //   memoText:      string (optional — encrypted note seed for recovery)
  //   fee:           number (optional — lamports, must be ≤ on-chain max)
  // }
  // Response: { ok, signature, confirmed }
  // ════════════════════════════════════════════════════════════════════════

  const V3_SEEDS = {
    STATE:         Buffer.from('zerok_v1'),
    VAULT:         Buffer.from('vault'),
    VK:            Buffer.from('vk'),
    NULLIFIER:     Buffer.from('nullifier'),
    ROOT_RING:     Buffer.from('roots'),
    RING_METADATA: Buffer.from('root_ring_metadata'),
    RING_SHARD:    Buffer.from('root_ring_shard'),
  };

  const V3_DENOMINATIONS = new Set([
    100_000_000n,         // 0.1 SOL
    1_000_000_000n,       // 1 SOL
    10_000_000_000n,      // 10 SOL
    100_000_000_000n,     // 100 SOL
    1_000_000_000_000n,   // 1000 SOL
  ]);

  const V3_NUM_SHARDS = 20;
  const V3_MIN_RELAY_FEE = 2_000_000n; // 0.002 SOL
  const V3_FEE_BPS = 30n;              // 0.3%
  const MAX_FEE_BPS_OFFSET = 8984;     // u16 LE in pool state account

  function v3MinFee(d) {
    const bps = d * V3_FEE_BPS / 10000n;
    return bps > V3_MIN_RELAY_FEE ? bps : V3_MIN_RELAY_FEE;
  }

  function deriveV3PDAs(d) {
    const denomBuf = Buffer.alloc(8);
    denomBuf.writeBigUInt64LE(d);
    const [statePda]    = PublicKey.findProgramAddressSync([V3_SEEDS.STATE, denomBuf], V2_PROGRAM_ID);
    const [vaultPda]    = PublicKey.findProgramAddressSync([V3_SEEDS.VAULT, denomBuf], V2_PROGRAM_ID);
    const [vkPda]       = PublicKey.findProgramAddressSync([V3_SEEDS.VK, denomBuf], V2_PROGRAM_ID);
    const [rootRingPda] = PublicKey.findProgramAddressSync([V3_SEEDS.ROOT_RING, statePda.toBuffer()], V2_PROGRAM_ID);
    const [ringMetaPda] = PublicKey.findProgramAddressSync([V3_SEEDS.RING_METADATA, statePda.toBuffer()], V2_PROGRAM_ID);
    return { statePda, vaultPda, vkPda, rootRingPda, ringMetaPda };
  }

  function deriveV3ShardPda(statePda, shardIndex) {
    const idxBuf = Buffer.alloc(4);
    idxBuf.writeUInt32LE(shardIndex);
    const [pda] = PublicKey.findProgramAddressSync(
      [V3_SEEDS.RING_SHARD, statePda.toBuffer(), idxBuf], V2_PROGRAM_ID
    );
    return pda;
  }

  function deriveV3NullifierPda(statePda, nullifierHashBuf) {
    const [pda] = PublicKey.findProgramAddressSync(
      [V3_SEEDS.NULLIFIER, statePda.toBuffer(), nullifierHashBuf], V2_PROGRAM_ID
    );
    return pda;
  }

  // V3 ALTs loaded from environment: V3_ALT_<DENOM>=<address>
  const v3AltAddresses = new Map();
  for (const [key, val] of Object.entries(process.env)) {
    if (key.startsWith('V3_ALT_')) {
      const denom = BigInt(key.slice(7));
      v3AltAddresses.set(denom, new PublicKey(val));
      console.log(`[V3] ALT for ${Number(denom) / 1e9} SOL: ${val}`);
    }
  }

  server.post('/v3/withdraw', async (request, reply) => {
    const { proof, nullifierHash, root, recipient, denomination, memoText } = request.body || {};

    if (!proof || !nullifierHash || !root || !recipient || denomination == null) {
      return reply.code(400).send({
        error: 'Missing fields',
        required: ['proof', 'nullifierHash', 'root', 'recipient', 'denomination']
      });
    }

    let proofBuf, nullBuf, rootBuf, recipientPubkey;
    try {
      proofBuf = Buffer.from(proof, 'base64');
      nullBuf = Buffer.from(nullifierHash, 'base64');
      rootBuf = Buffer.from(root, 'base64');
      recipientPubkey = new PublicKey(recipient);
    } catch (e) {
      return reply.code(400).send({ error: 'Invalid encoding', message: e.message });
    }

    if (proofBuf.length !== 256) return reply.code(400).send({ error: 'Invalid proof size' });
    if (nullBuf.length !== 32)   return reply.code(400).send({ error: 'Invalid nullifierHash size' });
    if (rootBuf.length !== 32)   return reply.code(400).send({ error: 'Invalid root size' });

    const denomBig = BigInt(denomination);
    if (!V3_DENOMINATIONS.has(denomBig)) {
      return reply.code(400).send({ error: 'Invalid denomination' });
    }

    // Fee bounds — read on-chain max_fee_bps as authoritative limit
    const pdas = deriveV3PDAs(denomBig);
    let onChainMaxBps = 500n;
    try {
      const conn = rpcManager.createConnection();
      const poolInfo = await conn.getAccountInfo(pdas.statePda);
      if (poolInfo) onChainMaxBps = BigInt(poolInfo.data.readUInt16LE(MAX_FEE_BPS_OFFSET));
    } catch (e) { /* fallback to default */ }

    const onChainMax = denomBig * onChainMaxBps / 10000n;
    const clientFee  = request.body.fee != null ? BigInt(request.body.fee) : null;
    const minFee     = v3MinFee(denomBig) > onChainMax ? onChainMax : v3MinFee(denomBig);
    const fee        = clientFee != null ? clientFee : minFee;
    if (fee > onChainMax) {
      return reply.code(400).send({
        error: `Fee exceeds on-chain max (${onChainMaxBps} bps)`,
        max: onChainMax.toString()
      });
    }

    const nullifierPda = deriveV3NullifierPda(pdas.statePda, nullBuf);

    // Nullifier dedup
    const nullKey = 'v3:' + nullBuf.toString('hex');
    const existingSig = nullifierCache.getExisting(nullKey);
    if (existingSig) return reply.send({ ok: true, signature: existingSig, status: 'duplicate' });
    if (nullifierCache.has(nullKey)) return reply.code(409).send({ error: 'Processing' });
    nullifierCache.add(nullKey);

    try {
      // Build instruction — withdraw_v2_clean
      // Layout: disc(8) + nullifier_hash(32) + proof_vec(4+256) + root(32) + fee(8) + refund(8) = 348 bytes
      const disc = crypto_module.createHash('sha256').update('global:withdraw_v2_clean').digest().slice(0, 8);
      const proofVec = Buffer.alloc(4 + 256);
      proofVec.writeUInt32LE(256, 0);
      proofBuf.copy(proofVec, 4);
      const feeBuf = Buffer.alloc(8); feeBuf.writeBigUInt64LE(fee);
      const refundBuf = Buffer.alloc(8); refundBuf.writeBigUInt64LE(0n);
      const instructionData = Buffer.concat([disc, nullBuf, proofVec, rootBuf, feeBuf, refundBuf]);

      // 10 base accounts + 20 ring shards
      const shardPdas = [];
      for (let i = 0; i < V3_NUM_SHARDS; i++) shardPdas.push(deriveV3ShardPda(pdas.statePda, i));

      const withdrawIx = new TransactionInstruction({
        programId: V2_PROGRAM_ID,
        keys: [
          { pubkey: pdas.statePda,            isSigner: false, isWritable: true  },
          { pubkey: pdas.vkPda,               isSigner: false, isWritable: false },
          { pubkey: nullifierPda,             isSigner: false, isWritable: true  },
          { pubkey: pdas.vaultPda,            isSigner: false, isWritable: true  },
          { pubkey: recipientPubkey,          isSigner: false, isWritable: true  },
          { pubkey: relayerKeypair.publicKey, isSigner: true,  isWritable: true  }, // fee receiver
          { pubkey: relayerKeypair.publicKey, isSigner: true,  isWritable: true  }, // nullifier-PDA rent payer
          { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
          { pubkey: pdas.rootRingPda,         isSigner: false, isWritable: false },
          { pubkey: pdas.ringMetaPda,         isSigner: false, isWritable: false },
          ...shardPdas.map(p => ({ pubkey: p, isSigner: false, isWritable: false })),
        ],
        data: instructionData,
      });

      // Optional memo (encrypted note seed for cross-device recovery)
      const extraInstructions = [];
      if (memoText) {
        extraInstructions.push(new TransactionInstruction({
          programId: MEMO_PROGRAM_ID,
          keys: [],
          data: Buffer.from(memoText, 'utf8'),
        }));
      }

      // 30-account tx requires ALT
      const altPubkey = v3AltAddresses.get(denomBig);
      if (!altPubkey) {
        nullifierCache.cache.delete(nullKey);
        return reply.code(500).send({ error: 'No ALT configured for denomination ' + denomination });
      }

      await concurrencyLimiter.acquire();
      try {
        const conn = rpcManager.createConnection();
        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');

        const altInfo = await conn.getAddressLookupTable(altPubkey);
        if (!altInfo.value) {
          nullifierCache.cache.delete(nullKey);
          return reply.code(500).send({ error: 'ALT not found: ' + altPubkey.toBase58() });
        }

        const instructions = [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }),
          withdrawIx,
          ...extraInstructions,
        ];

        const messageV0 = new TransactionMessage({
          payerKey: relayerKeypair.publicKey,
          recentBlockhash: blockhash,
          instructions,
        }).compileToV0Message([altInfo.value]);

        const tx = new VersionedTransaction(messageV0);
        tx.sign([relayerKeypair]);

        const txSize = tx.serialize().length;
        if (txSize > 1232) {
          nullifierCache.cache.delete(nullKey);
          return reply.code(500).send({ error: 'Transaction too large: ' + txSize });
        }

        // Simulate first — catches nullifier-replay before paying fees
        const sim = await conn.simulateTransaction(tx);
        if (sim.value.err) {
          const logs = sim.value.logs || [];
          const isNullifierUsed = logs.some(l =>
            l.includes('nullifier') && (l.includes('already') || l.includes('used'))
          );
          nullifierCache.cache.delete(nullKey);
          if (isNullifierUsed) {
            return reply.code(409).send({ ok: false, error: 'NULLIFIER_ALREADY_USED' });
          }
          return reply.code(502).send({
            ok: false, error: 'Simulation failed', message: JSON.stringify(sim.value.err), logs
          });
        }

        const signature = await conn.sendTransaction(tx, { skipPreflight: true });
        const confirmation = await conn.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight }, 'confirmed'
        );

        if (confirmation.value?.err) {
          nullifierCache.cache.delete(nullKey);
          return reply.code(502).send({
            ok: false, error: 'Confirmation failed', message: JSON.stringify(confirmation.value.err)
          });
        }

        nullifierCache.markComplete(nullKey, signature);
        return reply.send({ ok: true, signature, confirmed: true });
      } finally {
        concurrencyLimiter.release();
      }
    } catch (err) {
      nullifierCache.cache.delete(nullKey);
      return reply.code(500).send({ error: 'Internal error', message: err.message });
    }
  });

  try {
    await server.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`Relay listening on port ${PORT}  (health: http://localhost:${PORT}/health)`);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
