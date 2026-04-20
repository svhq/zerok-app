# ZeroK — Colosseum Frontier 2026

**ZeroK** is a privacy-preserving protocol on Solana. Users deposit SOL into shielded pools, then withdraw to any address with a zero-knowledge proof — breaking the on-chain link between sender and recipient. Fully non-custodial, protocol-powered gas, wallet-derived recovery. Live on mainnet.

**Program**: [`HVcTokFF4rwvcU7sC7GjS317CSf7QDgfCvW7edijKS2v`](https://solscan.io/account/HVcTokFF4rwvcU7sC7GjS317CSf7QDgfCvW7edijKS2v)
**App**: [app.zerok.app](https://app.zerok.app)
**Docs**: [docs.zerok.app](https://docs.zerok.app)

---

## Frontier Progress

### Week 1 — Solving Phantom Lighthouse & Blowfish Warnings

Phantom wallet's Blowfish security scanner blocked ZeroK deposits on mainnet. We redesigned the state architecture from a monolithic 131KB account to a sharded 8.9KB design, and changed the transaction signing pattern to avoid batch-signing warnings.

**Details**: [WEEKLY_UPDATES/week1.md](WEEKLY_UPDATES/week1.md)

### Week 2 — UX Optimization: Any-Amount Deposits & Wallet-as-Recovery-Key

Users type any amount — `2.3 SOL` — and the app greedy-splits it into privacy units, packs everything into one wallet popup. Meanwhile, a three-layer recovery system (local cache + on-chain encrypted memos + optional file backup) makes your wallet the recovery key: no file management, no anxiety. JoinSplit circuits published for the arbitrary-amount withdrawal roadmap.

**Details**: [WEEKLY_UPDATES/week2.md](WEEKLY_UPDATES/week2.md)

### Week 3 — _Coming soon_

### Week 4 — _Coming soon_

---

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for a full technical overview of how ZeroK works, including the V3 sharded root ring design that solves the Lighthouse problem.

## Running Locally

```bash
# Frontend
cd web && npm install && npm run dev

# Circuits (proof generation artifacts)
cd circuits && npm install
```

The app connects to mainnet by default. Visit `localhost:3000` to use the app with your Solana wallet.
