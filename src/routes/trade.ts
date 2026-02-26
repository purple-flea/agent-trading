import { Hono } from "hono";
import { randomUUID } from "crypto";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq, and, sql, desc } from "drizzle-orm";
import { agentAuth } from "../middleware/auth.js";
import { decryptKey } from "../engine/crypto.js";
import {
  submitMarketOrder,
  submitCloseOrder,
  calculateFee,
  getPrice,
  resolveCoin,
  getAllHlPositions,
} from "../engine/hyperliquid.js";
import type { AppEnv } from "../types.js";
import { executeCopyOpen, executeCopyClose } from "./copy.js";

const app = new Hono<AppEnv>();
app.use("/*", agentAuth);

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Decrypt the agent's HL signing key — throws if not configured */
function getSigningKey(agent: typeof schema.agents.$inferSelect): string {
  if (!agent.hlSigningKeyEncrypted || !agent.hlWalletAddress) {
    throw new Error("Hyperliquid wallet not configured. Register with hl_wallet_address and hl_signing_key for real execution.");
  }
  return decryptKey(agent.hlSigningKeyEncrypted);
}

// POST /open — open a real position on Hyperliquid
app.post("/open", async (c) => {
  const agentId = c.get("agentId") as string;
  const agent = c.get("agent") as typeof schema.agents.$inferSelect;
  const body = await c.req.json();

  const { coin, side, size_usd, leverage } = body as {
    coin: string; side: "long" | "short"; size_usd: number; leverage?: number;
  };

  if (!coin || !side || !size_usd) {
    return c.json({
      error: "invalid_request",
      message: "Provide coin, side (long/short), size_usd",
      examples: {
        stock: { coin: "TSLA", side: "long", size_usd: 1000, leverage: 5 },
        commodity: { coin: "GOLD", side: "short", size_usd: 500, leverage: 10 },
        crypto: { coin: "BTC", side: "long", size_usd: 5000, leverage: 3 },
      },
    }, 400);
  }

  if (typeof size_usd !== "number" || !Number.isFinite(size_usd) || size_usd <= 0) {
    return c.json({ error: "invalid_size", message: "size_usd must be a positive number" }, 400);
  }

  if (side !== "long" && side !== "short") {
    return c.json({ error: "invalid_side", message: "side must be 'long' or 'short'" }, 400);
  }

  if (leverage !== undefined && leverage !== null && (typeof leverage !== "number" || leverage < 1 || !Number.isFinite(leverage))) {
    return c.json({ error: "invalid_leverage", message: "leverage must be a number >= 1" }, 400);
  }
  const lev = Math.min(leverage ?? 5, agent.maxLeverage);
  if (size_usd > agent.maxPositionUsd) {
    return c.json({
      error: "position_too_large",
      max_position_usd: agent.maxPositionUsd,
      message: `Max position size is $${agent.maxPositionUsd}. Upgrade tier for higher limits.`,
    }, 400);
  }

  let signingKey: string;
  try {
    signingKey = getSigningKey(agent);
  } catch (err: any) {
    return c.json({ error: "wallet_not_configured", message: err.message }, 400);
  }

  const isBuy = side === "long";
  const buySide = isBuy ? "buy" as const : "sell" as const;

  try {
    // Submit REAL order to Hyperliquid
    const fill = await submitMarketOrder(
      signingKey,
      agent.hlWalletAddress!,
      coin.toUpperCase(),
      isBuy,
      size_usd,
      lev,
      agent.tier,
    );

    const fees = calculateFee(fill.sizeUsd, agent.tier);

    // Record in our DB for tracking
    const orderId = `ord_${randomUUID()}`;
    db.insert(schema.orders).values({
      id: orderId, agentId, coin: fill.coin, side: buySide,
      orderType: "market", sizeUsd: fill.sizeUsd, leverage: lev,
      status: "filled", fillPrice: fill.avgPrice, fee: fees.totalFee,
      hlOrderId: String(fill.hlOrderId),
    }).run();

    const posId = `pos_${randomUUID()}`;
    db.insert(schema.positions).values({
      id: posId, agentId, coin: fill.coin, side,
      sizeUsd: fill.sizeUsd, entryPrice: fill.avgPrice, leverage: lev,
      marginUsed: fill.marginRequired, liquidationPrice: fill.liquidationPrice,
      status: "open",
      hlOrderId: String(fill.hlOrderId),
    }).run();

    db.update(schema.orders).set({ positionId: posId }).where(eq(schema.orders.id, orderId)).run();

    const tradeId = `trd_${randomUUID()}`;
    db.insert(schema.trades).values({
      id: tradeId, agentId, orderId, coin: fill.coin,
      side: buySide, sizeUsd: fill.sizeUsd, price: fill.avgPrice, fee: fees.totalFee,
    }).run();

    db.update(schema.agents).set({
      totalVolume: sql`${schema.agents.totalVolume} + ${fill.sizeUsd}`,
      totalFeesPaid: sql`${schema.agents.totalFeesPaid} + ${fees.totalFee}`,
      lastActive: Math.floor(Date.now() / 1000),
    }).where(eq(schema.agents.id, agentId)).run();

    // Referral commission (20% of our fee markup, 3-level chain)
    if (agent.referredBy && fees.ourFee > 0) {
      const levelMultipliers = [1.0, 0.5, 0.25];
      let currentReferredId = agentId;
      let currentReferrerId: string | null = agent.referredBy;
      for (let level = 0; level < 3 && currentReferrerId; level++) {
        const commission = round2(fees.ourFee * 0.20 * levelMultipliers[level]);
        if (commission >= 0.01) {
          db.insert(schema.referralEarnings).values({
            id: `ref_${randomUUID()}`,
            referrerId: currentReferrerId, referredId: currentReferredId,
            feeAmount: fees.ourFee, commissionAmount: commission, orderId,
          }).run();
        }
        const nextRef = db.select().from(schema.agents).where(eq(schema.agents.id, currentReferrerId)).get();
        currentReferredId = currentReferrerId;
        currentReferrerId = nextRef?.referredBy ?? null;
      }
    }

    // Copy trading: open proportional positions for all followers (async, non-blocking)
    executeCopyOpen(agentId, posId, fill.coin, side, fill.sizeUsd, lev).catch((err) => {
      console.warn("[copy] executeCopyOpen failed:", err.message);
    });

    return c.json({
      position_id: posId,
      order_id: orderId,
      coin: fill.coin,
      ticker: fill.displayName,
      category: fill.category,
      dex: fill.dex,
      side,
      size_usd: fill.sizeUsd,
      entry_price: fill.avgPrice,
      leverage: lev,
      max_leverage: fill.maxLeverage,
      margin_used: fill.marginRequired,
      liquidation_price: fill.liquidationPrice,
      fee: fees.totalFee,
      fee_breakdown: { hyperliquid: fees.hlFee, purple_flea_builder: fees.ourFee },
      hl_order_id: fill.hlOrderId,
      execution: "real",
      status: "open",
    });
  } catch (err: any) {
    return c.json({ error: "trade_failed", message: err.message }, 400);
  }
});

