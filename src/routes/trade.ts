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

export default app;
