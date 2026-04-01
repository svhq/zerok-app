# ZeroK for AI Agents

Private payments for autonomous agents on Solana.

## Why Agents Need Privacy

- **Spending patterns are public.** Every SOL transfer on Solana is visible. If your agent pays for compute, APIs, or data, anyone can see what it's buying and from whom.
- **Competitors can front-run.** If agents trade or purchase resources, visible transactions reveal strategy.
- **User privacy matters.** Agents act on behalf of users. Their transactions shouldn't expose the user's activity graph.

ZeroK solves this: deposit SOL, then send to any address privately. No link between deposit and payment.

## Quick Start

```bash
npm install @solana/web3.js
# Clone the SDK from this repo
git clone https://github.com/svhq/zerok-app.git
```

```javascript
const { Keypair } = require('@solana/web3.js');
const { ZeroK } = require('./zerok-app/sdk/agent');

// 1. Initialize (one line)
const zk = new ZeroK({
  network: 'mainnet-beta',
  wallet: Keypair.fromSecretKey(/* your agent's keypair */),
});

// 2. Deposit SOL into private pool
await zk.deposit(2.3);
// -> Splits into: 2x1 SOL + 3x0.1 SOL = 5 private notes

// 3. Send privately
await zk.send(1.0, 'RecipientWalletAddress...');
// -> ZK proof generated, relay submits tx, recipient gets 0.997 SOL

// 4. Check balance
const bal = zk.balance();
// -> { total: 1.3, notes: 4, breakdown: { '1 SOL': 1, '0.1 SOL': 3 } }
```

That's it. Three methods.

## API Reference

### `new ZeroK(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `network` | string | `'mainnet-beta'` | `'mainnet-beta'` or `'devnet'` |
| `wallet` | Keypair | required | Solana Keypair (agent's wallet) |
| `rpc` | string | auto | Custom RPC endpoint |
| `relay` | string | auto | Custom relay endpoint |

### `zk.deposit(solAmount)`

Deposit SOL into private pools. Automatically splits into optimal denominations.

- **Input:** `solAmount` (number) — amount in SOL (min 0.1, multiples of 0.1)
- **Returns:** `{ notes, denominations, txSignatures }`
- **Denominations:** 0.1, 1, 10, 100, 1000 SOL

### `zk.send(solAmount, recipient)`

Send SOL privately. Auto-selects notes, generates ZK proof, submits via relay.

- **Input:** `solAmount` (number), `recipient` (string or PublicKey)
- **Returns:** `{ sent, fee, txSignatures }`
- **Fee:** 0.3% (min 0.002 SOL) — deducted from sent amount
- **Privacy:** Recipient cannot see sender's wallet. On-chain observer cannot link deposit to withdrawal.

### `zk.balance()`

Check available private balance.

- **Returns:** `{ total, notes, breakdown }`
- **Note:** Balance is local to this SDK instance. Notes are also recoverable from on-chain memos using the wallet's signature.

### `zk.address()`

Get the agent's wallet public key.

- **Returns:** string (base58)

## How It Works Under the Hood

1. **Deposit:** SOL transfers to a pool vault PDA. A Poseidon commitment is inserted into an on-chain Merkle tree. The note secrets (nullifier + secret) are encrypted with the wallet's signature and stored as a transaction memo.

2. **Send:** The SDK generates a Groth16 zero-knowledge proof locally (no external calls). The proof demonstrates the agent owns a valid note without revealing which one. A protocol relay submits the withdrawal transaction — the recipient's wallet never needs SOL for gas.

3. **Privacy guarantee:** The ZK proof verifies membership in the Merkle tree without revealing the leaf. The nullifier prevents double-spending. The relay pays gas fees, so the recipient wallet has no prior transaction history linking it to the sender.

## Denominations

Deposits are split into fixed denominations for privacy (same-sized deposits are indistinguishable):

| Pool | Denomination | Fee (0.3%) | Min Fee |
|------|-------------|-----------|--------|
| 0.1 SOL | 100,000,000 lamports | 0.0003 SOL | 0.002 SOL |
| 1 SOL | 1,000,000,000 lamports | 0.003 SOL | 0.002 SOL |
| 10 SOL | 10,000,000,000 lamports | 0.03 SOL | 0.002 SOL |
| 100 SOL | 100,000,000,000 lamports | 0.3 SOL | 0.002 SOL |
| 1000 SOL | 1,000,000,000,000 lamports | 3.0 SOL | 0.002 SOL |

## Example: Agent Payment Service

```javascript
const { Keypair } = require('@solana/web3.js');
const { ZeroK } = require('./zerok-app/sdk/agent');

class PrivatePaymentAgent {
  constructor(keypairBytes) {
    this.zk = new ZeroK({
      network: 'mainnet-beta',
      wallet: Keypair.fromSecretKey(Uint8Array.from(keypairBytes)),
    });
  }

  async fundAgent(solAmount) {
    console.log(`Depositing ${solAmount} SOL into private pool...`);
    const result = await this.zk.deposit(solAmount);
    console.log(`Created ${result.notes} private notes`);
  }

  async payService(serviceWallet, amount) {
    console.log(`Paying ${amount} SOL to ${serviceWallet} privately...`);
    const result = await this.zk.send(amount, serviceWallet);
    console.log(`Sent! Fee: ${result.fee} SOL`);
    return result.txSignatures[0];
  }

  getBalance() {
    return this.zk.balance();
  }
}

// Usage
const agent = new PrivatePaymentAgent(myKeypairBytes);
await agent.fundAgent(5.0);                              // deposit 5 SOL
await agent.payService('ComputeProvider...', 1.0);       // private payment
await agent.payService('DataVendor...', 0.5);            // another private payment
console.log(agent.getBalance());                         // check remaining
```

## Security Notes

- **Non-custodial:** Your agent's wallet key never leaves your system. The protocol cannot access your funds.
- **Note safety:** Notes are encrypted and stored on-chain via memos. If your SDK instance is destroyed, notes can be recovered from the blockchain using the same wallet.
- **Protocol fee:** 0.3% per withdrawal (min 0.002 SOL). The relay pays all network gas fees.
- **Open source circuits:** The ZK circuits are [open source](../circuits/v2/) — the math is verifiable.

## Links

- [Application](https://app.zerok.app)
- [Devnet](https://devnet.zerok.app)
- [Documentation](https://docs.zerok.app)
- [GitHub](https://github.com/svhq/zerok-app)
- [Twitter](https://twitter.com/zerokprotocol)
