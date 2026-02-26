import { Hono } from "hono";
import { randomUUID } from "crypto";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq, and, desc, sql } from "drizzle-orm";
import { agentAuth } from "../middleware/auth.js";
import { decryptKey, decryptKeyCbc } from "../engine/crypto.js";

/** Decrypt a signing key using the correct algorithm based on whether wallet was auto-generated */
function resolveSigningKey(agent: { hlSigningKeyEncrypted: string | null; generatedWallet: number }): string {
  if (!agent.hlSigningKeyEncrypted) throw new Error("No signing key stored");
  return agent.generatedWallet === 1
    ? decryptKeyCbc(agent.hlSigningKeyEncrypted)
    : decryptKey(agent.hlSigningKeyEncrypted);
}
import { submitMarketOrder, submitCloseOrder, calculateFee } from "../engine/hyperliquid.js";
import type { AppEnv } from "../types.js";

const app = new Hono<AppEnv>();

// Auth required for all routes except leaderboard and leader stats
app.use("/follow/*", agentAuth);
app.use("/following", agentAuth);
app.use("/followers", agentAuth);
app.use("/my-leader-stats", agentAuth);

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
      signingKey = resolveSigningKey(followerAgent);
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

// ─── GET /copy/leader/:leader_id/stats — public leader performance profile ───

