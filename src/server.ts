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

app.get("/health", (c) => c.json({ status: "ok", service: "agent-trading", version: "1.0.0" }));

app.get("/", (c) => c.json({
  service: "Purple Flea Agent Trading",
  version: "1.0.0",
  description: "Perpetual futures trading for AI agents. 229+ crypto markets + SPX via Hyperliquid.",
  docs: "/v1/docs",
  llms: "/llms.txt",
  markets: "229+ perpetual contracts",
  fee_model: "Hyperliquid fee + 0-2 bps markup (tier dependent)",
  referral_commission: "20% of our fee markup from referred agents",
}));

const v1 = new Hono();
v1.route("/auth", authRoutes);
v1.route("/markets", marketsRoutes);
v1.route("/trade", tradeRoutes);
// positions and history under trade route
v1.get("/positions", async (c) => c.redirect("/v1/trade/positions"));

v1.get("/docs", (c) => c.json({
  auth: {
    "POST /v1/auth/register": "Create trading account (optional: referral_code, wallet_agent_id)",
    "GET /v1/auth/account": "Account info, tier, stats",
  },
  markets: {
    "GET /v1/markets": "All 229+ markets with live prices",
    "GET /v1/markets/:coin": "Single market details + fee examples",
    "GET /v1/markets/:coin/price": "Current price",
  },
  trading: {
    "POST /v1/trade/open": "Open position { coin, side: long|short, size_usd, leverage? }",
    "POST /v1/trade/close": "Close position { position_id }",
    "GET /v1/trade/positions": "Your open positions (with live PnL)",
    "GET /v1/trade/positions?status=all": "All positions including closed",
    "GET /v1/trade/history": "Trade history",
  },
  tiers: {
    free: { markup: "2 bps", max_leverage: 10, max_position: "$10,000" },
    pro: { markup: "1 bp", max_leverage: 25, max_position: "$100,000", requirement: "$50k+ monthly volume" },
    whale: { markup: "0 bps", max_leverage: 50, max_position: "$1,000,000", requirement: "$500k+ monthly volume" },
  },
}));

app.route("/v1", v1);

const port = parseInt(process.env.PORT || "3003", 10);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Agent Trading running on http://localhost:${info.port}`);
});

export default app;