// POST /close — close a position via real Hyperliquid execution
app.post("/close", async (c) => {
  const agentId = c.get("agentId") as string;
  const agent = c.get("agent") as typeof schema.agents.$inferSelect;
  const body = await c.req.json();
  const { position_id } = body as { position_id: string };

  if (!position_id) return c.json({ error: "provide position_id" }, 400);

  const position = db.select().from(schema.positions).where(and(
    eq(schema.positions.id, position_id),
    eq(schema.positions.agentId, agentId),
    eq(schema.positions.status, "open"),
  )).get();

  if (!position) return c.json({ error: "position_not_found" }, 404);

  let signingKey: string;
  try {
    signingKey = getSigningKey(agent);
  } catch (err: any) {
    return c.json({ error: "wallet_not_configured", message: err.message }, 400);
  }

  try {
    // Submit REAL close order to Hyperliquid
    const close = await submitCloseOrder(
      signingKey,
      agent.hlWalletAddress!,
      position.coin,
      agent.tier,
    );

    const currentPrice = close.avgPrice;
    const priceDiff = currentPrice - position.entryPrice;
    const pnlPercent = priceDiff / position.entryPrice;
    const rawPnl = position.side === "long"
      ? position.sizeUsd * pnlPercent
      : position.sizeUsd * (-pnlPercent);
    const leveragedPnl = round2(rawPnl);

    const fees = calculateFee(position.sizeUsd, agent.tier);

    db.update(schema.positions).set({
      status: "closed", unrealizedPnl: leveragedPnl,
      closedAt: Math.floor(Date.now() / 1000),
    }).where(eq(schema.positions.id, position_id)).run();

    const closeSide = position.side === "long" ? "sell" : "buy";
    const orderId = `ord_${randomUUID()}`;
    db.insert(schema.orders).values({
      id: orderId, agentId, coin: position.coin, side: closeSide,
      orderType: "market", sizeUsd: position.sizeUsd, leverage: position.leverage,
      status: "filled", fillPrice: currentPrice, fee: fees.totalFee, positionId: position_id,
      hlOrderId: String(close.hlOrderId),
    }).run();

    db.insert(schema.trades).values({
      id: `trd_${randomUUID()}`, agentId, orderId,
      coin: position.coin, side: closeSide, sizeUsd: position.sizeUsd,
      price: currentPrice, fee: fees.totalFee, realizedPnl: leveragedPnl,
    }).run();

    db.update(schema.agents).set({
      totalVolume: sql`${schema.agents.totalVolume} + ${position.sizeUsd}`,
      totalFeesPaid: sql`${schema.agents.totalFeesPaid} + ${fees.totalFee}`,
      totalPnl: sql`${schema.agents.totalPnl} + ${leveragedPnl}`,
      lastActive: Math.floor(Date.now() / 1000),
    }).where(eq(schema.agents.id, agentId)).run();

    // Referral commission on close (20% of our fee markup, 3-level chain)
    if (agent.referredBy && fees.ourFee > 0) {
      const levelMultipliers = [1.0, 0.5, 0.25];
      let currentReferredId = agentId;
      let currentReferrerId: string | null = agent.referredBy;
      for (let level = 0; level < 3 && currentReferrerId; level++) {
        const commission = round2(fees.ourFee * 0.20 * levelMultipliers[level]);
        if (commission >= 0.01) {
          db.insert(schema.referralEarnings).values({
            id: `ref_${randomUUID()}`,
            referrerId: currentReferrerId, referredId: currentReferredId,
            feeAmount: fees.ourFee, commissionAmount: commission, orderId,
          }).run();
        }
        const nextRef = db.select().from(schema.agents).where(eq(schema.agents.id, currentReferrerId)).get();
        currentReferredId = currentReferrerId;
        currentReferrerId = nextRef?.referredBy ?? null;
      }
    }

    // Copy trading: close proportional positions for all followers (async, non-blocking)
    executeCopyClose(agentId, position_id).catch((err) => {
      console.warn("[copy] executeCopyClose failed:", err.message);
    });

    return c.json({
      position_id,
      coin: position.coin,
      ticker: position.coin.replace("xyz:", ""),
      side: position.side,
      entry_price: position.entryPrice,
      exit_price: currentPrice,
      size_usd: position.sizeUsd,
      leverage: position.leverage,
      pnl: leveragedPnl,
      pnl_percent: round2(pnlPercent * 100),
      fee: fees.totalFee,
      hl_order_id: close.hlOrderId,
      execution: "real",
      status: "closed",
    });
  } catch (err: any) {
    return c.json({ error: "close_failed", message: err.message }, 400);
  }
});

