import { Hono } from "hono";
import { randomUUID } from "crypto";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq, and, desc, sql } from "drizzle-orm";
import { agentAuth } from "../middleware/auth.js";
import { decryptKey } from "../engine/crypto.js";
import { submitMarketOrder, submitCloseOrder, calculateFee } from "../engine/hyperliquid.js";
import type { AppEnv } from "../types.js";

const app = new Hono<AppEnv>();

// Auth required for all routes except leaderboard
app.use("/follow/*", agentAuth);
app.use("/following", agentAuth);
app.use("/followers", agentAuth);

function round2(n: number) { return Math.round(n * 100) / 100; }

// ─── POST /copy/follow/:leader_agent_id ───

app.post("/follow/:leader_agent_id", async (c) => {
  const followerId = c.get("agentId") as string;
  const leaderId = c.req.param("leader_agent_id");

  if (followerId === leaderId) {
    return c.json({ error: "cannot_follow_self" }, 400);
  }

  const leader = db.select().from(schema.agents)
    .where(eq(schema.agents.id, leaderId)).get();
  if (!leader) return c.json({ error: "leader_not_found" }, 404);

  const body = await c.req.json();
  const { allocation_usdc, max_position_size, stop_loss_pct } = body;

  if (!allocation_usdc || allocation_usdc <= 0) {
    return c.json({ error: "invalid_allocation", message: "allocation_usdc must be positive" }, 400);
  }

  // Check if already following
  const existing = db.select().from(schema.copySubscriptions)
    .where(and(
      eq(schema.copySubscriptions.followerId, followerId),
      eq(schema.copySubscriptions.leaderId, leaderId),
      eq(schema.copySubscriptions.active, 1),
    )).get();

  if (existing) {
    return c.json({ error: "already_following", message: "You are already copy trading this agent", subscription_id: existing.id }, 400);
  }

  const subId = `sub_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

  db.insert(schema.copySubscriptions).values({
    id: subId,
    followerId,
    leaderId,
    allocationUsdc: allocation_usdc,
    maxPositionSize: max_position_size ?? null,
    stopLossPct: stop_loss_pct ?? null,
    active: 1,
  }).run();

  return c.json({
    subscription_id: subId,
    leader_id: leaderId,
    follower_id: followerId,
    allocation: allocation_usdc,
    max_position_size: max_position_size ?? null,
    stop_loss_pct: stop_loss_pct ?? null,
    message: `Now copy trading agent ${leaderId}. Proportional positions will open when they trade.`,
  }, 201);
});

// ─── DELETE /copy/follow/:leader_agent_id ───

app.delete("/follow/:leader_agent_id", async (c) => {
  const followerId = c.get("agentId") as string;
  const leaderId = c.req.param("leader_agent_id");
  const followerAgent = c.get("agent") as typeof schema.agents.$inferSelect;

  const sub = db.select().from(schema.copySubscriptions)
    .where(and(
      eq(schema.copySubscriptions.followerId, followerId),
      eq(schema.copySubscriptions.leaderId, leaderId),
      eq(schema.copySubscriptions.active, 1),
    )).get();

  if (!sub) return c.json({ error: "not_following", message: "No active copy subscription found" }, 404);

  // Close any open copy positions
  const openCopyTrades = db.select().from(schema.copyTrades)
    .where(and(
      eq(schema.copyTrades.subscriptionId, sub.id),
      eq(schema.copyTrades.status, "open"),
    )).all();

  const closedCount = { success: 0, failed: 0 };

  if (followerAgent.hlSigningKeyEncrypted && followerAgent.hlWalletAddress && openCopyTrades.length > 0) {
    let signingKey: string;
    try {
      signingKey = decryptKey(followerAgent.hlSigningKeyEncrypted);
    } catch {
      signingKey = "";
    }

    for (const ct of openCopyTrades) {
      if (!ct.followerPositionId) continue;
      const pos = db.select().from(schema.positions)
        .where(and(
          eq(schema.positions.id, ct.followerPositionId),
          eq(schema.positions.status, "open"),
        )).get();
      if (!pos) continue;

      try {
        if (signingKey) {
          await submitCloseOrder(signingKey, followerAgent.hlWalletAddress!, pos.coin, followerAgent.tier);
        }
        db.update(schema.positions).set({ status: "closed", closedAt: Math.floor(Date.now() / 1000) })
          .where(eq(schema.positions.id, ct.followerPositionId)).run();
        db.update(schema.copyTrades).set({ status: "closed" })
          .where(eq(schema.copyTrades.id, ct.id)).run();
        closedCount.success++;
      } catch {
        closedCount.failed++;
      }
    }
  }

  // Deactivate subscription
  db.update(schema.copySubscriptions)
    .set({ active: 0 })
    .where(eq(schema.copySubscriptions.id, sub.id))
    .run();

  return c.json({
    message: `Unfollowed ${leaderId}`,
    positions_closed: closedCount.success,
    positions_failed_to_close: closedCount.failed,
  });
});

// ─── GET /copy/following ───

app.get("/following", (c) => {
  const followerId = c.get("agentId") as string;

  const subs = db.select().from(schema.copySubscriptions)
    .where(and(
      eq(schema.copySubscriptions.followerId, followerId),
      eq(schema.copySubscriptions.active, 1),
    )).all();

  return c.json({
    following: subs.map(s => ({
      subscription_id: s.id,
      leader_id: s.leaderId,
      allocation_usdc: s.allocationUsdc,
      max_position_size: s.maxPositionSize,
      stop_loss_pct: s.stopLossPct,
      since: s.createdAt,
    })),
    count: subs.length,
  });
});

// ─── GET /copy/followers ───

app.get("/followers", (c) => {
  const leaderId = c.get("agentId") as string;

  const subs = db.select().from(schema.copySubscriptions)
    .where(and(
      eq(schema.copySubscriptions.leaderId, leaderId),
      eq(schema.copySubscriptions.active, 1),
    )).all();

  const totalAllocated = subs.reduce((sum, s) => sum + s.allocationUsdc, 0);

  return c.json({
    followers: subs.map(s => ({
      subscription_id: s.id,
      follower_id: s.followerId,
      allocation_usdc: s.allocationUsdc,
      since: s.createdAt,
    })),
    total_followers: subs.length,
    total_allocated_usdc: round2(totalAllocated),
  });
});

// ─── GET /copy/leaderboard ───

app.get("/leaderboard", (c) => {
  // No auth required — public endpoint
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;

  // Get top 10 traders by 30d PnL from closed trades
  const topTraders = db.select({
    agentId: schema.trades.agentId,
    totalPnl: sql<number>`SUM(${schema.trades.realizedPnl})`,
    totalVolume: sql<number>`SUM(${schema.trades.sizeUsd})`,
  })
    .from(schema.trades)
    .where(sql`${schema.trades.createdAt} >= ${thirtyDaysAgo}`)
    .groupBy(schema.trades.agentId)
    .orderBy(desc(sql`SUM(${schema.trades.realizedPnl})`))
    .limit(10)
    .all();

  const leaderboard = topTraders.map((t, i) => {
    const agent = db.select({ totalVolume: schema.agents.totalVolume })
      .from(schema.agents).where(eq(schema.agents.id, t.agentId)).get();

    const followerCount = db.select({ count: sql<number>`count(*)` })
      .from(schema.copySubscriptions)
      .where(and(
        eq(schema.copySubscriptions.leaderId, t.agentId),
        eq(schema.copySubscriptions.active, 1),
      )).get()?.count ?? 0;

    const totalAllocated = db.select({ total: sql<number>`SUM(allocation_usdc)` })
      .from(schema.copySubscriptions)
      .where(and(
        eq(schema.copySubscriptions.leaderId, t.agentId),
        eq(schema.copySubscriptions.active, 1),
      )).get()?.total ?? 0;

    const pnlPct = t.totalVolume > 0 ? round2((t.totalPnl / t.totalVolume) * 100) : 0;

    return {
      rank: i + 1,
      agent_id: t.agentId,
      pnl_30d: round2(t.totalPnl),
      pnl_pct_30d: pnlPct,
      total_followers: followerCount,
      total_allocated_usdc: round2(totalAllocated),
    };
  });

  return c.json({ leaderboard, period: "30d", generated_at: Math.floor(Date.now() / 1000) });
});

// ─── Internal: execute copy trades when leader opens position ───

export async function executeCopyOpen(
  leaderId: string,
  originalPositionId: string,
  coin: string,
  side: "long" | "short",
  sizeUsd: number,
  leverage: number,
) {
  const subscribers = db.select().from(schema.copySubscriptions)
    .where(and(
      eq(schema.copySubscriptions.leaderId, leaderId),
      eq(schema.copySubscriptions.active, 1),
    )).all();

  if (subscribers.length === 0) return;

  for (const sub of subscribers) {
    try {
      const followerAgent = db.select().from(schema.agents)
        .where(eq(schema.agents.id, sub.followerId)).get();

      if (!followerAgent?.hlSigningKeyEncrypted || !followerAgent.hlWalletAddress) {
        console.warn(`[copy] Follower ${sub.followerId} has no HL wallet configured, skipping`);
        continue;
      }

      // Proportional size: follower's allocation / leader's position size
      let proportionalSize = round2(sizeUsd * (sub.allocationUsdc / Math.max(sizeUsd, 1)));
      // Apply max position size cap
      if (sub.maxPositionSize && proportionalSize > sub.maxPositionSize) {
        proportionalSize = sub.maxPositionSize;
      }
      // Respect follower's tier limit
      if (proportionalSize > followerAgent.maxPositionUsd) {
        proportionalSize = followerAgent.maxPositionUsd;
      }
      if (proportionalSize < 1) {
        console.warn(`[copy] Proportional size $${proportionalSize} too small for follower ${sub.followerId}, skipping`);
        continue;
      }

      const lev = Math.min(leverage, followerAgent.maxLeverage);
      const signingKey = decryptKey(followerAgent.hlSigningKeyEncrypted);

      const fill = await submitMarketOrder(
        signingKey,
        followerAgent.hlWalletAddress,
        coin,
        side === "long",
        proportionalSize,
        lev,
        followerAgent.tier,
      );

      const fees = calculateFee(fill.sizeUsd, followerAgent.tier);
      const posId = `pos_${randomUUID()}`;
      const orderId = `ord_${randomUUID()}`;

      db.insert(schema.orders).values({
        id: orderId, agentId: sub.followerId, coin: fill.coin,
        side: side === "long" ? "buy" : "sell", orderType: "market",
        sizeUsd: fill.sizeUsd, leverage: lev, status: "filled",
        fillPrice: fill.avgPrice, fee: fees.totalFee,
        hlOrderId: String(fill.hlOrderId),
      }).run();

      db.insert(schema.positions).values({
        id: posId, agentId: sub.followerId, coin: fill.coin, side,
        sizeUsd: fill.sizeUsd, entryPrice: fill.avgPrice, leverage: lev,
        marginUsed: fill.marginRequired, liquidationPrice: fill.liquidationPrice,
        status: "open", hlOrderId: String(fill.hlOrderId),
      }).run();

      db.update(schema.orders).set({ positionId: posId }).where(eq(schema.orders.id, orderId)).run();

      db.insert(schema.trades).values({
        id: `trd_${randomUUID()}`, agentId: sub.followerId, orderId,
        coin: fill.coin, side: side === "long" ? "buy" : "sell",
        sizeUsd: fill.sizeUsd, price: fill.avgPrice, fee: fees.totalFee,
      }).run();

      db.update(schema.agents).set({
        totalVolume: sql`${schema.agents.totalVolume} + ${fill.sizeUsd}`,
        totalFeesPaid: sql`${schema.agents.totalFeesPaid} + ${fees.totalFee}`,
        lastActive: Math.floor(Date.now() / 1000),
      }).where(eq(schema.agents.id, sub.followerId)).run();

      // Record copy trade link
      const copyTradeId = `ct_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      db.insert(schema.copyTrades).values({
        id: copyTradeId,
        subscriptionId: sub.id,
        originalPositionId,
        followerPositionId: posId,
        status: "open",
      }).run();

      console.log(`[copy] Opened copy position ${posId} for follower ${sub.followerId} (leader: ${leaderId})`);
    } catch (err: any) {
      console.warn(`[copy] Failed to copy trade for follower ${sub.followerId}:`, err.message);
    }
  }
}

