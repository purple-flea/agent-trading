import { Hono } from "hono";
import { randomBytes } from "crypto";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq, sql } from "drizzle-orm";
import { hashApiKey, agentAuth } from "../middleware/auth.js";
import type { AppEnv } from "../types.js";

const app = new Hono<AppEnv>();

app.post("/register", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const referralCode = body.referral_code as string | undefined;
  const walletAgentId = body.wallet_agent_id as string | undefined;

  const agentId = `ag_${randomBytes(6).toString("hex")}`;
  const apiKey = `sk_trade_${randomBytes(24).toString("hex")}`;
  const keyHash = hashApiKey(apiKey);
  const myReferralCode = `ref_${randomBytes(4).toString("hex")}`;

  let referrerId: string | null = null;
  if (referralCode) {
    const referrer = db.select().from(schema.agents)
      .where(eq(schema.agents.referralCode, referralCode)).get();
    if (referrer) referrerId = referrer.id;
  }

  db.insert(schema.agents).values({
    id: agentId, apiKeyHash: keyHash, referralCode: myReferralCode,
    referredBy: referrerId, walletAgentId: walletAgentId ?? null,
  }).run();

  return c.json({
    agent_id: agentId,
    api_key: apiKey,
    referral_code: myReferralCode,
    tier: "free",
    fee_structure: {
      free: "Hyperliquid fee + 2 bps (0.02%)",
      pro: "Hyperliquid fee + 1 bp (0.01%) — $50k+ monthly volume",
      whale: "Hyperliquid fee only (0 markup) — $500k+ monthly volume",
    },
    referral_commission: "20% of our fee markup from referred agents",
    message: "Store your API key securely — it cannot be recovered.",
    next_steps: [
      "GET /v1/markets — browse 229+ perpetual markets",
      "GET /v1/markets/:coin/price — get current price",
      "POST /v1/trade/open — open a position",
      "GET /v1/positions — view your positions",
    ],
  }, 201);
});

app.get("/account", agentAuth, (c) => {
  const agent = c.get("agent") as typeof schema.agents.$inferSelect;
  return c.json({
    agent_id: agent.id,
    tier: agent.tier,
    max_leverage: agent.maxLeverage,
    max_position_usd: agent.maxPositionUsd,
    total_volume: agent.totalVolume,
    total_fees_paid: agent.totalFeesPaid,
    total_pnl: agent.totalPnl,
    referral_code: agent.referralCode,
  });
});

export default app;