// GET /positions — real positions from Hyperliquid + our DB records
app.get("/positions", async (c) => {
  const agentId = c.get("agentId") as string;
  const agent = c.get("agent") as typeof schema.agents.$inferSelect;
  const showAll = c.req.query("status") === "all";

  // If showing all, include closed positions from our DB
  if (showAll) {
    const positions = db.select().from(schema.positions)
      .where(eq(schema.positions.agentId, agentId))
      .orderBy(desc(schema.positions.openedAt)).limit(50).all();

    const enriched = await Promise.all(positions.map(async (p) => {
      const currentPrice = await getPrice(p.coin);
      let unrealizedPnl = 0;
      if (currentPrice && p.status === "open") {
        const pnlPercent = (currentPrice - p.entryPrice) / p.entryPrice;
        unrealizedPnl = p.side === "long"
          ? round2(p.sizeUsd * pnlPercent)
          : round2(p.sizeUsd * (-pnlPercent));
      }
      return {
        ...p,
        ticker: p.coin.replace("xyz:", ""),
        current_price: currentPrice,
        unrealized_pnl: p.status === "open" ? unrealizedPnl : p.unrealizedPnl,
      };
    }));

    return c.json({ positions: enriched, count: enriched.length, source: "database" });
  }

  // For open positions, fetch real data from Hyperliquid if wallet is connected
  if (agent.hlWalletAddress) {
    try {
      const hlPositions = await getAllHlPositions(agent.hlWalletAddress);
      const enriched = await Promise.all(hlPositions.map(async (p) => {
        const currentPrice = await getPrice(p.coin);
        const szi = parseFloat(p.szi);
        const entryPx = parseFloat(p.entryPx);
        const sizeUsd = Math.abs(szi) * entryPx;

        // Try to find matching DB record for our position ID
        const dbPos = db.select().from(schema.positions).where(and(
          eq(schema.positions.agentId, agentId),
          eq(schema.positions.coin, p.coin),
          eq(schema.positions.status, "open"),
        )).get();

        return {
          position_id: dbPos?.id ?? null,
          coin: p.coin,
          ticker: p.coin.replace("xyz:", ""),
          side: szi > 0 ? "long" : "short",
          size: Math.abs(szi),
          size_usd: round2(sizeUsd),
          entry_price: entryPx,
          current_price: currentPrice,
          leverage: p.leverage,
          margin_used: parseFloat(p.marginUsed),
          liquidation_price: p.liquidationPx ? parseFloat(p.liquidationPx) : null,
          unrealized_pnl: parseFloat(p.unrealizedPnl),
          return_on_equity: p.returnOnEquity,
          source: "hyperliquid",
        };
      }));

      return c.json({ positions: enriched, count: enriched.length, source: "hyperliquid" });
    } catch {
      // Fall back to DB if HL query fails
    }
  }

  // Fallback: return DB positions
  const positions = db.select().from(schema.positions).where(and(
    eq(schema.positions.agentId, agentId), eq(schema.positions.status, "open"),
  )).all();

  const enriched = await Promise.all(positions.map(async (p) => {
    const currentPrice = await getPrice(p.coin);
    let unrealizedPnl = 0;
    if (currentPrice) {
      const pnlPercent = (currentPrice - p.entryPrice) / p.entryPrice;
      unrealizedPnl = p.side === "long"
        ? round2(p.sizeUsd * pnlPercent)
        : round2(p.sizeUsd * (-pnlPercent));
    }
    return {
      ...p,
      ticker: p.coin.replace("xyz:", ""),
      current_price: currentPrice,
      unrealized_pnl: unrealizedPnl,
    };
  }));

  return c.json({ positions: enriched, count: enriched.length, source: "database" });
});

// GET /history
app.get("/history", (c) => {
  const agentId = c.get("agentId") as string;
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50") || 50, 200);
  const trades = db.select().from(schema.trades)
    .where(eq(schema.trades.agentId, agentId))
    .orderBy(desc(schema.trades.createdAt)).limit(limit).all();
  return c.json({ trades, count: trades.length });
});

