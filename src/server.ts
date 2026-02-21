import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";
import { runMigrations } from "./db/index.js";
import authRoutes from "./routes/auth.js";
import marketsRoutes from "./routes/markets.js";
import tradeRoutes from "./routes/trade.js";

runMigrations();

const app = new Hono();
app.use("*", cors());
app.use("*", logger());

app.use("/llms.txt", serveStatic({ path: "public/llms.txt" }));
app.use("/llms-full.txt", serveStatic({ path: "public/llms-full.txt" }));
app.use("/.well-known/llms.txt", serveStatic({ path: "public/llms.txt" }));

app.get("/health", (c) => c.json({ status: "ok", service: "agent-trading", version: "3.0.0", execution: "real" }));

app.get("/", (c) => c.json({
  service: "Purple Flea Agent Trading",
  version: "3.0.0",
  tagline: "REAL execution on Hyperliquid. Trade TSLA, NVDA, GOLD, SILVER, BTC and 275+ markets. Built for AI agents.",
  execution: "real — orders execute directly on Hyperliquid via your wallet",
  total_markets: "275+",
  categories: {
    stocks: "TSLA, NVDA, GOOGL, AAPL, AMZN, META, MSFT, NFLX, AMD, PLTR, COIN, GME + more",
    commodities: "GOLD, SILVER, COPPER, PLATINUM, PALLADIUM, URANIUM, Crude Oil, Natural Gas",
    indices: "XYZ100, JP225, KR200, DXY, SPX",
    forex: "JPY (50x), EUR (50x)",
    crypto: "229 perpetual contracts (BTC, ETH, SOL, XRP, DOGE + 224 more)",
  },
  powered_by: "Hyperliquid + XYZ Protocol (HIP-3)",
  onboarding: "Sign up at https://app.hyperliquid.xyz/join/PF — deposit USDC — register with your wallet",
  docs: "/v1/docs",
  llms: "/llms.txt",
  for_ai_agents: true,
}));

const v1 = new Hono();
v1.route("/auth", authRoutes);
v1.route("/markets", marketsRoutes);
v1.route("/trade", tradeRoutes);

v1.get("/docs", (c) => c.json({
  version: "3.0.0 — Real Hyperliquid Execution",
  auth: {
    "POST /v1/auth/register": "Create account { hl_wallet_address, hl_signing_key, referral_code? }",
    "GET /v1/auth/account": "Account info, tier, wallet status",
  },
  markets: {
    "GET /v1/markets": "All 275+ markets with live prices (crypto + stocks + commodities + forex)",
    "GET /v1/markets/stocks": "Equity perps — TSLA, NVDA, GOOGL, AAPL, META, MSFT...",
    "GET /v1/markets/commodities": "GOLD, SILVER, COPPER, PLATINUM, Oil, Gas, Uranium",
    "GET /v1/markets/rwa": "All real-world asset perps (stocks + commodities + indices + forex)",
    "GET /v1/markets/:coin": "Single market details + fee examples",
    "GET /v1/markets/:coin/price": "Current price",
  },
  trading: {
    "POST /v1/trade/open": "Open REAL position { coin: 'TSLA', side: 'long', size_usd: 1000, leverage: 5 }",
    "POST /v1/trade/close": "Close REAL position { position_id }",
    "GET /v1/trade/positions": "Real positions from Hyperliquid clearinghouse",
    "GET /v1/trade/history": "Trade history",
  },
  setup: {
    step_1: "Sign up at https://app.hyperliquid.xyz/join/PF",
    step_2: "Deposit USDC to your Hyperliquid account",
    step_3: "Create API Agent Wallet in HL settings",
    step_4: "POST /v1/auth/register with hl_wallet_address + hl_signing_key",
  },
  examples: {
    long_tesla: { coin: "TSLA", side: "long", size_usd: 1000, leverage: 5 },
    short_gold: { coin: "GOLD", side: "short", size_usd: 500, leverage: 10 },
    long_btc: { coin: "BTC", side: "long", size_usd: 5000, leverage: 3 },
    hedge_nasdaq: { coin: "XYZ100", side: "short", size_usd: 2000, leverage: 10 },
  },
}));

app.route("/v1", v1);

const port = parseInt(process.env.PORT || "3003", 10);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Agent Trading v2 running on http://localhost:${info.port}`);
});

export default app;
