/**
 * ZeroK Agent SDK — Privacy for AI Agents
 *
 * Three methods. That's it.
 *
 *   const zk = new ZeroK({ network: 'mainnet-beta', wallet: keypair });
 *   await zk.deposit(2.3);              // deposit 2.3 SOL (auto-splits)
 *   await zk.send(1.0, recipient);      // send 1 SOL privately
 *   const bal = await zk.balance();     // check private balance
 *
 * All ZK proof generation, note management, and relay communication
 * happens internally. The agent never touches nullifiers, Merkle trees,
 * or circuit artifacts.
 */

'use strict';

const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const { deposit } = require('../v2/deposit.js');
const { withdraw } = require('../v2/withdraw.js');
const { greedySplit } = require('../v2-core/planner.js');
const { calculateRelayFee } = require('../v2-core/fee.js');
const { createCliEncryptor } = require('../v2/cli-encrypt.js');

const DEFAULTS = {
  'mainnet-beta': {
    rpc: 'https://api.mainnet-beta.solana.com',
    relay: 'https://zerok-relay-mainnet-production.up.railway.app',
  },
  'devnet': {
    rpc: 'https://api.devnet.solana.com',
    relay: 'https://zerok-relay-v2-production.up.railway.app',
  },
};

class ZeroK {
  constructor({ network = 'mainnet-beta', wallet, rpc, relay }) {
    if (!wallet) throw new Error('wallet is required (Solana Keypair)');
    const defaults = DEFAULTS[network];
    if (!defaults && !rpc) throw new Error(`Unknown network: ${network}. Provide rpc and relay.`);
    this.network = network;
    this.wallet = wallet;
    this.rpc = rpc || defaults.rpc;
    this.relayUrl = relay || defaults.relay;
    this.connection = new Connection(this.rpc, 'confirmed');
    this.encryptNote = createCliEncryptor(wallet);
    this._notes = [];
  }

  async deposit(solAmount) {
    if (solAmount < 0.1) throw new Error('Minimum deposit: 0.1 SOL');
    const lamports = BigInt(Math.round(Math.round(solAmount * 10) / 10 * 1e9));
    const splits = greedySplit(lamports);
    const results = [];
    for (const denom of splits) {
      const result = await deposit({
        connection: this.connection, amount: denom,
        wallet: this.wallet, denomination: denom,
        encryptNote: this.encryptNote,
      });
      this._notes.push({
        ...result.note, amount: denom.toString(),
        leafIndex: result.leafIndex, merkleRoot: result.merkleRoot,
        status: 'unspent',
      });
      results.push({ denomination: Number(denom) / 1e9, txSignature: result.txSignature });
    }
    return {
      notes: results.length,
      denominations: results.map(r => r.denomination + ' SOL'),
      txSignatures: results.map(r => r.txSignature),
    };
  }

  async send(solAmount, recipient) {
    const recipientPubkey = typeof recipient === 'string' ? new PublicKey(recipient) : recipient;
    const targetLamports = BigInt(Math.round(Math.round(solAmount * 10) / 10 * 1e9));
    const unspent = this._notes.filter(n => n.status === 'unspent')
      .sort((a, b) => {
        const da = BigInt(a.amount), db = BigInt(b.amount);
        if (da !== db) return da > db ? -1 : 1;
        return (a.leafIndex || 0) - (b.leafIndex || 0);
      });
    const selected = [];
    let remaining = targetLamports;
    for (const note of unspent) {
      if (remaining <= 0n) break;
      const d = BigInt(note.amount);
      if (d <= remaining) { selected.push(note); remaining -= d; }
    }
    if (remaining > 0n) {
      const available = unspent.reduce((s, n) => s + BigInt(n.amount), 0n);
      throw new Error(`Insufficient private balance. Want ${solAmount} SOL, have ${Number(available) / 1e9} SOL.`);
    }
    const results = [];
    let totalFee = 0n;
    for (const note of selected) {
      const denom = BigInt(note.amount);
      totalFee += calculateRelayFee(denom);
      const result = await withdraw({
        connection: this.connection, inputNote: note,
        withdrawalAmount: denom, denomination: denom,
        recipient: recipientPubkey, relayUrl: this.relayUrl,
        encryptNote: this.encryptNote,
      });
      note.status = 'spent';
      results.push(result.txSignature);
      if (selected.indexOf(note) < selected.length - 1) await new Promise(r => setTimeout(r, 500));
    }
    return { sent: solAmount, fee: Number(totalFee) / 1e9, txSignatures: results };
  }

  balance() {
    const unspent = this._notes.filter(n => n.status === 'unspent');
    const total = unspent.reduce((s, n) => s + BigInt(n.amount), 0n);
    const breakdown = {};
    for (const n of unspent) {
      const label = Number(BigInt(n.amount)) / 1e9 + ' SOL';
      breakdown[label] = (breakdown[label] || 0) + 1;
    }
    return { total: Number(total) / 1e9, notes: unspent.length, breakdown };
  }

  address() { return this.wallet.publicKey.toBase58(); }
}

module.exports = { ZeroK };
