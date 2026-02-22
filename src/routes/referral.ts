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

app.post("/withdraw", async (c) => {
  const agentId = c.get("agentId") as string;
  const agent = c.get("agent") as typeof schema.agents.$inferSelect;
  const { address } = await c.req.json().catch(() => ({} as any));

  if (!address || !address.startsWith("0x") || address.length !== 42) {
    return c.json({ error: "invalid_address", suggestion: "Provide a valid Base/Ethereum address (0x...)" }, 400);
  }

  // Calculate total earned - total already withdrawn
  const earnings = db
    .select()
    .from(schema.referralEarnings)
    .where(eq(schema.referralEarnings.referrerId, agentId))
    .all();

  const totalEarned = earnings.reduce((sum, e) => sum + e.commissionAmount, 0);
  
  // Check withdrawals table for already withdrawn
  const withdrawn = db.select({ total: sql<number>`COALESCE(SUM(amount), 0)` })
    .from(schema.referralWithdrawals)
    .where(eq(schema.referralWithdrawals.referrerId, agentId))
    .get();
  
  const totalWithdrawn = withdrawn?.total ?? 0;
  const available = Math.round((totalEarned - totalWithdrawn) * 100) / 100;

  if (available < 1.00) {
    return c.json({
      error: "insufficient_balance",
      available_usd: available,
      minimum: 1.00,
      suggestion: "Minimum withdrawal is $1.00. Earn more by referring agents!",
    }, 400);
  }

  // Record withdrawal
  const withdrawalId = `rw_${Date.now().toString(36)}`;
  db.insert(schema.referralWithdrawals).values({
    id: withdrawalId,
    referrerId: agentId,
    amount: available,
    address,
    status: "pending",
  }).run();

  // TODO: Actually send USDC. For now, mark as pending for manual processing
  return c.json({
    withdrawal_id: withdrawalId,
    amount_usd: available,
    address,
    status: "pending",
    note: "Referral commission withdrawal queued. USDC will be sent to your address within 24h.",
  });
});