// ─── Internal: close copy trades when leader closes position ───

export async function executeCopyClose(leaderId: string, originalPositionId: string) {
  // Find all active copy trades for this original position
  const copyTradeList = db.select({
    ct: schema.copyTrades,
    sub: schema.copySubscriptions,
  })
    .from(schema.copyTrades)
    .innerJoin(schema.copySubscriptions, eq(schema.copyTrades.subscriptionId, schema.copySubscriptions.id))
    .where(and(
      eq(schema.copyTrades.originalPositionId, originalPositionId),
      eq(schema.copyTrades.status, "open"),
      eq(schema.copySubscriptions.leaderId, leaderId),
    ))
    .all();

  for (const row of copyTradeList) {
    const { ct, sub } = row;
    if (!ct.followerPositionId) continue;

    try {
      const followerAgent = db.select().from(schema.agents)
        .where(eq(schema.agents.id, sub.followerId)).get();

      if (!followerAgent?.hlSigningKeyEncrypted || !followerAgent.hlWalletAddress) continue;

      const pos = db.select().from(schema.positions)
        .where(and(
          eq(schema.positions.id, ct.followerPositionId),
          eq(schema.positions.status, "open"),
        )).get();
      if (!pos) continue;

      const signingKey = decryptKey(followerAgent.hlSigningKeyEncrypted);
      const close = await submitCloseOrder(signingKey, followerAgent.hlWalletAddress, pos.coin, followerAgent.tier);

      const currentPrice = close.avgPrice;
      const priceDiff = currentPrice - pos.entryPrice;
      const pnlPercent = priceDiff / pos.entryPrice;
      const rawPnl = pos.side === "long"
        ? pos.sizeUsd * pnlPercent
        : pos.sizeUsd * (-pnlPercent);
      const leveragedPnl = round2(rawPnl);

      const fees = calculateFee(pos.sizeUsd, followerAgent.tier);
      const closeSide = pos.side === "long" ? "sell" : "buy";
      const orderId = `ord_${randomUUID()}`;

      db.update(schema.positions).set({
        status: "closed", unrealizedPnl: leveragedPnl,
        closedAt: Math.floor(Date.now() / 1000),
      }).where(eq(schema.positions.id, ct.followerPositionId)).run();

      db.insert(schema.orders).values({
        id: orderId, agentId: sub.followerId, coin: pos.coin, side: closeSide,
        orderType: "market", sizeUsd: pos.sizeUsd, leverage: pos.leverage,
        status: "filled", fillPrice: currentPrice, fee: fees.totalFee,
        positionId: ct.followerPositionId, hlOrderId: String(close.hlOrderId),
      }).run();

      db.insert(schema.trades).values({
        id: `trd_${randomUUID()}`, agentId: sub.followerId, orderId,
        coin: pos.coin, side: closeSide, sizeUsd: pos.sizeUsd,
        price: currentPrice, fee: fees.totalFee, realizedPnl: leveragedPnl,
      }).run();

      db.update(schema.agents).set({
        totalVolume: sql`${schema.agents.totalVolume} + ${pos.sizeUsd}`,
        totalFeesPaid: sql`${schema.agents.totalFeesPaid} + ${fees.totalFee}`,
        totalPnl: sql`${schema.agents.totalPnl} + ${leveragedPnl}`,
        lastActive: Math.floor(Date.now() / 1000),
      }).where(eq(schema.agents.id, sub.followerId)).run();

      // Leader earns 20% of follower's profits from copy trading
      if (leveragedPnl > 0) {
        const leaderCommission = round2(leveragedPnl * 0.20);
        if (leaderCommission >= 0.01) {
          db.insert(schema.referralEarnings).values({
            id: `ref_${randomUUID()}`,
            referrerId: leaderId,
            referredId: sub.followerId,
            feeAmount: leveragedPnl,
            commissionAmount: leaderCommission,
            orderId,
          }).run();
          console.log(`[copy] Leader ${leaderId} earned $${leaderCommission} commission from follower ${sub.followerId}`);
        }
      }

      db.update(schema.copyTrades).set({ status: "closed" })
        .where(eq(schema.copyTrades.id, ct.id)).run();

      console.log(`[copy] Closed copy position ${ct.followerPositionId} for follower ${sub.followerId}`);
    } catch (err: any) {
      console.warn(`[copy] Failed to close copy trade for follower ${sub.followerId}:`, err.message);
    }
  }
}

export default app;