// GET /portfolio — portfolio summary with total exposure, PnL, and risk analysis
app.get("/portfolio", async (c) => {
  const agentId = c.get("agentId") as string;
  const agent = c.get("agent") as typeof schema.agents.$inferSelect;

  // Get open positions from DB
  const openPositions = db.select().from(schema.positions)
    .where(and(eq(schema.positions.agentId, agentId), eq(schema.positions.status, "open")))
    .all();

  // Enrich with current prices
  const enriched = await Promise.all(openPositions.map(async (p) => {
    const currentPrice = await getPrice(p.coin).catch(() => null);
    let unrealizedPnl = 0;
    let pnlPct = 0;
    if (currentPrice) {
      const pnlRaw = (currentPrice - p.entryPrice) / p.entryPrice;
      unrealizedPnl = p.side === "long"
        ? round2(p.sizeUsd * pnlRaw)
        : round2(p.sizeUsd * (-pnlRaw));
      pnlPct = round2(pnlRaw * 100 * (p.side === "long" ? 1 : -1));
    }
    // Liquidation price estimate: position liquidates when loss = initial margin (1/leverage)
    // For long: liq_price = entry * (1 - 1/leverage + 0.0005) (0.05% maintenance margin)
    // For short: liq_price = entry * (1 + 1/leverage - 0.0005)
    const maintenanceMargin = 0.0005;
    const liqMovePct = 1 / p.leverage - maintenanceMargin;
    const liquidationPrice = p.side === "long"
      ? round2(p.entryPrice * (1 - liqMovePct))
      : round2(p.entryPrice * (1 + liqMovePct));

    // Distance to liquidation as % of current price
    const distanceToLiq = currentPrice
      ? round2(Math.abs(currentPrice - liquidationPrice) / currentPrice * 100)
      : null;

    return {
      id: p.id,
      coin: p.coin,
      ticker: p.coin.replace("xyz:", ""),
      side: p.side,
      size_usd: p.sizeUsd,
      leverage: p.leverage,
      entry_price: p.entryPrice,
      current_price: currentPrice,
      unrealized_pnl: unrealizedPnl,
      pnl_pct: pnlPct,
      notional: currentPrice ? round2(Math.abs(p.sizeUsd / p.entryPrice * (currentPrice))) : null,
      liquidation_price: liquidationPrice,
      distance_to_liq_pct: distanceToLiq,
      risk_level: distanceToLiq === null ? "unknown"
        : distanceToLiq < 5 ? "critical"
        : distanceToLiq < 15 ? "high"
        : distanceToLiq < 30 ? "medium"
        : "low",
      // Suggested stop-loss: 50% of the way to liquidation from entry
      // Suggested take-profit: 2:1 reward-to-risk ratio
      suggested_stop_loss: p.side === "long"
        ? round2(p.entryPrice * (1 - liqMovePct * 0.5))
        : round2(p.entryPrice * (1 + liqMovePct * 0.5)),
      suggested_take_profit: p.side === "long"
        ? round2(p.entryPrice * (1 + liqMovePct))
        : round2(p.entryPrice * (1 - liqMovePct)),
    };
  }));

  const totalExposure = enriched.reduce((sum, p) => sum + p.size_usd, 0);
  const totalUnrealizedPnl = enriched.reduce((sum, p) => sum + p.unrealized_pnl, 0);
  const longExposure = enriched.filter(p => p.side === "long").reduce((sum, p) => sum + p.size_usd, 0);
  const shortExposure = enriched.filter(p => p.side === "short").reduce((sum, p) => sum + p.size_usd, 0);
  const netExposure = longExposure - shortExposure;

  // Closed trade summary from DB
  const closedStats = db.select({
    count: sql<number>`count(*)`,
    totalPnl: sql<number>`COALESCE(SUM(realized_pnl), 0)`,
    wins: sql<number>`SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END)`,
  }).from(schema.trades).where(eq(schema.trades.agentId, agentId)).get();

  const winRate = closedStats && closedStats.count > 0
    ? round2((closedStats.wins / closedStats.count) * 100)
    : null;

  // Aggregate risk level across all positions
  const criticalPositions = enriched.filter(p => p.risk_level === "critical").length;
  const highRiskPositions = enriched.filter(p => p.risk_level === "high").length;
  const portfolioRiskLevel = criticalPositions > 0 ? "critical"
    : highRiskPositions > 0 ? "high"
    : enriched.some(p => p.risk_level === "medium") ? "medium"
    : enriched.length > 0 ? "low"
    : "none";

  const riskWarnings: string[] = [];
  if (criticalPositions > 0) riskWarnings.push(`${criticalPositions} position(s) within 5% of liquidation — close or add margin immediately`);
  if (highRiskPositions > 0) riskWarnings.push(`${highRiskPositions} position(s) within 15% of liquidation`);
  if (agent.maxPositionUsd > 0 && totalExposure / agent.maxPositionUsd > 0.9) riskWarnings.push("Portfolio utilization >90% — near position limit");

  return c.json({
    summary: {
      open_positions: enriched.length,
      total_exposure_usd: round2(totalExposure),
      long_exposure_usd: round2(longExposure),
      short_exposure_usd: round2(shortExposure),
      net_exposure_usd: round2(netExposure),
      net_direction: netExposure > 0 ? "net_long" : netExposure < 0 ? "net_short" : "neutral",
      unrealized_pnl: round2(totalUnrealizedPnl),
      max_position_usd: agent.maxPositionUsd,
      utilization_pct: agent.maxPositionUsd > 0 ? round2(totalExposure / agent.maxPositionUsd * 100) : 0,
    },
    risk: {
      portfolio_risk_level: portfolioRiskLevel,
      warnings: riskWarnings,
      positions_by_risk: {
        critical: criticalPositions,
        high: highRiskPositions,
        medium: enriched.filter(p => p.risk_level === "medium").length,
        low: enriched.filter(p => p.risk_level === "low").length,
      },
    },
    lifetime: {
      total_trades: closedStats?.count ?? 0,
      realized_pnl: round2(closedStats?.totalPnl ?? 0),
      win_rate_pct: winRate,
    },
    positions: enriched,
  });
});

