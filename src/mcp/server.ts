#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = process.env.TRADING_API_URL || "https://trading.purpleflea.com";
const API_KEY = process.env.TRADING_API_KEY || "";

async function api(method: string, path: string, body?: unknown) {
  const url = `${BASE_URL}/v1${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (API_KEY) {
    headers["Authorization"] = `Bearer ${API_KEY}`;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  return res.json();
}

const server = new McpServer({
  name: "agent-trading",
  version: "2.0.0",
});

// ─── trading_list_markets ───

server.tool(
  "trading_list_markets",
  "List all 275+ tradeable perpetual markets across stocks (TSLA, NVDA, AAPL, GOOGL, META), commodities (GOLD, SILVER, OIL, URANIUM), indices (SPX, JP225), forex (EUR, JPY), and 229 crypto pairs. Powered by Hyperliquid HIP-3. Trade real-world assets 24/7 with leverage.",
  {
    category: z
      .enum(["all", "stocks", "commodities", "indices", "forex", "crypto", "rwa"])
      .optional()
      .default("all")
      .describe("Filter by asset category. 'rwa' returns all non-crypto (stocks + commodities + indices + forex)."),
  },
  async ({ category }) => {
    const path = category === "all"
      ? "/markets"
      : category === "rwa"
        ? "/markets/rwa"
        : `/markets/${category}`;
    const result = await api("GET", path);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── trading_get_price ───

server.tool(
  "trading_get_price",
  "Get the current live price for any market. Supports stocks (TSLA, NVDA), commodities (GOLD, SILVER), crypto (BTC, ETH, SOL), and more. Prices sourced from Hyperliquid DEX in real-time.",
  {
    coin: z
      .string()
      .describe("Market ticker — e.g. TSLA, NVDA, GOLD, SILVER, BTC, ETH, SOL, XRP. Case-insensitive."),
  },
  async ({ coin }) => {
    const result = await api("GET", `/markets/${encodeURIComponent(coin.toUpperCase())}/price`);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      isError: "error" in result,
    };
  },
);

// ─── trading_market_info ───

server.tool(
  "trading_market_info",
  "Get detailed info for a specific market including price, max leverage, fee structure, and trade examples. Works for any of the 275+ markets.",
  {
    coin: z
      .string()
      .describe("Market ticker — e.g. TSLA, GOLD, BTC. Case-insensitive."),
  },
  async ({ coin }) => {
    const result = await api("GET", `/markets/${encodeURIComponent(coin.toUpperCase())}`);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      isError: "error" in result,
    };
  },
);

// ─── trading_open_position ───

server.tool(
  "trading_open_position",
  "Open a leveraged long or short position on any of 275+ markets. Supports stocks (TSLA 5x), commodities (GOLD 10x), crypto (BTC 50x). Fees: Hyperliquid base + 2 bps. Referral agents earn 20% commission on fees from referred traders.",
  {
    coin: z
      .string()
      .describe("Market ticker — e.g. TSLA, NVDA, GOLD, SILVER, BTC, ETH, SOL"),
    side: z
      .enum(["long", "short"])
      .describe("Position direction. 'long' profits when price goes up, 'short' profits when price goes down."),
    size_usd: z
      .number()
      .positive()
      .describe("Position size in USD. Example: 1000 = $1,000 notional exposure."),
    leverage: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .default(5)
      .describe("Leverage multiplier (1-50x depending on market). Default 5x. Higher leverage = higher risk."),
  },
  async ({ coin, side, size_usd, leverage }) => {
    const result = await api("POST", "/trade/open", { coin, side, size_usd, leverage });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      isError: "error" in result,
    };
  },
);

// ─── trading_close_position ───

server.tool(
  "trading_close_position",
  "Close an open position and realize profit/loss. Returns entry price, exit price, P&L in USD and percentage, and fees paid.",
  {
    position_id: z
      .string()
      .describe("The position ID to close (from trading_open_position or trading_get_positions)."),
  },
  async ({ position_id }) => {
    const result = await api("POST", "/trade/close", { position_id });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      isError: "error" in result,
    };
  },
);

// ─── trading_get_positions ───

server.tool(
  "trading_get_positions",
  "View all your open trading positions with live prices and unrealized P&L. Optionally include closed/liquidated positions.",
  {
    status: z
      .enum(["open", "all"])
      .optional()
      .default("open")
      .describe("'open' for active positions only (default), 'all' for full history including closed."),
  },
  async ({ status }) => {
    const path = status === "all" ? "/trade/positions?status=all" : "/trade/positions";
    const result = await api("GET", path);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── trading_history ───

server.tool(
  "trading_history",
  "View your complete trade history — every order fill with prices, fees, and realized P&L.",
  {
    limit: z
      .number()
      .min(1)
      .max(200)
      .optional()
      .default(50)
      .describe("Number of trades to return (default 50, max 200)."),
  },
  async ({ limit }) => {
    const result = await api("GET", `/trade/history?limit=${limit}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── trading_account ───

server.tool(
  "trading_account",
  "View your trading account details: tier, leverage limits, total volume, fees paid, P&L, and referral code. Agents earn 20% commission on fees from referred traders.",
  {},
  async () => {
    const result = await api("GET", "/auth/account");
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      isError: "error" in result,
    };
  },
);

// ─── trading_register ───

server.tool(
  "trading_register",
  "Create a new trading account. Returns API key for authenticated trading. Optional: provide a referral code to link to a referring agent (they earn 20% commission on your fees, you get priority support).",
  {
    referral_code: z
      .string()
      .optional()
      .describe("Referral code from another agent. The referrer earns 20% commission on your trading fees."),
    wallet_agent_id: z
      .string()
      .optional()
      .describe("Link to an existing wallet/casino agent ID for unified identity."),
  },
  async ({ referral_code, wallet_agent_id }) => {
    const result = await api("POST", "/auth/register", { referral_code, wallet_agent_id });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── Start ───
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
