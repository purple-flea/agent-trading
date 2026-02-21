# Agent Trading

[![npm version](https://img.shields.io/npm/v/@purpleflea/trading-mcp.svg)](https://www.npmjs.com/package/@purpleflea/trading-mcp)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue.svg)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Hyperliquid](https://img.shields.io/badge/Powered%20by-Hyperliquid-green.svg)](https://hyperliquid.xyz)

**Trade 275+ perpetual futures markets from your AI agent.** Stocks, commodities, crypto, forex, and indices — all through a single MCP server. Blue chip infrastructure for AI agents by [Purple Flea](https://purpleflea.com).

---

## Why Agent Trading?

| Feature | Details |
|---------|---------|
| **275+ Markets** | TSLA, NVDA, AAPL, GOOGL, GOLD, SILVER, BTC, ETH, SPX, EUR, and more |
| **Real-World Assets** | Stocks & commodities via Hyperliquid HIP-3 — trade 24/7, no market hours |
| **Up to 50x Leverage** | Per-market leverage limits with liquidation protection |
| **Institutional Liquidity** | Hyperliquid DEX — as liquid as Binance, fully on-chain |
| **Transparent Fees** | HL base fee + 2 bps. Pro/Whale tiers reduce to 0 markup |
| **Referral System** | Agents earn **20% commission** on fees from referred traders |
| **MCP Native** | Drop into Claude, GPT, or any MCP-compatible agent |

## Quick Start

### As an MCP Server (Claude Desktop / Claude Code)

```bash
npx @purpleflea/trading-mcp
```

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "trading": {
      "command": "npx",
      "args": ["-y", "@purpleflea/trading-mcp"],
      "env": {
        "TRADING_API_KEY": "sk_trade_your_key_here"
      }
    }
  }
}
```

### As a REST API

```bash
git clone https://github.com/purple-flea/agent-trading.git
cd agent-trading
npm install
npm run dev
```

## Available MCP Tools

| Tool | Description |
|------|-------------|
| `trading_list_markets` | Browse all 275+ markets by category (stocks, commodities, crypto, forex, indices, rwa) |
| `trading_get_price` | Get live price for any market — TSLA, GOLD, BTC, etc. |
| `trading_market_info` | Detailed market info: leverage, fees, trade examples |
| `trading_open_position` | Open a leveraged long/short position on any market |
| `trading_close_position` | Close a position and realize P&L |
| `trading_get_positions` | View open positions with live unrealized P&L |
| `trading_history` | Full trade history with prices, fees, realized P&L |
| `trading_account` | Account details, tier, volume, referral code |
| `trading_register` | Create a new trading account |

## Markets

### Stocks (29 equities via HIP-3)
TSLA, NVDA, GOOGL, AAPL, AMZN, META, MSFT, NFLX, AMD, PLTR, COIN, MSTR, HOOD, INTC, MU, ORCL, COST, LLY, TSM, RIVN, BABA, GME, and more.

### Commodities (9 markets)
GOLD, SILVER, COPPER, PLATINUM, PALLADIUM, URANIUM, ALUMINIUM, CL (crude oil), NATGAS

### Indices
SPX, JP225, KR200, DXY, XYZ100, USAR, URNM

### Forex
EUR, JPY — up to 50x leverage

### Crypto (229 perpetuals)
BTC, ETH, SOL, XRP, DOGE, AVAX, LINK, and 222 more with up to 50x leverage.

## Example: Open a Position

```
You: "Go long $1000 on TSLA with 5x leverage"

Agent calls trading_open_position:
  coin: "TSLA"
  side: "long"
  size_usd: 1000
  leverage: 5

Response:
  position_id: "pos_a1b2c3d4"
  entry_price: 248.50
  margin_used: 200.00
  liquidation_price: 199.28
  fee: 0.55
  status: "open"
```

## Fee Tiers

| Tier | Our Markup | Qualification |
|------|-----------|---------------|
| Free | +2 bps (0.02%) | Default |
| Pro | +1 bp (0.01%) | $50k+ monthly volume |
| Whale | 0 (HL fee only) | $500k+ monthly volume |

All tiers pay the Hyperliquid base fee (3.5 bps). Our markup sits on top.

## Referral Program

Agents earn **20% commission** on Purple Flea's fee markup from every trade made by referred agents. Share your `referral_code` from `trading_register` or `trading_account`.

- Referred agent signs up with your code
- They trade normally
- You earn 20% of our fee on every trade they make
- Commissions accumulate automatically

## Architecture

- **Runtime**: Node.js + TypeScript
- **Framework**: Hono (REST API)
- **Database**: SQLite + Drizzle ORM
- **Price Feed**: Hyperliquid DEX (main) + XYZ Protocol (HIP-3 RWAs)
- **Protocol**: MCP (Model Context Protocol) over stdio

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TRADING_API_URL` | Trading API base URL | `https://trading.purpleflea.com` |
| `TRADING_API_KEY` | Your API key (from `trading_register`) | — |
| `PORT` | REST API port | `3003` |

## Part of the Purple Flea Ecosystem

Purple Flea builds blue chip infrastructure for AI agents:

- **[Agent Trading](https://github.com/purple-flea/agent-trading)** — 275+ perpetual futures markets (you are here)
- **[Agent Casino](https://github.com/purple-flea/agent-casino)** — Provably fair gambling, 0.5% house edge
- **[Burner Identity](https://github.com/purple-flea/burner-identity)** — Disposable emails & phone numbers

All services support crypto deposits via any chain/token. Swaps powered by [Wagyu.xyz](https://wagyu.xyz) — aggregator of aggregators, best rates guaranteed, routes through Hyperliquid (as liquid as Binance, even for XMR).

## License

MIT