// GET /pnl-history — daily cumulative PnL chart data
app.get("/pnl-history", (c) => {
  const agentId = c.get("agentId") as string;
  const days = Math.min(parseInt(c.req.query("days") ?? "30") || 30, 365);

  const since = Math.floor(Date.now() / 1000) - days * 86400;

  const trades = db.select({
    realizedPnl: schema.trades.realizedPnl,
    fee: schema.trades.fee,
    createdAt: schema.trades.createdAt,
    coin: schema.trades.coin,
    side: schema.trades.side,
  }).from(schema.trades)
    .where(and(
      eq(schema.trades.agentId, agentId),
      sql`${schema.trades.createdAt} >= ${since}`,
    ))
    .orderBy(schema.trades.createdAt)
    .all();

  // Aggregate by day (UTC)
  const dayMap = new Map<string, { date: string; pnl: number; fees: number; trades: number }>();

  for (const trade of trades) {
    const date = new Date(trade.createdAt * 1000).toISOString().slice(0, 10); // YYYY-MM-DD
    const existing = dayMap.get(date) ?? { date, pnl: 0, fees: 0, trades: 0 };
    existing.pnl += trade.realizedPnl;
    existing.fees += trade.fee;
    existing.trades += 1;
    dayMap.set(date, existing);
  }

  // Sort by date and compute cumulative PnL
  const dailyData = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  let cumulative = 0;
  const chart = dailyData.map(d => {
    cumulative += d.pnl;
    return {
      date: d.date,
      daily_pnl: round2(d.pnl),
      daily_fees: round2(d.fees),
      trades: d.trades,
      cumulative_pnl: round2(cumulative),
    };
  });

  const totalPnl = round2(trades.reduce((sum, t) => sum + t.realizedPnl, 0));
  const totalFees = round2(trades.reduce((sum, t) => sum + t.fee, 0));
  const wins = trades.filter(t => t.realizedPnl > 0).length;

  return c.json({
    period_days: days,
    summary: {
      total_pnl: totalPnl,
      total_fees: totalFees,
      net_pnl: round2(totalPnl - totalFees),
      total_trades: trades.length,
      win_rate_pct: trades.length > 0 ? round2((wins / trades.length) * 100) : null,
      best_day: chart.length > 0 ? chart.reduce((best, d) => d.daily_pnl > best.daily_pnl ? d : best, chart[0]) : null,
      worst_day: chart.length > 0 ? chart.reduce((worst, d) => d.daily_pnl < worst.daily_pnl ? d : worst, chart[0]) : null,
    },
    chart,
    note: `Daily realized PnL from closed trades in last ${days} days`,
  });
});

// GET /stats-by-coin — per-coin trading statistics for the agent
app.get("/stats-by-coin", (c) => {
  const agentId = c.get("agentId") as string;
  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 100);

  const coinStats = db.select({
    coin: schema.trades.coin,
    totalTrades: sql<number>`COUNT(*)`,
    wins: sql<number>`SUM(CASE WHEN ${schema.trades.realizedPnl} > 0 THEN 1 ELSE 0 END)`,
    totalPnl: sql<number>`COALESCE(SUM(${schema.trades.realizedPnl}), 0)`,
    totalVolume: sql<number>`COALESCE(SUM(${schema.trades.sizeUsd}), 0)`,
    totalFees: sql<number>`COALESCE(SUM(${schema.trades.fee}), 0)`,
    bestTrade: sql<number>`COALESCE(MAX(${schema.trades.realizedPnl}), 0)`,
    worstTrade: sql<number>`COALESCE(MIN(${schema.trades.realizedPnl}), 0)`,
  })
    .from(schema.trades)
    .where(eq(schema.trades.agentId, agentId))
    .groupBy(schema.trades.coin)
    .orderBy(desc(sql`SUM(${schema.trades.realizedPnl})`))
    .limit(limit)
    .all();

  const totalPnlAll = coinStats.reduce((sum, c) => sum + c.totalPnl, 0);

  return c.json({
    by_coin: coinStats.map(s => ({
      coin: s.coin,
      ticker: s.coin.replace("xyz:", ""),
      total_trades: s.totalTrades,
      win_rate_pct: s.totalTrades > 0 ? round2((s.wins / s.totalTrades) * 100) : 0,
      total_pnl: round2(s.totalPnl),
      total_volume: round2(s.totalVolume),
      total_fees: round2(s.totalFees),
      net_pnl: round2(s.totalPnl - s.totalFees),
      best_trade: round2(s.bestTrade),
      worst_trade: round2(s.worstTrade),
      pnl_share_pct: totalPnlAll !== 0 ? round2((s.totalPnl / Math.abs(totalPnlAll)) * 100) : 0,
    })),
    total_coins_traded: coinStats.length,
    portfolio_pnl: round2(totalPnlAll),
    best_coin: coinStats.length > 0 ? coinStats[0].coin.replace("xyz:", "") : null,
    worst_coin: coinStats.length > 0 ? coinStats[coinStats.length - 1].coin.replace("xyz:", "") : null,
    note: coinStats.length === 0 ? "No closed trades yet. Open and close positions to see stats." : null,
  });
});