app.get("/leader/:leader_id/stats", (c) => {
  const leaderId = c.req.param("leader_id");
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;

  const leader = db.select({
    id: schema.agents.id,
    tier: schema.agents.tier,
    totalVolume: schema.agents.totalVolume,
    totalPnl: schema.agents.totalPnl,
    createdAt: schema.agents.createdAt,
  }).from(schema.agents).where(eq(schema.agents.id, leaderId)).get();

  if (!leader) return c.json({ error: "leader_not_found" }, 404);

  // 30d trade stats
  const stats30d = db.select({
    totalPnl: sql<number>`COALESCE(SUM(${schema.trades.realizedPnl}), 0)`,
    totalVolume: sql<number>`COALESCE(SUM(${schema.trades.sizeUsd}), 0)`,
    totalFees: sql<number>`COALESCE(SUM(${schema.trades.fee}), 0)`,
    tradeCount: sql<number>`COUNT(*)`,
    winCount: sql<number>`SUM(CASE WHEN ${schema.trades.realizedPnl} > 0 THEN 1 ELSE 0 END)`,
  }).from(schema.trades)
    .where(and(
      eq(schema.trades.agentId, leaderId),
      sql`${schema.trades.createdAt} >= ${thirtyDaysAgo}`,
    )).get();

  // 7d trade stats
  const stats7d = db.select({
    totalPnl: sql<number>`COALESCE(SUM(${schema.trades.realizedPnl}), 0)`,
    tradeCount: sql<number>`COUNT(*)`,
    winCount: sql<number>`SUM(CASE WHEN ${schema.trades.realizedPnl} > 0 THEN 1 ELSE 0 END)`,
  }).from(schema.trades)
    .where(and(
      eq(schema.trades.agentId, leaderId),
      sql`${schema.trades.createdAt} >= ${sevenDaysAgo}`,
    )).get();

  // Per-coin breakdown (30d)
  const coinStats = db.select({
    coin: schema.trades.coin,
    pnl: sql<number>`COALESCE(SUM(${schema.trades.realizedPnl}), 0)`,
    volume: sql<number>`COALESCE(SUM(${schema.trades.sizeUsd}), 0)`,
    trades: sql<number>`COUNT(*)`,
    wins: sql<number>`SUM(CASE WHEN ${schema.trades.realizedPnl} > 0 THEN 1 ELSE 0 END)`,
  }).from(schema.trades)
    .where(and(
      eq(schema.trades.agentId, leaderId),
      sql`${schema.trades.createdAt} >= ${thirtyDaysAgo}`,
    ))
    .groupBy(schema.trades.coin)
    .orderBy(desc(sql`COALESCE(SUM(${schema.trades.realizedPnl}), 0)`))
    .limit(5)
    .all();

  // Best and worst single trade (30d)
  const bestTrade = db.select({
    coin: schema.trades.coin,
    pnl: schema.trades.realizedPnl,
    size: schema.trades.sizeUsd,
  }).from(schema.trades)
    .where(and(
      eq(schema.trades.agentId, leaderId),
      sql`${schema.trades.createdAt} >= ${thirtyDaysAgo}`,
    ))
    .orderBy(desc(schema.trades.realizedPnl))
    .limit(1).get();

  const worstTrade = db.select({
    coin: schema.trades.coin,
    pnl: schema.trades.realizedPnl,
    size: schema.trades.sizeUsd,
  }).from(schema.trades)
    .where(and(
      eq(schema.trades.agentId, leaderId),
      sql`${schema.trades.createdAt} >= ${thirtyDaysAgo}`,
    ))
    .orderBy(schema.trades.realizedPnl)
    .limit(1).get();

  // Current followers
  const followerStats = db.select({
    count: sql<number>`COUNT(*)`,
    totalAllocated: sql<number>`COALESCE(SUM(${schema.copySubscriptions.allocationUsdc}), 0)`,
  }).from(schema.copySubscriptions)
    .where(and(
      eq(schema.copySubscriptions.leaderId, leaderId),
      eq(schema.copySubscriptions.active, 1),
    )).get();

  // Commission earned from copy followers (30d)
  const commissionEarned30d = db.select({
    total: sql<number>`COALESCE(SUM(${schema.referralEarnings.commissionAmount}), 0)`,
    count: sql<number>`COUNT(*)`,
  }).from(schema.referralEarnings)
    .where(and(
      eq(schema.referralEarnings.referrerId, leaderId),
      sql`${schema.referralEarnings.createdAt} >= ${thirtyDaysAgo}`,
    )).get();

  const pnl30d = round2(stats30d?.totalPnl ?? 0);
  const vol30d = round2(stats30d?.totalVolume ?? 0);
  const trades30d = stats30d?.tradeCount ?? 0;
  const wins30d = stats30d?.winCount ?? 0;
  const winRate30d = trades30d > 0 ? round2((wins30d / trades30d) * 100) : 0;
  const pnlPct30d = vol30d > 0 ? round2((pnl30d / vol30d) * 100) : 0;

  const pnl7d = round2(stats7d?.totalPnl ?? 0);
  const trades7d = stats7d?.tradeCount ?? 0;
  const wins7d = stats7d?.winCount ?? 0;
  const winRate7d = trades7d > 0 ? round2((wins7d / trades7d) * 100) : 0;

  return c.json({
    leader_id: leaderId,
    tier: leader.tier,
    member_since: leader.createdAt,
    performance: {
      "7d": {
        pnl_usd: pnl7d,
        trade_count: trades7d,
        win_rate_pct: winRate7d,
      },
      "30d": {
        pnl_usd: pnl30d,
        pnl_return_pct: pnlPct30d,
        volume_usd: vol30d,
        trade_count: trades30d,
        win_rate_pct: winRate30d,
        fees_paid: round2(stats30d?.totalFees ?? 0),
        net_pnl_after_fees: round2(pnl30d - (stats30d?.totalFees ?? 0)),
      },
      all_time: {
        total_pnl_usd: round2(leader.totalPnl),
        total_volume_usd: round2(leader.totalVolume),
      },
    },
    top_coins_30d: coinStats.map(c => ({
      coin: c.coin,
      pnl_usd: round2(c.pnl),
      volume_usd: round2(c.volume),
      trades: c.trades,
      win_rate_pct: c.trades > 0 ? round2((c.wins / c.trades) * 100) : 0,
    })),
    best_trade_30d: bestTrade ? { coin: bestTrade.coin, pnl_usd: round2(bestTrade.pnl), size_usd: round2(bestTrade.size) } : null,
    worst_trade_30d: worstTrade ? { coin: worstTrade.coin, pnl_usd: round2(worstTrade.pnl), size_usd: round2(worstTrade.size) } : null,
    copy_stats: {
      active_followers: followerStats?.count ?? 0,
      total_allocated_usdc: round2(followerStats?.totalAllocated ?? 0),
      commission_earned_30d: round2(commissionEarned30d?.total ?? 0),
      commission_trades_30d: commissionEarned30d?.count ?? 0,
      commission_rate_pct: 20,
    },
    copy_tip: (followerStats?.count ?? 0) === 0
      ? "No followers yet. Strong 30d performance is the best way to attract copy traders."
      : `You have ${followerStats?.count} follower(s) with $${round2(followerStats?.totalAllocated ?? 0)} allocated. Keep your win rate above 55% to retain followers.`,
  }, 200, { "Cache-Control": "public, max-age=60" });
});

// ─── GET /copy/my-leader-stats — auth required, same data for self ───

