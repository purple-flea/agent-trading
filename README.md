# Agent Trading

[![npm version](https://img.shields.io/npm/v/@purpleflea/trading-mcp.svg)](https://www.npmjs.com/package/@purpleflea/trading-mcp)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue.svg)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Hyperliquid](https://img.shields.io/badge/Powered%20by-Hyperliquid-green.svg)](https://hyperliquid.xyz)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.18808440.svg)](https://doi.org/10.5281/zenodo.18808440)

**Trade 275+ perpetual futures markets from your AI agent.** Stocks, commodities, crypto, forex, and indices — real execution on Hyperliquid with up to 50x leverage.

---

## Quick Start

Register, check a price, and open a position:

```bash
# 1. Register (provide your Hyperliquid wallet + signing key)
curl -s -X POST https://trading.purpleflea.com/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "hl_wallet_address": "0xYourHyperliquidWallet",
    "hl_signing_key": "0xYourSigningKey"
  }' | jq

# 2. Check TSLA price
curl -s https://trading.purpleflea.com/v1/markets/TSLA/price \
  -H "Authorization: Bearer YOUR_API_KEY" | jq

# 3. Go long $1,000 TSLA with 5x leverage
curl -s -X POST https://trading.purpleflea.com/v1/trade/open \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"coin": "TSLA", "side": "long", "size_usd": 1000, "leverage": 5}' | jq
```

**Prerequisites:** Create a Hyperliquid account at [app.hyperliquid.xyz/join/PF](https://app.hyperliquid.xyz/join/PF), deposit USDC, and create an API Agent Wallet in settings.

## Markets

275+ perpetual futures across 5 categories. All markets trade 24/7 with on-chain settlement.

### Stocks (29 equities via HIP-3)

TSLA, NVDA, GOOGL, AAPL, AMZN, META, MSFT, NFLX, AMD, PLTR, COIN, MSTR, HOOD, INTC, MU, ORCL, COST, LLY, TSM, RIVN, BABA, GME, and more.

Trade stocks as perpetual futures — no market hours, no settlement delays, up to 5x leverage.

### Commodities (9 markets)

GOLD, SILVER, COPPER, PLATINUM, PALLADIUM, URANIUM, ALUMINIUM, CL (crude oil), NATGAS

### Indices (7 markets)

SPX (S&P 500), JP225 (Nikkei), KR200, DXY (Dollar Index), XYZ100, USAR, URNM

### Forex (2 markets)

EUR, JPY — up to 50x leverage

### Crypto (229 perpetuals)

BTC, ETH, SOL, XRP, DOGE, AVAX, LINK, and 222 more on Hyperliquid's main DEX with up to 50x leverage and institutional-grade liquidity.

## API Reference

Base URL: `https://trading.purpleflea.com/v1`

Auth: `Authorization: Bearer sk_trade_...` (all endpoints except register)

### Auth & Account

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/auth/register` | Create account. Params: `hl_wallet_address`, `hl_signing_key`, `referral_code?`, `wallet_agent_id?` |
| `GET` | `/auth/account` | Account details, tier, volume, P&L, referral code |

### Markets

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/markets` | All 275+ markets with categories and fee tiers |
| `GET` | `/markets/stocks` | All 29 equity perpetuals with prices |
| `GET` | `/markets/commodities` | All 9 commodity markets |
| `GET` | `/markets/rwa` | All 47 real-world assets (stocks + commodities + indices + forex) |
| `GET` | `/markets/:coin` | Detailed market info — max leverage, category, fees, trade examples |
| `GET` | `/markets/:coin/price` | Live price for any market |

### Trading

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/trade/open` | Open a position. Params: `coin`, `side` (long/short), `size_usd`, `leverage?` (default 5) |
| `POST` | `/trade/close` | Close a position. Params: `position_id` |
| `GET` | `/trade/positions` | Open positions with live unrealized P&L (fetched from Hyperliquid) |
| `GET` | `/trade/history` | Trade history with prices, fees, realized P&L. `limit?` (default 50, max 200) |

### Referrals

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/referral/code` | Your referral code and commission rate |
| `GET` | `/referral/stats` | Total referrals, fees generated, earnings |

## Fee Structure

All tiers pay the Hyperliquid base fee (3.5 bps). Purple Flea's markup sits on top:

| Tier | Our Markup | Total Fee | Max Leverage | Max Position | Qualification |
|------|-----------|-----------|--------------|-------------|---------------|
| **Free** | +2 bps | 5.5 bps (0.055%) | 10x | $10,000 | Default |
| **Pro** | +1 bp | 4.5 bps (0.045%) | 25x | $100,000 | $50k+ monthly volume |
| **Whale** | 0 bps | 3.5 bps (0.035%) | 50x | $1,000,000 | $500k+ monthly volume |

**Example on a $1,000 trade:**

| Tier | Hyperliquid Fee | Purple Flea Markup | Total |
|------|-----------------|-------------------|-------|
| Free | $0.35 | $0.20 | $0.55 |
| Pro | $0.35 | $0.10 | $0.45 |
| Whale | $0.35 | $0 | $0.35 |

## Referral System

Earn **20% of Purple Flea's fee markup** on every trade made by agents you refer.

```bash
# 1. Get your referral code
curl -s https://trading.purpleflea.com/v1/referral/code \
  -H "Authorization: Bearer YOUR_API_KEY" | jq '.referral_code'
# → "ref_1a2b3c4d"

# 2. Referred agent signs up with your code
curl -s -X POST https://trading.purpleflea.com/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "hl_wallet_address": "0xTheirWallet",
    "hl_signing_key": "0xTheirKey",
    "referral_code": "ref_1a2b3c4d"
  }' | jq

# 3. They trade, you earn. Check your stats:
curl -s https://trading.purpleflea.com/v1/referral/stats \
  -H "Authorization: Bearer YOUR_API_KEY" | jq
```

**Example:** A referred Free-tier agent trades $10,000 in volume. Purple Flea markup = $2.00. You earn 20% = $0.40. Commissions accumulate automatically.

## Hyperliquid Integration

Agent Trading executes real trades on [Hyperliquid](https://hyperliquid.xyz) — a fully on-chain perpetual futures DEX with institutional-grade liquidity.

**How it works:**

1. You provide your Hyperliquid wallet address and API signing key at registration
2. Your signing key is encrypted with AES-256-GCM at rest — decrypted in-memory only when signing orders
3. When you open a position, Agent Trading signs a market order with your key and submits it to Hyperliquid's exchange API
4. Orders execute on Hyperliquid's order book with 0.5% slippage protection
5. Positions are held on your Hyperliquid account — you can view them in the Hyperliquid UI too
6. Closing a position submits a reduce-only order to Hyperliquid

**Two DEXes, one API:**

- **Main DEX:** 229 crypto perpetuals (BTC, ETH, SOL, etc.)
- **XYZ DEX (HIP-3):** 47 real-world assets (TSLA, GOLD, SPX, EUR, etc.) — trade traditional assets 24/7 as perpetual futures

Purple Flea's builder fee is attached to each order. This is how the fee markup is collected — transparently on-chain.

## MCP Server

Use Agent Trading directly from Claude Desktop, Claude Code, or any MCP-compatible agent.

### Claude Desktop

Add to `~/.config/Claude/claude_desktop_config.json` (Linux) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

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

Then talk to Claude naturally:

```
You: "What's the price of TSLA?"
You: "Go long $500 on GOLD with 10x leverage"
You: "Show my open positions"
You: "Close position pos_a1b2c3d4"
```

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `trading_list_markets` | Browse all 275+ markets by category |
| `trading_get_price` | Live price for any market |
| `trading_market_info` | Detailed market info — leverage, fees, examples |
| `trading_open_position` | Open a leveraged long/short position |
| `trading_close_position` | Close a position and realize P&L |
| `trading_get_positions` | View open positions with live unrealized P&L |
| `trading_history` | Trade history with prices, fees, P&L |
| `trading_account` | Account details, tier, volume, referral code |
| `trading_register` | Create a new trading account |

## Self-Hosting

```bash
git clone https://github.com/purple-flea/agent-trading.git
cd agent-trading
npm install
npm run dev
# API available at http://localhost:3003
```

### Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled server |
| `npm run mcp` | Run MCP server in dev mode |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3003` | REST API port |
| `ENCRYPTION_KEY` | — | **Required for production.** Secret for AES-256-GCM encryption of signing keys |
| `TRADING_API_URL` | `https://trading.purpleflea.com` | Base URL (for MCP server) |
| `TRADING_API_KEY` | — | API key (for MCP server) |

### Tech Stack

- **Runtime:** Node.js + TypeScript
- **Framework:** [Hono](https://hono.dev)
- **Database:** SQLite + [Drizzle ORM](https://orm.drizzle.team)
- **Execution:** [Hyperliquid](https://hyperliquid.xyz) DEX (main) + XYZ Protocol (HIP-3 RWAs)
- **Protocol:** [MCP](https://modelcontextprotocol.io) over stdio

## Research

This project is referenced in:

> **"Purple Flea: A Multi-Agent Financial Infrastructure Protocol for Autonomous AI Systems"**
> [![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.18808440.svg)](https://doi.org/10.5281/zenodo.18808440)

## Part of the Purple Flea Ecosystem

Purple Flea builds infrastructure for AI agents:

- **[Agent Trading](https://github.com/purple-flea/agent-trading)** — 275+ perpetual futures markets via Hyperliquid (you are here)
- **[Agent Casino](https://github.com/purple-flea/agent-casino)** — Provably fair gambling, 0.5% house edge
- **[Crypto Data](https://github.com/purple-flea/crypto-mcp)** — 10,000+ cryptocurrency prices and market data
- **[Finance Data](https://github.com/purple-flea/finance-mcp)** — Stocks, forex, commodities, economic indicators
- **[Referral Tracker](https://github.com/purple-flea/referral-mcp)** — Cross-platform referral management

All services support crypto deposits on any chain. Swaps powered by [Wagyu.xyz](https://wagyu.xyz).

## License

MIT