// GET /size-calculator — position sizing and risk management calculator (no external calls)
app.get("/size-calculator", (c) => {
  const agentId = c.get("agentId") as string;

  // Query params
  const accountSize = parseFloat(c.req.query("account_size") || "0");
  const riskPct = parseFloat(c.req.query("risk_pct") || "1"); // % of account to risk
  const leverage = parseInt(c.req.query("leverage") || "5");
  const entryPrice = parseFloat(c.req.query("entry_price") || "0");
  const stopLossPct = parseFloat(c.req.query("stop_loss_pct") || "2"); // % from entry to stop

  if (!accountSize || !entryPrice) {
    return c.json({
      error: "missing_params",
      message: "Provide ?account_size=1000&entry_price=67000",
      optional: "risk_pct (default 1%), leverage (default 5), stop_loss_pct (default 2%)",
      example: "/v1/trade/size-calculator?account_size=1000&entry_price=67000&risk_pct=1&leverage=5&stop_loss_pct=2",
    }, 400);
  }

  if (riskPct > 100 || riskPct <= 0) {
    return c.json({ error: "invalid_risk_pct", message: "risk_pct must be between 0.1 and 100" }, 400);
  }
  if (leverage < 1 || leverage > 100) {
    return c.json({ error: "invalid_leverage", message: "leverage must be between 1 and 100" }, 400);
  }

  // Risk amount in USD
  const riskAmountUsd = accountSize * (riskPct / 100);

  // Stop loss distance
  const stopLossDistancePct = stopLossPct / 100;
  const stopLossDistanceUsd = entryPrice * stopLossDistancePct;

  // Position size based on risk: risk / stop_distance_per_unit
  // For leveraged trade: position size = risk_amount / (stop_loss_pct / leverage)
  // Actually: contracts = riskAmount / stopLossDistanceUsd (for 1 unit of asset)
  // position_size_usd = contracts * entry_price / leverage ... simplified:
  // position_size_usd = risk_amount / (stop_loss_pct) * leverage
  const positionSizeUsd = (riskAmountUsd / stopLossDistancePct) * (1 / leverage) * leverage;
  // Simplified: positionSizeUsd = riskAmountUsd / stopLossDistancePct

  // Wait, correct formula: position_size = risk / stop_loss_per_unit
  // stop_loss_per_unit = entryPrice * stopLossDistancePct
  // In leveraged trading: position_size_usd = risk_amount_usd / stopLossDistancePct (leverage neutral for risk calc)
  const correctPositionSize = riskAmountUsd / stopLossDistancePct;

  // Margin required (position / leverage)
  const marginRequired = correctPositionSize / leverage;

  // Max position (limited by margin available)
  const maxPositionByMargin = accountSize * leverage;

  // Kelly fraction (simplified): f = (win_rate * avg_win/avg_loss - (1-win_rate)) / (avg_win/avg_loss)
  // Use historical win rate if available
  const tradeStats = db.select({
    wins: sql<number>`SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END)`,
    losses: sql<number>`SUM(CASE WHEN realized_pnl <= 0 THEN 1 ELSE 0 END)`,
    avgWin: sql<number>`AVG(CASE WHEN realized_pnl > 0 THEN realized_pnl ELSE NULL END)`,
    avgLoss: sql<number>`AVG(CASE WHEN realized_pnl < 0 THEN realized_pnl ELSE NULL END)`,
  }).from(schema.trades).where(eq(schema.trades.agentId, agentId)).get();

  let kellyFraction: number | null = null;
  let kellyPositionSize: number | null = null;

  if (tradeStats && (tradeStats.wins + tradeStats.losses) >= 10) {
    const total = tradeStats.wins + tradeStats.losses;
    const winRate = tradeStats.wins / total;
    const avgWin = tradeStats.avgWin ?? 0;
    const avgLoss = Math.abs(tradeStats.avgLoss ?? 1);
    const winLossRatio = avgWin / avgLoss;
    kellyFraction = (winRate * winLossRatio - (1 - winRate)) / winLossRatio;
    kellyFraction = Math.max(0, Math.min(kellyFraction, 0.25)); // cap at 25% for safety
    kellyPositionSize = round2(accountSize * kellyFraction);
  }

  // Risk-to-reward suggestions
  const stopLossPrice = entryPrice * (1 - stopLossDistancePct); // assumes long
  const tp_1r = round2(entryPrice * (1 + stopLossDistancePct));     // 1:1 R/R
  const tp_2r = round2(entryPrice * (1 + stopLossDistancePct * 2)); // 2:1 R/R
  const tp_3r = round2(entryPrice * (1 + stopLossDistancePct * 3)); // 3:1 R/R

  const finalPosition = Math.min(round2(correctPositionSize), maxPositionByMargin);
  const cappedByAccount = correctPositionSize > maxPositionByMargin;

  return c.json({
    inputs: {
      account_size_usd: accountSize,
      risk_pct: riskPct,
      risk_amount_usd: round2(riskAmountUsd),
      leverage,
      entry_price: entryPrice,
      stop_loss_pct: stopLossPct,
    },
    recommended: {
      position_size_usd: finalPosition,
      margin_required_usd: round2(finalPosition / leverage),
      account_utilization_pct: round2((finalPosition / leverage / accountSize) * 100),
      note: cappedByAccount ? "Position capped by account size × leverage" : "Position sized by risk tolerance",
    },
    kelly: kellyPositionSize !== null ? {
      kelly_fraction_pct: round2((kellyFraction ?? 0) * 100),
      kelly_position_size_usd: kellyPositionSize,
      based_on_trades: (tradeStats?.wins ?? 0) + (tradeStats?.losses ?? 0),
      note: "Kelly Criterion based on your actual trade history",
    } : {
      note: "Need at least 10 closed trades for Kelly Criterion calculation",
    },
    risk_reward: {
      stop_loss_price: round2(stopLossPrice),
      tp_1_to_1: tp_1r,
      tp_2_to_1: tp_2r,
      tp_3_to_1: tp_3r,
      note: "Take-profit levels for long positions. Invert for shorts.",
    },
    rules_of_thumb: [
      `Never risk more than 2% of account on a single trade (you risk ${riskPct}%)`,
      `With ${leverage}x leverage, a ${round2(100 / leverage)}% adverse move = 100% margin loss`,
      "Use stop-losses on every trade. Margin calls are painful.",
      "Scale into positions — don't put full size on first entry",
    ],
  });
});

