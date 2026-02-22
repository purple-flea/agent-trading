import { Hono } from "hono";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq, sql } from "drizzle-orm";
import { agentAuth } from "../middleware/auth.js";
import type { AppEnv } from "../types.js";

const app = new Hono<AppEnv>();

app.use("/*", agentAuth);

app.get("/code", (c) => {
  const agent = c.get("agent") as typeof schema.agents.$inferSelect;
  return c.json({
    referral_code: agent.referralCode,
    commission_rate: "20% of fee markup from referred agents trades",
    share_message: "Sign up at api.purpleflea.com/v1/trading with referral_code: " + agent.referralCode,
  });
});

app.get("/stats", (c) => {
  const agentId = c.get("agentId") as string;
  
  const earnings = db
    .select()
    .from(schema.referralEarnings)
    .where(eq(schema.referralEarnings.referrerId, agentId))
    .all();

  const totalEarned = earnings.reduce((sum, e) => sum + e.commissionAmount, 0);
  const totalFees = earnings.reduce((sum, e) => sum + e.feeAmount, 0);

  // Count unique referred agents
  const uniqueReferred = new Set(earnings.map(e => e.referredId)).size;

  return c.json({
    total_referrals: uniqueReferred,
    total_fees_generated_usd: Math.round(totalFees * 100) / 100,
    total_earned_usd: Math.round(totalEarned * 100) / 100,
    commission_rate: "20%",
    recent_earnings: earnings.slice(-20).map(e => ({
      from_agent: e.referredId,
      fee: Math.round(e.feeAmount * 10000) / 10000,
      commission: Math.round(e.commissionAmount * 10000) / 10000,
      order: e.orderId,
      at: new Date(e.createdAt * 1000).toISOString(),
    })),
  });
});

export default app;
