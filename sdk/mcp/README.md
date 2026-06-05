# zerok-mcp

An **MCP server** that gives any MCP-capable AI agent — Claude Desktop, Claude Code, Cursor, or your own — **private, gasless SOL payments** on Solana. The agent just decides amounts and recipients; all the zero-knowledge proving, note management, and relay communication is hidden, exactly like a person using the web app.

> This is a *primitive other agents plug into*, not an agent itself. Connect it to whatever AI agent or tool you already use.

## Tools exposed

| Tool | Input | What it does |
|---|---|---|
| `zerok_address` | — | Your wallet's public key (where deposits are funded from) |
| `zerok_balance` | — | Your shielded (private) balance + note breakdown |
| `zerok_deposit` | `amount_sol`, `idempotency_key?` | Shield SOL into the privacy pools (multiple of 0.1; auto-split) |
| `zerok_send` | `amount_sol`, `recipient`, `idempotency_key?` | Send SOL **privately and gasless** — recipient needs no SOL, never sees you |
| `zerok_recover` | — | Rebuild your private notes from on-chain — reattach to your balance on a new machine or after a restart (same wallet → same funds) |

## Setup

Nothing to clone — it's on npm. You only need a Solana keypair JSON with some SOL (the deposit source). The **recipient needs nothing** — the relay pays gas.

## Connect it to your agent

The keypair stays on your machine; the server reads it locally and never transmits it.

### Claude Desktop — `claude_desktop_config.json`
```json
{
  "mcpServers": {
    "zerok": {
      "command": "npx",
      "args": ["-y", "zerok-mcp"],
      "env": {
        "SOLANA_KEYPAIR": "/home/you/.config/solana/id.json",
        "ZEROK_NETWORK": "mainnet-beta"
      }
    }
  }
}
```

### Claude Code — `.mcp.json` (project) or `claude mcp add`
```bash
claude mcp add zerok -e SOLANA_KEYPAIR=~/.config/solana/id.json -e ZEROK_NETWORK=mainnet-beta -- npx -y zerok-mcp
```

### Any MCP client
Run `npx -y zerok-mcp` over **stdio** with the env vars below. The server speaks standard MCP.

## Configuration (env)

| Var | Required | Default |
|---|---|---|
| `SOLANA_KEYPAIR` | ✅ | — (path to keypair JSON, `~` allowed) |
| `ZEROK_NETWORK` | | `mainnet-beta` (or `devnet`) |
| `ZEROK_RPC` | | network default (public mainnet RPC) |
| `ZEROK_RELAY` | | network default (ZeroK mainnet relay) |
| `ZEROK_NOTES_DIR` | | `./.zerok/<pubkey8>` — where notes persist |

## Once connected, just ask your agent

> "Shield 1 SOL with ZeroK, then send 0.3 privately to `<address>`."

The agent calls `zerok_deposit(1)` then `zerok_send(0.3, <address>)`. Notes persist to disk automatically, so the agent never loses access across restarts.

## Live protocol

- Program: `HVcTokFF4rwvcU7sC7GjS317CSf7QDgfCvW7edijKS2v` (Solana mainnet)
- Pools: 0.1 / 1 / 10 / 100 / 1000 SOL · 0.3% fee (min 0.002 SOL) · gasless via relay
- Docs: https://docs.zerok.app/agents

GPL-3.0.