// GET /daily-report — daily trading summary: today + yesterday side by side
app.get("/daily-report", async (c) => {
  const agentId = c.get("agentId") as string;

  const now = Math.floor(Date.now() / 1000);
  const todayStartUtc = Math.floor(new Date().setUTCHours(0, 0, 0, 0) / 1000);
  const yesterdayStartUtc = todayStartUtc - 86400;

  // Fetch trades for today and yesterday
  const recentTrades = db.select({
    realizedPnl: schema.trades.realizedPnl,
    fee: schema.trades.fee,
    sizeUsd: schema.trades.sizeUsd,
    coin: schema.trades.coin,
    side: schema.trades.side,
    createdAt: schema.trades.createdAt,
  }).from(schema.trades)
    .where(and(
      eq(schema.trades.agentId, agentId),
      sql`${schema.trades.createdAt} >= ${yesterdayStartUtc}`,
    ))
    .orderBy(schema.trades.createdAt)
    .all();

  const todayTrades = recentTrades.filter(t => t.createdAt >= todayStartUtc);
  const yesterdayTrades = recentTrades.filter(t => t.createdAt >= yesterdayStartUtc && t.createdAt < todayStartUtc);

  function summarize(trades: typeof recentTrades) {
    if (trades.length === 0) return null;
    const totalPnl = trades.reduce((s, t) => s + t.realizedPnl, 0);
    const totalFees = trades.reduce((s, t) => s + t.fee, 0);
    const netPnl = totalPnl - totalFees;
    const wins = trades.filter(t => t.realizedPnl > 0).length;
    const volume = trades.reduce((s, t) => s + t.sizeUsd, 0);
    const bestTrade = trades.reduce((best, t) => t.realizedPnl > best.realizedPnl ? t : best, trades[0]);
    const worstTrade = trades.reduce((worst, t) => t.realizedPnl < worst.realizedPnl ? t : worst, trades[0]);
    return {
      trades: trades.length,
      wins,
      losses: trades.length - wins,
      win_rate_pct: round2((wins / trades.length) * 100),
      volume_usd: round2(volume),
      gross_pnl: round2(totalPnl),
      fees: round2(totalFees),
      net_pnl: round2(netPnl),
      roi_pct: volume > 0 ? round2((netPnl / volume) * 100) : 0,
      best_trade: { coin: bestTrade.coin.replace("xyz:", ""), pnl: round2(bestTrade.realizedPnl) },
      worst_trade: { coin: worstTrade.coin.replace("xyz:", ""), pnl: round2(worstTrade.realizedPnl) },
    };
  }

  const todaySummary = summarize(todayTrades);
  const yesterdaySummary = summarize(yesterdayTrades);

  // Live open positions value
  const agent = db.select({
    totalPnl: schema.agents.totalPnl,
    totalVolume: schema.agents.totalVolume,
  }).from(schema.agents).where(eq(schema.agents.id, agentId)).get();

  // Day-over-day comparison
  let comparison: string | null = null;
  if (todaySummary && yesterdaySummary) {
    const pnlChange = todaySummary.net_pnl - yesterdaySummary.net_pnl;
    comparison = pnlChange >= 0
      ? `+$${round2(pnlChange)} better than yesterday`
      : `-$${round2(Math.abs(pnlChange))} worse than yesterday`;
  }

  // Open positions count
  const openPositions = db.select({ count: sql<number>`COUNT(*)` })
    .from(schema.positions)
    .where(and(eq(schema.positions.agentId, agentId), eq(schema.positions.status, "open")))
    .get();

  return c.json({
    report_date: new Date().toISOString().slice(0, 10),
    today: todaySummary ?? { trades: 0, message: "No trades today yet" },
    yesterday: yesterdaySummary ?? { trades: 0, message: "No trades yesterday" },
    day_over_day: comparison,
    open_positions: openPositions?.count ?? 0,
    all_time: {
      total_pnl: round2(agent?.totalPnl ?? 0),
      total_volume: round2(agent?.totalVolume ?? 0),
    },
    actions: {
      view_positions: "GET /v1/trade/positions",
      open_trade: "POST /v1/trade/open",
      full_history: "GET /v1/trade/pnl-history?days=30",
    },
  });
});

