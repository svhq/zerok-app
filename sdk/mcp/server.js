#!/usr/bin/env node
/**
 * ZeroK MCP server — gives any MCP-capable AI agent (Claude Desktop, Claude Code,
 * Cursor, custom agents…) private, GASLESS SOL payments on Solana.
 *
 * It exposes four tools — address, balance, deposit, send — over stdio. All the
 * ZK proving, note management, and relay communication is hidden; the agent just
 * decides amounts and recipients, exactly like a person using the web app.
 *
 * Configuration (via environment, set in your MCP client config):
 *   SOLANA_KEYPAIR   path to the wallet keypair JSON (e.g. ~/.config/solana/id.json)  [required]
 *   ZEROK_NETWORK    'mainnet-beta' (default) | 'devnet'
 *   ZEROK_RPC        optional custom RPC URL
 *   ZEROK_RELAY      optional custom relay URL
 *   ZEROK_NOTES_DIR  optional directory where notes persist
 *
 * The keypair never leaves the machine — the server reads it locally.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { readFileSync } from 'fs';
import { homedir } from 'os';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const { Keypair } = require('@solana/web3.js');
// Resolve the SDK from npm when installed as a package; fall back to the repo path in-tree.
let ZeroK;
try { ({ ZeroK } = require('zerok-agent')); }
catch { ({ ZeroK } = require(resolve(__dirname, '../agent/index.js'))); }

// Lazily construct the SDK so the server can start (and list tools) even before
// a wallet is configured; tool calls then surface a clear error if it's missing.
let _zk = null;
function getZk() {
  if (_zk) return _zk;
  const kpPath = process.env.SOLANA_KEYPAIR;
  if (!kpPath) {
    throw new Error('SOLANA_KEYPAIR is not set. Point it at your Solana keypair JSON (e.g. ~/.config/solana/id.json).');
  }
  const p = kpPath.replace(/^~(?=$|\/)/, homedir());
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
  _zk = new ZeroK({
    wallet,
    network: process.env.ZEROK_NETWORK || 'mainnet-beta',
    rpc: process.env.ZEROK_RPC || undefined,
    relay: process.env.ZEROK_RELAY || undefined,
    notesDir: process.env.ZEROK_NOTES_DIR || undefined,
  });
  return _zk;
}

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: 'Error: ' + msg }], isError: true });

const server = new McpServer({ name: 'zerok', version: '0.1.0' });

server.registerTool('zerok_address', {
  title: 'ZeroK wallet address',
  description: 'Return the public key of the wallet this ZeroK instance controls (deposits are funded from it).',
  inputSchema: {},
}, async () => { try { return ok({ address: getZk().address() }); } catch (e) { return fail(e.message); } });

server.registerTool('zerok_balance', {
  title: 'Private balance',
  description: 'Return your shielded (private) balance and note breakdown. No network call.',
  inputSchema: {},
}, async () => { try { return ok(getZk().balance()); } catch (e) { return fail(e.message); } });

server.registerTool('zerok_deposit', {
  title: 'Shield SOL (deposit)',
  description:
    'Shield (deposit) SOL into ZeroK privacy pools. The amount must be a multiple of 0.1 SOL and is auto-split into fixed denominations (0.1/1/10/100/1000). Funds come from the configured wallet, which must hold enough SOL plus a small network fee.',
  inputSchema: { amount_sol: z.number().positive().describe('SOL to shield, a multiple of 0.1 (e.g. 1.5)') },
}, async ({ amount_sol }) => { try { return ok(await getZk().deposit(amount_sol)); } catch (e) { return fail(e.message); } });

server.registerTool('zerok_send', {
  title: 'Private gasless send',
  description:
    'Send SOL privately and GASLESS to any Solana address. The recipient needs zero SOL and never sees the sender. The amount must be composable from your shielded notes (sums of 0.1/1/10/100/1000 SOL). A 0.3% protocol fee (min 0.002 SOL) per note is deducted.',
  inputSchema: {
    amount_sol: z.number().positive().describe('SOL to send privately'),
    recipient: z.string().describe('Recipient Solana address (base58)'),
  },
}, async ({ amount_sol, recipient }) => { try { return ok(await getZk().send(amount_sol, recipient)); } catch (e) { return fail(e.message); } });

await server.connect(new StdioServerTransport());