app.get("/my-leader-stats", (c) => {
  const leaderId = c.get("agentId") as string;
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;

  // Active followers detail
  const followers = db.select({
    followerId: schema.copySubscriptions.followerId,
    allocationUsdc: schema.copySubscriptions.allocationUsdc,
    maxPositionSize: schema.copySubscriptions.maxPositionSize,
    stopLossPct: schema.copySubscriptions.stopLossPct,
    since: schema.copySubscriptions.createdAt,
  }).from(schema.copySubscriptions)
    .where(and(
      eq(schema.copySubscriptions.leaderId, leaderId),
      eq(schema.copySubscriptions.active, 1),
    )).all();

  const totalAllocated = followers.reduce((s, f) => s + f.allocationUsdc, 0);

  // Open copy positions being mirrored right now
  const openCopyCount = db.select({ count: sql<number>`COUNT(*)` })
    .from(schema.copyTrades)
    .innerJoin(schema.copySubscriptions, eq(schema.copyTrades.subscriptionId, schema.copySubscriptions.id))
    .where(and(
      eq(schema.copySubscriptions.leaderId, leaderId),
      eq(schema.copyTrades.status, "open"),
    )).get()?.count ?? 0;

  // Commission earned (all-time vs 30d)
  const commAll = db.select({
    total: sql<number>`COALESCE(SUM(${schema.referralEarnings.commissionAmount}), 0)`,
    count: sql<number>`COUNT(*)`,
  }).from(schema.referralEarnings)
    .where(eq(schema.referralEarnings.referrerId, leaderId)).get();

  const comm30d = db.select({
    total: sql<number>`COALESCE(SUM(${schema.referralEarnings.commissionAmount}), 0)`,
    count: sql<number>`COUNT(*)`,
  }).from(schema.referralEarnings)
    .where(and(
      eq(schema.referralEarnings.referrerId, leaderId),
      sql`${schema.referralEarnings.createdAt} >= ${thirtyDaysAgo}`,
    )).get();

  // Top earning follower (all-time)
  const topFollowerRow = db.select({
    followerId: schema.referralEarnings.referredId,
    earned: sql<number>`COALESCE(SUM(${schema.referralEarnings.commissionAmount}), 0)`,
  }).from(schema.referralEarnings)
    .where(eq(schema.referralEarnings.referrerId, leaderId))
    .groupBy(schema.referralEarnings.referredId)
    .orderBy(desc(sql`COALESCE(SUM(${schema.referralEarnings.commissionAmount}), 0)`))
    .limit(1).get();

  const growthTip = followers.length === 0
    ? "No followers yet. Share your leader stats link to attract copy traders."
    : followers.length < 5
    ? `You have ${followers.length} follower(s). Top leaders on the platform have 10+ followers. Focus on consistent win rate.`
    : `Strong following! ${followers.length} followers with $${round2(totalAllocated)} allocated. 20% commission on all profitable copy trades.`;

  return c.json({
    leader_id: leaderId,
    followers: followers.map(f => ({
      follower_id: f.followerId,
      allocation_usdc: round2(f.allocationUsdc),
      max_position_size: f.maxPositionSize,
      stop_loss_pct: f.stopLossPct,
      following_since: f.since,
    })),
    summary: {
      active_followers: followers.length,
      total_allocated_usdc: round2(totalAllocated),
      open_copy_positions: openCopyCount,
    },
    commissions: {
      earned_30d: round2(comm30d?.total ?? 0),
      trades_30d: comm30d?.count ?? 0,
      earned_all_time: round2(commAll?.total ?? 0),
      trades_all_time: commAll?.count ?? 0,
      rate_pct: 20,
      top_follower: topFollowerRow
        ? { follower_id: topFollowerRow.followerId, earned_from: round2(topFollowerRow.earned) }
        : null,
    },
    growth_tip: growthTip,
    public_stats_url: `/v1/copy/leader/${leaderId}/stats`,
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
    const followerCount = db.select({ count: sql<number>`count(*)` })
      .from(schema.copySubscriptions)
      .where(and(
        eq(schema.copySubscriptions.leaderId, t.agentId),
        eq(schema.copySubscriptions.active, 1),
      )).get()?.count ?? 0;

    const totalAllocated = db.select({ total: sql<number>`COALESCE(SUM(allocation_usdc), 0)` })
      .from(schema.copySubscriptions)
      .where(and(
        eq(schema.copySubscriptions.leaderId, t.agentId),
        eq(schema.copySubscriptions.active, 1),
      )).get()?.total ?? 0;

    // Win rate in the same 30d window
    const tradeStats = db.select({
      total: sql<number>`COUNT(*)`,
      wins: sql<number>`SUM(CASE WHEN ${schema.trades.realizedPnl} > 0 THEN 1 ELSE 0 END)`,
    }).from(schema.trades)
      .where(and(
        eq(schema.trades.agentId, t.agentId),
        sql`${schema.trades.createdAt} >= ${thirtyDaysAgo}`,
      )).get();

    const winRate = (tradeStats?.total ?? 0) > 0
      ? round2(((tradeStats?.wins ?? 0) / tradeStats!.total) * 100)
      : 0;

    const pnlPct = t.totalVolume > 0 ? round2((t.totalPnl / t.totalVolume) * 100) : 0;

    return {
      rank: i + 1,
      agent_id: t.agentId,
      pnl_30d: round2(t.totalPnl),
      pnl_pct_30d: pnlPct,
      win_rate_30d_pct: winRate,
      trade_count_30d: tradeStats?.total ?? 0,
      total_followers: followerCount,
      total_allocated_usdc: round2(totalAllocated),
      copy_this_trader: `POST /v1/copy/follow/${t.agentId}`,
      stats_url: `/v1/copy/leader/${t.agentId}/stats`,
    };
  });

  return c.json({
    leaderboard,
    period: "30d",
    generated_at: Math.floor(Date.now() / 1000),
    how_to_copy: "POST /v1/copy/follow/:agent_id with { allocation_usdc, max_position_size?, stop_loss_pct? }",
  }, 200, { "Cache-Control": "public, max-age=30" });
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
      const signingKey = resolveSigningKey(followerAgent);

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

      const signingKey = resolveSigningKey(followerAgent);
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