// GET /drawdown — max drawdown and equity curve from closed trade history
app.get("/drawdown", (c) => {
  const agentId = c.get("agentId") as string;
  const days = Math.min(parseInt(c.req.query("days") ?? "90") || 90, 365);
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  const trades = db.select({
    realizedPnl: schema.trades.realizedPnl,
    fee: schema.trades.fee,
    createdAt: schema.trades.createdAt,
    coin: schema.trades.coin,
  }).from(schema.trades)
    .where(and(
      eq(schema.trades.agentId, agentId),
      sql`${schema.trades.createdAt} >= ${since}`,
    ))
    .orderBy(schema.trades.createdAt)
    .all();

  if (trades.length === 0) {
    return c.json({
      period_days: days,
      message: "No closed trades in this period. Open and close positions to generate equity curve data.",
      tip: `Use ?days=365 to look back further`,
    });
  }

  // Build equity curve: running cumulative net PnL (after fees)
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let maxDrawdownStartIdx = 0;
  let maxDrawdownEndIdx = 0;
  let currentPeakIdx = 0;

  const curve: Array<{
    trade_num: number;
    date: string;
    coin: string;
    net_pnl: number;
    equity: number;
    drawdown_from_peak: number;
    drawdown_pct: number;
  }> = [];

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const net = t.realizedPnl - t.fee;
    equity = round2(equity + net);
    const dd = equity - peak;
    const ddPct = peak > 0 ? round2((dd / peak) * 100) : 0;

    if (equity > peak) {
      peak = equity;
      currentPeakIdx = i;
    }

    if (dd < maxDrawdown) {
      maxDrawdown = dd;
      maxDrawdownStartIdx = currentPeakIdx;
      maxDrawdownEndIdx = i;
    }

    curve.push({
      trade_num: i + 1,
      date: new Date(t.createdAt * 1000).toISOString().slice(0, 10),
      coin: t.coin.replace("xyz:", ""),
      net_pnl: round2(net),
      equity,
      drawdown_from_peak: round2(dd),
      drawdown_pct: ddPct,
    });
  }

  const finalEquity = curve[curve.length - 1]?.equity ?? 0;
  const totalNetPnl = round2(trades.reduce((s, t) => s + t.realizedPnl - t.fee, 0));
  const wins = trades.filter(t => t.realizedPnl > 0).length;

  // Recovery factor: net PnL / max drawdown (higher = better)
  const recoveryFactor = maxDrawdown < 0
    ? round2(totalNetPnl / Math.abs(maxDrawdown))
    : null;

  // Calmar ratio: annualized return / max drawdown
  const dailyReturn = totalNetPnl / days;
  const annualizedReturn = dailyReturn * 365;
  const calmarRatio = maxDrawdown < 0
    ? round2(annualizedReturn / Math.abs(maxDrawdown))
    : null;

  // Consecutive losing trades (max)
  let maxConsecLosses = 0;
  let curConsecLosses = 0;
  for (const t of trades) {
    if (t.realizedPnl <= 0) { curConsecLosses++; maxConsecLosses = Math.max(maxConsecLosses, curConsecLosses); }
    else curConsecLosses = 0;
  }

  const mddStartTrade = curve[maxDrawdownStartIdx];
  const mddEndTrade = curve[maxDrawdownEndIdx];

  return c.json({
    period_days: days,
    total_trades: trades.length,
    summary: {
      final_equity: finalEquity,
      total_net_pnl: totalNetPnl,
      win_rate_pct: round2((wins / trades.length) * 100),
      max_drawdown_usd: round2(maxDrawdown),
      max_drawdown_pct: peak > 0 ? round2((maxDrawdown / peak) * 100) : 0,
      max_consec_losses: maxConsecLosses,
      recovery_factor: recoveryFactor,
      calmar_ratio: calmarRatio,
      peak_equity: round2(peak),
      drawdown_period: mddStartTrade && mddEndTrade ? {
        from: mddStartTrade.date,
        to: mddEndTrade.date,
        trades_in_drawdown: maxDrawdownEndIdx - maxDrawdownStartIdx,
      } : null,
    },
    equity_curve: curve,
    interpretation: {
      recovery_factor: recoveryFactor !== null
        ? (recoveryFactor > 2 ? "Good (>2x): gains comfortably outweigh max drawdown"
          : recoveryFactor > 1 ? "OK (>1x): net positive but drawdown was significant"
          : "Poor (<1x): drawdown exceeded total gains")
        : "N/A — no drawdown period",
      calmar_ratio: calmarRatio !== null
        ? (calmarRatio > 1 ? "Strong: annualized return > max drawdown"
          : calmarRatio > 0.5 ? "Moderate: consider reducing position size"
          : "Weak: high drawdown relative to returns")
        : "N/A",
      max_drawdown_guidance: maxDrawdown < 0
        ? `Your max drawdown was $${Math.abs(round2(maxDrawdown))}. Consider stopping or reducing size when drawdown exceeds 20% of peak equity.`
        : "No drawdown — all trades profitable so far (rare, be cautious of overconfidence)",
    },
    tip: "Use ?days=30 for recent performance or ?days=365 for full history",
  });
});

export default app;
