import { Hono } from "hono";
import { randomUUID } from "crypto";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq, and, sql, desc } from "drizzle-orm";
import { agentAuth } from "../middleware/auth.js";
import { decryptKey, decryptKeyCbc } from "../engine/crypto.js";
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
  // Auto-generated wallets use AES-256-CBC (service key); user-supplied wallets use AES-256-GCM (env key)
  if (agent.generatedWallet === 1) {
    return decryptKeyCbc(agent.hlSigningKeyEncrypted);
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

  // Daily loss limit check
  if (agent.maxDailyLossUsd != null && agent.maxDailyLossUsd > 0) {
    const todayStart = Math.floor(new Date().setUTCHours(0, 0, 0, 0) / 1000);
    const todayPnl = db.select({
      netPnl: sql<number>`COALESCE(SUM(${schema.trades.realizedPnl} - ${schema.trades.fee}), 0)`,
    }).from(schema.trades)
      .where(and(
        eq(schema.trades.agentId, agentId),
        sql`${schema.trades.createdAt} >= ${todayStart}`,
      ))
      .get();

    const dailyLoss = Math.min(0, todayPnl?.netPnl ?? 0); // negative = loss
    const currentLoss = Math.abs(dailyLoss);

    if (currentLoss >= agent.maxDailyLossUsd) {
      return c.json({
        error: "daily_loss_limit_reached",
        message: `Daily loss limit of $${agent.maxDailyLossUsd} reached. Trading blocked until UTC midnight.`,
        daily_loss_limit_usd: agent.maxDailyLossUsd,
        current_daily_loss_usd: Math.round(currentLoss * 100) / 100,
        resets_at: new Date(new Date().setUTCHours(24, 0, 0, 0)).toISOString(),
        tip: "Update your limit via POST /v1/trade/risk-settings",
      }, 403);
    }
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

// GET /risk-check — risk assessment for current open positions
app.get("/risk-check", async (c) => {
  const agentId = c.get("agentId") as string;

  const openPositions = db.select().from(schema.positions)
    .where(and(eq(schema.positions.agentId, agentId), eq(schema.positions.status, "open")))
    .all();

  if (openPositions.length === 0) {
    return c.json({
      status: "no_positions",
      overall_risk: "none",
      message: "No open positions. All clear.",
      open_a_trade: "POST /v1/trade/open",
    });
  }

  // Enrich with current prices
  const enriched = await Promise.all(openPositions.map(async (p) => {
    const currentPrice = await getPrice(p.coin).catch(() => null);
    let unrealizedPnl = 0;
    let distanceToLiq: number | null = null;
    if (currentPrice) {
      const pnlRaw = (currentPrice - p.entryPrice) / p.entryPrice;
      unrealizedPnl = p.side === "long"
        ? round2(p.sizeUsd * pnlRaw)
        : round2(p.sizeUsd * (-pnlRaw));
      const maintenanceMargin = 0.0005;
      const liqMovePct = 1 / p.leverage - maintenanceMargin;
      const liquidationPrice = p.side === "long"
        ? p.entryPrice * (1 - liqMovePct)
        : p.entryPrice * (1 + liqMovePct);
      distanceToLiq = round2(Math.abs(currentPrice - liquidationPrice) / currentPrice * 100);
    }
    return { ...p, currentPrice, unrealizedPnl, distanceToLiq };
  }));

  // Risk metrics
  const totalExposure = enriched.reduce((s, p) => s + p.sizeUsd, 0);
  const totalMargin = enriched.reduce((s, p) => s + p.marginUsed, 0);
  const totalUnrealizedPnl = enriched.reduce((s, p) => s + p.unrealizedPnl, 0);

  // Concentration risk: any single coin > 50% of total exposure
  const exposureByCoins: Record<string, number> = {};
  for (const p of enriched) {
    exposureByCoins[p.coin] = (exposureByCoins[p.coin] ?? 0) + p.sizeUsd;
  }
  const concentrationRisk = Object.entries(exposureByCoins)
    .map(([coin, exposure]) => ({
      coin: coin.replace("xyz:", ""),
      exposure: round2(exposure),
      pct_of_total: round2((exposure / totalExposure) * 100),
    }))
    .filter(cc => cc.pct_of_total > 50);

  // Direction risk
  const netLong = enriched.filter(p => p.side === "long").reduce((s, p) => s + p.sizeUsd, 0);
  const netShort = enriched.filter(p => p.side === "short").reduce((s, p) => s + p.sizeUsd, 0);
  const netDirection = netLong > netShort ? "net_long" : netShort > netLong ? "net_short" : "balanced";
  const directionRatio = totalExposure > 0 ? round2((netLong / totalExposure) * 100) : 50;

  // Near-liquidation positions: distance to liq < 10%
  const nearLiq = enriched.filter(p => p.distanceToLiq !== null && p.distanceToLiq < 10);
  const highLeverage = enriched.filter(p => p.leverage > 10);

  // Build warnings
  const warnings: Array<{ severity: "critical" | "warning" | "info"; message: string; action?: string }> = [];

  for (const p of nearLiq) {
    warnings.push({
      severity: "critical",
      message: `${p.coin.replace("xyz:", "")} ${p.side} is ${p.distanceToLiq}% from liquidation`,
      action: `Close: POST /v1/trade/close { "position_id": "${p.id}" }`,
    });
  }

  if (concentrationRisk.length > 0) {
    for (const r of concentrationRisk) {
      warnings.push({
        severity: "warning",
        message: `${r.coin} is ${r.pct_of_total}% of total exposure ($${r.exposure})`,
        action: "Diversify across multiple assets to reduce concentration risk",
      });
    }
  }

  if (highLeverage.length > 0) {
    warnings.push({
      severity: "warning",
      message: `${highLeverage.length} position(s) using >10x leverage`,
      action: "High leverage positions: " + highLeverage.map(p => p.coin.replace("xyz:", "")).join(", "),
    });
  }

  if (totalUnrealizedPnl < 0 && Math.abs(totalUnrealizedPnl) > totalMargin * 0.5) {
    warnings.push({
      severity: "warning",
      message: `Unrealized loss ($${round2(Math.abs(totalUnrealizedPnl))}) exceeds 50% of total margin ($${round2(totalMargin)})`,
      action: "Consider reducing size to prevent forced liquidation",
    });
  }

  if (warnings.length === 0) {
    warnings.push({ severity: "info", message: "No risk alerts. Positions look healthy." });
  }

  const overallRisk = nearLiq.length > 0 ? "critical"
    : warnings.some(w => w.severity === "warning") ? "elevated"
    : "normal";

  return c.json({
    overall_risk: overallRisk,
    open_positions: enriched.length,
    summary: {
      total_exposure_usd: round2(totalExposure),
      total_margin_usd: round2(totalMargin),
      unrealized_pnl: round2(totalUnrealizedPnl),
      net_direction: netDirection,
      long_pct: directionRatio,
      short_pct: round2(100 - directionRatio),
    },
    warnings,
    positions: enriched.map(p => ({
      id: p.id,
      coin: p.coin.replace("xyz:", ""),
      side: p.side,
      size_usd: round2(p.sizeUsd),
      leverage: p.leverage,
      entry_price: p.entryPrice,
      current_price: p.currentPrice,
      unrealized_pnl: round2(p.unrealizedPnl),
      distance_to_liq_pct: p.distanceToLiq,
    })),
    tip: "Monitor with GET /v1/trade/portfolio. Close a position: POST /v1/trade/close",
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

// GET /trading-hours — analyze best/worst hours and days to trade (pattern analysis)

app.get("/trading-hours", (c) => {
  const agentId = c.get("agentId") as string;

  const trades = db.select({
    realizedPnl: schema.trades.realizedPnl,
    fee: schema.trades.fee,
    createdAt: schema.trades.createdAt,
  })
    .from(schema.trades)
    .where(eq(schema.trades.agentId, agentId))
    .all();

  if (trades.length < 5) {
    return c.json({
      message: "Need at least 5 trades for pattern analysis",
      total_trades: trades.length,
      tip: "Make more trades to unlock trading hour insights",
    });
  }

  // Bucket by UTC hour (0-23) and day of week (0=Sun, 6=Sat)
  type HourBucket = { pnl: number; count: number; wins: number };
  const hourBuckets: HourBucket[] = Array.from({ length: 24 }, () => ({ pnl: 0, count: 0, wins: 0 }));
  const dowBuckets: HourBucket[] = Array.from({ length: 7 }, () => ({ pnl: 0, count: 0, wins: 0 }));
  const dowNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  for (const trade of trades) {
    const d = new Date(trade.createdAt * 1000);
    const hour = d.getUTCHours();
    const dow = d.getUTCDay();
    const net = trade.realizedPnl - trade.fee;

    hourBuckets[hour].pnl += net;
    hourBuckets[hour].count++;
    if (net > 0) hourBuckets[hour].wins++;

    dowBuckets[dow].pnl += net;
    dowBuckets[dow].count++;
    if (net > 0) dowBuckets[dow].wins++;
  }

  const hourStats = hourBuckets.map((b, hour) => ({
    hour_utc: hour,
    label: `${String(hour).padStart(2, "0")}:00 UTC`,
    trades: b.count,
    net_pnl: b.count > 0 ? round2(b.pnl) : 0,
    win_rate_pct: b.count > 0 ? round2((b.wins / b.count) * 100) : 0,
    avg_pnl: b.count > 0 ? round2(b.pnl / b.count) : 0,
  })).filter(h => h.trades > 0);

  const dowStats = dowBuckets.map((b, dow) => ({
    day: dowNames[dow],
    day_index: dow,
    trades: b.count,
    net_pnl: b.count > 0 ? round2(b.pnl) : 0,
    win_rate_pct: b.count > 0 ? round2((b.wins / b.count) * 100) : 0,
    avg_pnl: b.count > 0 ? round2(b.pnl / b.count) : 0,
  })).filter(d => d.trades > 0);

  // Find best/worst
  const sortedHours = [...hourStats].sort((a, b) => b.net_pnl - a.net_pnl);
  const sortedDays = [...dowStats].sort((a, b) => b.net_pnl - a.net_pnl);

  const bestHour = sortedHours[0] ?? null;
  const worstHour = sortedHours[sortedHours.length - 1] ?? null;
  const bestDay = sortedDays[0] ?? null;
  const worstDay = sortedDays[sortedDays.length - 1] ?? null;

  // Market session classification
  function getSession(hour: number): string {
    if (hour >= 0 && hour < 8) return "Asia";
    if (hour >= 8 && hour < 16) return "Europe";
    return "Americas";
  }

  const sessionBuckets: Record<string, HourBucket> = {
    Asia: { pnl: 0, count: 0, wins: 0 },
    Europe: { pnl: 0, count: 0, wins: 0 },
    Americas: { pnl: 0, count: 0, wins: 0 },
  };

  for (const h of hourStats) {
    const session = getSession(h.hour_utc);
    sessionBuckets[session].pnl += h.net_pnl;
    sessionBuckets[session].count += h.trades;
    sessionBuckets[session].wins += Math.round(h.trades * h.win_rate_pct / 100);
  }

  const bySessions = Object.entries(sessionBuckets)
    .filter(([_, b]) => b.count > 0)
    .map(([session, b]) => ({
      session,
      hours_utc: session === "Asia" ? "00-08" : session === "Europe" ? "08-16" : "16-24",
      trades: b.count,
      net_pnl: round2(b.pnl),
      win_rate_pct: b.count > 0 ? round2((b.wins / b.count) * 100) : 0,
    }))
    .sort((a, b) => b.net_pnl - a.net_pnl);

  return c.json({
    total_analyzed: trades.length,
    best_hour: bestHour ? {
      hour: bestHour.label,
      net_pnl: bestHour.net_pnl,
      win_rate_pct: bestHour.win_rate_pct,
      tip: `Your most profitable hour. Consider prioritizing trades around ${bestHour.label}.`,
    } : null,
    worst_hour: worstHour ? {
      hour: worstHour.label,
      net_pnl: worstHour.net_pnl,
      tip: `Your least profitable hour. Consider avoiding or reducing size around ${worstHour.label}.`,
    } : null,
    best_day: bestDay ? {
      day: bestDay.day,
      net_pnl: bestDay.net_pnl,
      win_rate_pct: bestDay.win_rate_pct,
    } : null,
    worst_day: worstDay ? {
      day: worstDay.day,
      net_pnl: worstDay.net_pnl,
    } : null,
    by_hour: hourStats,
    by_day_of_week: dowStats,
    by_market_session: bySessions,
    note: "All times are UTC. Crypto markets are 24/7 but volatility patterns vary by session.",
    disclaimer: "Past performance patterns don't guarantee future results. Sample size matters.",
  });
});

// GET /correlation — pairwise PnL correlation between traded markets

app.get("/correlation", (c) => {
  const agentId = c.get("agentId") as string;
  const days = Math.min(parseInt(c.req.query("days") || "90"), 365);
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  // Get all trades in the window, grouped by day + coin
  const rawTrades = db.select({
    coin: schema.trades.coin,
    realizedPnl: schema.trades.realizedPnl,
    fee: schema.trades.fee,
    createdAt: schema.trades.createdAt,
  })
    .from(schema.trades)
    .where(and(
      eq(schema.trades.agentId, agentId),
      sql`${schema.trades.createdAt} >= ${since}`,
    ))
    .all();

  // Get distinct coins with at least 3 trades
  const coinCount = new Map<string, number>();
  for (const t of rawTrades) {
    coinCount.set(t.coin, (coinCount.get(t.coin) ?? 0) + 1);
  }
  const coins = Array.from(coinCount.entries())
    .filter(([_, count]) => count >= 3)
    .map(([coin]) => coin);

  if (coins.length < 2) {
    return c.json({
      message: "Need at least 2 markets with 3+ trades each for correlation analysis",
      traded_coins: Array.from(coinCount.keys()).map(c => c.replace("xyz:", "")),
      days_analyzed: days,
      tip: "Trade more markets to unlock correlation analysis",
    });
  }

  // Group daily PnL by coin
  const dailyPnl = new Map<string, Map<string, number>>();
  for (const t of rawTrades) {
    const day = new Date(t.createdAt * 1000).toISOString().slice(0, 10);
    if (!dailyPnl.has(t.coin)) dailyPnl.set(t.coin, new Map());
    const coinMap = dailyPnl.get(t.coin)!;
    coinMap.set(day, (coinMap.get(day) ?? 0) + (t.realizedPnl - t.fee));
  }

  // Get all days that appear for any coin
  const allDays = new Set<string>();
  for (const [, dayMap] of dailyPnl) {
    for (const day of dayMap.keys()) allDays.add(day);
  }
  const sortedDays = Array.from(allDays).sort();

  // Build returns array per coin (0 for days with no trades)
  const returns: Map<string, number[]> = new Map();
  for (const coin of coins) {
    const dayMap = dailyPnl.get(coin) ?? new Map();
    returns.set(coin, sortedDays.map(d => dayMap.get(d) ?? 0));
  }

  // Compute Pearson correlation between pairs
  function pearson(a: number[], b: number[]): number {
    const n = a.length;
    if (n < 2) return 0;
    const meanA = a.reduce((s, x) => s + x, 0) / n;
    const meanB = b.reduce((s, x) => s + x, 0) / n;
    const cov = a.reduce((s, x, i) => s + (x - meanA) * (b[i] - meanB), 0);
    const stdA = Math.sqrt(a.reduce((s, x) => s + (x - meanA) ** 2, 0));
    const stdB = Math.sqrt(b.reduce((s, x) => s + (x - meanB) ** 2, 0));
    if (stdA === 0 || stdB === 0) return 0;
    return cov / (stdA * stdB);
  }

  const matrix: Array<{
    coin_a: string;
    coin_b: string;
    correlation: number;
    interpretation: string;
    risk_flag: boolean;
  }> = [];

  for (let i = 0; i < coins.length; i++) {
    for (let j = i + 1; j < coins.length; j++) {
      const coinA = coins[i];
      const coinB = coins[j];
      const a = returns.get(coinA)!;
      const b = returns.get(coinB)!;
      const r = parseFloat(pearson(a, b).toFixed(3));

      let interpretation: string;
      if (r > 0.8) interpretation = "Highly correlated — near-identical PnL pattern";
      else if (r > 0.5) interpretation = "Moderately correlated — tend to move together";
      else if (r > 0.2) interpretation = "Weakly correlated — some co-movement";
      else if (r > -0.2) interpretation = "Uncorrelated — independent PnL drivers";
      else if (r > -0.5) interpretation = "Mildly inverse — hedge potential";
      else interpretation = "Strongly inverse — natural hedge";

      matrix.push({
        coin_a: coinA.replace("xyz:", ""),
        coin_b: coinB.replace("xyz:", ""),
        correlation: r,
        interpretation,
        risk_flag: r > 0.7, // high positive correlation = concentration risk
      });
    }
  }

  matrix.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

  const highCorrelationPairs = matrix.filter(p => p.risk_flag);
  const bestHedgePairs = matrix.filter(p => p.correlation < -0.3).sort((a, b) => a.correlation - b.correlation);

  return c.json({
    days_analyzed: days,
    coins_analyzed: coins.map(c => c.replace("xyz:", "")),
    data_points: sortedDays.length,
    correlation_matrix: matrix,
    risk_warnings: highCorrelationPairs.length > 0
      ? highCorrelationPairs.map(p => ({
          pair: `${p.coin_a}/${p.coin_b}`,
          correlation: p.correlation,
          warning: `${p.coin_a} and ${p.coin_b} are highly correlated (r=${p.correlation}). Trading both simultaneously doubles concentration risk.`,
        }))
      : null,
    hedge_opportunities: bestHedgePairs.slice(0, 3).map(p => ({
      pair: `${p.coin_a}/${p.coin_b}`,
      correlation: p.correlation,
      tip: `${p.coin_a} and ${p.coin_b} tend to move inversely — holding both can reduce portfolio volatility.`,
    })),
    interpretation_guide: {
      "1.0 to 0.7": "Highly correlated — avoid holding both simultaneously (doubles risk)",
      "0.7 to 0.3": "Moderate correlation — some diversification benefit",
      "0.3 to -0.3": "Low/no correlation — good diversification",
      "-0.3 to -1.0": "Inverse correlation — natural hedge",
    },
    note: "Correlation based on daily realized PnL patterns from your trades. Not the same as price correlation.",
    tip: "Reduce position size in highly correlated markets to avoid hidden concentration risk.",
  });
});

// ─── GET /market-timing — win rate by hour and day of week per coin ───

app.get("/market-timing", agentAuth, (c) => {
  const agentId = c.get("agentId") as string;
  const coin = c.req.query("coin"); // optional filter

  const trades = db.select({
    realizedPnl: schema.trades.realizedPnl,
    fee: schema.trades.fee,
    createdAt: schema.trades.createdAt,
    coin: schema.trades.coin,
  }).from(schema.trades)
    .where(coin
      ? and(eq(schema.trades.agentId, agentId), eq(schema.trades.coin, coin))
      : eq(schema.trades.agentId, agentId)
    )
    .all();

  if (trades.length < 5) {
    return c.json({
      error: "insufficient_data",
      message: `Need at least 5 closed trades${coin ? ` for ${coin}` : ""}. Have: ${trades.length}.`,
    }, 404);
  }

  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const SESSION_NAMES: Record<number, string> = {};
  for (let h = 0; h < 24; h++) {
    SESSION_NAMES[h] = h < 8 ? "Asia (00-08 UTC)" : h < 16 ? "Europe (08-16 UTC)" : "Americas (16-24 UTC)";
  }

  // Bucket by hour (0-23 UTC) and day of week (0=Sun)
  type Bucket = { wins: number; total: number; netPnl: number };
  const hourBuckets: Bucket[] = Array.from({ length: 24 }, () => ({ wins: 0, total: 0, netPnl: 0 }));
  const dayBuckets: Bucket[] = Array.from({ length: 7 }, () => ({ wins: 0, total: 0, netPnl: 0 }));

  for (const t of trades) {
    const d = new Date(t.createdAt * 1000);
    const hour = d.getUTCHours();
    const day = d.getUTCDay();
    const won = t.realizedPnl > 0;
    const net = t.realizedPnl - t.fee;

    hourBuckets[hour].total++;
    hourBuckets[hour].netPnl += net;
    if (won) hourBuckets[hour].wins++;

    dayBuckets[day].total++;
    dayBuckets[day].netPnl += net;
    if (won) dayBuckets[day].wins++;
  }

  const toStats = (b: Bucket, label: string) => ({
    label,
    trades: b.total,
    wins: b.wins,
    win_rate_pct: b.total > 0 ? Math.round((b.wins / b.total) * 10000) / 100 : 0,
    net_pnl: Math.round(b.netPnl * 100) / 100,
  });

  const hourStats = hourBuckets
    .map((b, h) => toStats(b, `${String(h).padStart(2, "0")}:00 UTC`))
    .filter(s => s.trades > 0);

  const dayStats = dayBuckets
    .map((b, d) => toStats(b, DAY_NAMES[d]))
    .filter(s => s.trades > 0);

  // Find best/worst hours and days (min 2 trades)
  const qualifiedHours = hourStats.filter(s => s.trades >= 2);
  const qualifiedDays = dayStats.filter(s => s.trades >= 2);

  const bestHour = qualifiedHours.sort((a, b) => b.win_rate_pct - a.win_rate_pct)[0] ?? null;
  const worstHour = [...qualifiedHours].sort((a, b) => a.win_rate_pct - b.win_rate_pct)[0] ?? null;
  const bestDay = qualifiedDays.sort((a, b) => b.win_rate_pct - a.win_rate_pct)[0] ?? null;
  const worstDay = [...qualifiedDays].sort((a, b) => a.win_rate_pct - b.win_rate_pct)[0] ?? null;

  // Session aggregates
  const sessionBuckets: Record<string, Bucket> = {
    "Asia (00-08 UTC)": { wins: 0, total: 0, netPnl: 0 },
    "Europe (08-16 UTC)": { wins: 0, total: 0, netPnl: 0 },
    "Americas (16-24 UTC)": { wins: 0, total: 0, netPnl: 0 },
  };
  hourBuckets.forEach((b, h) => {
    const sess = SESSION_NAMES[h];
    sessionBuckets[sess].wins += b.wins;
    sessionBuckets[sess].total += b.total;
    sessionBuckets[sess].netPnl += b.netPnl;
  });
  const sessionStats = Object.entries(sessionBuckets)
    .map(([label, b]) => toStats(b, label))
    .filter(s => s.trades > 0);

  return c.json({
    coin: coin ?? "all",
    total_trades_analyzed: trades.length,
    best_hour: bestHour ? { hour: bestHour.label, win_rate_pct: bestHour.win_rate_pct, trades: bestHour.trades, session: SESSION_NAMES[parseInt(bestHour.label)] } : null,
    worst_hour: worstHour ? { hour: worstHour.label, win_rate_pct: worstHour.win_rate_pct, trades: worstHour.trades } : null,
    best_day: bestDay ? { day: bestDay.label, win_rate_pct: bestDay.win_rate_pct, trades: bestDay.trades } : null,
    worst_day: worstDay ? { day: worstDay.label, win_rate_pct: worstDay.win_rate_pct, trades: worstDay.trades } : null,
    by_session: sessionStats,
    by_hour: hourStats.sort((a, b) => a.label.localeCompare(b.label)),
    by_day_of_week: dayStats,
    tip: coin ? `Filter by coin: ?coin=${coin}. Try other markets for comparison.` : "Filter by specific market: ?coin=BTC or ?coin=ETH",
    note: "Win rate by time of day can reveal when you trade best. At least 2 trades per bucket for reliable data.",
  });
});

// ─── GET /risk-settings — view current risk controls ───

app.get("/risk-settings", agentAuth, (c) => {
  const agent = c.get("agent") as typeof schema.agents.$inferSelect;
  const agentId = c.get("agentId") as string;

  // Compute today's PnL to show progress vs daily limit
  const todayStart = Math.floor(new Date().setUTCHours(0, 0, 0, 0) / 1000);
  const todayPnl = db.select({
    netPnl: sql<number>`COALESCE(SUM(${schema.trades.realizedPnl} - ${schema.trades.fee}), 0)`,
    tradeCount: sql<number>`COUNT(*)`,
  }).from(schema.trades)
    .where(and(
      eq(schema.trades.agentId, agentId),
      sql`${schema.trades.createdAt} >= ${todayStart}`,
    ))
    .get();

  const dailyNetPnl = Math.round((todayPnl?.netPnl ?? 0) * 100) / 100;
  const dailyLoss = Math.min(0, dailyNetPnl);
  const currentLoss = Math.abs(dailyLoss);
  const limit = agent.maxDailyLossUsd;
  const blocked = limit != null && limit > 0 && currentLoss >= limit;

  return c.json({
    risk_settings: {
      max_leverage: agent.maxLeverage,
      max_position_usd: agent.maxPositionUsd,
      max_daily_loss_usd: limit ?? null,
    },
    today: {
      net_pnl: dailyNetPnl,
      current_loss_usd: Math.round(currentLoss * 100) / 100,
      trade_count: todayPnl?.tradeCount ?? 0,
      daily_loss_limit_pct_used: limit != null && limit > 0
        ? Math.round((currentLoss / limit) * 10000) / 100
        : null,
      trading_blocked: blocked,
      resets_at: new Date(new Date().setUTCHours(24, 0, 0, 0)).toISOString(),
    },
    update_tip: "POST /v1/trade/risk-settings { max_daily_loss_usd: 500 } to set a daily loss limit",
  });
});

// ─── POST /risk-settings — update daily loss limit and other risk controls ───

app.post("/risk-settings", agentAuth, async (c) => {
  const agent = c.get("agent") as typeof schema.agents.$inferSelect;
  const agentId = c.get("agentId") as string;
  const body = await c.req.json() as any;

  const updates: Partial<typeof schema.agents.$inferInsert> = {};
  const changed: string[] = [];

  if ("max_daily_loss_usd" in body) {
    const val = body.max_daily_loss_usd;
    if (val === null) {
      updates.maxDailyLossUsd = null;
      changed.push("max_daily_loss_usd: disabled (no limit)");
    } else if (typeof val === "number" && val > 0) {
      updates.maxDailyLossUsd = val;
      changed.push(`max_daily_loss_usd: $${val}`);
    } else {
      return c.json({ error: "invalid_value", message: "max_daily_loss_usd must be a positive number or null to disable" }, 400);
    }
  }

  if ("max_leverage" in body) {
    const val = body.max_leverage;
    if (typeof val !== "number" || val < 1 || val > 50) {
      return c.json({ error: "invalid_value", message: "max_leverage must be 1-50" }, 400);
    }
    const maxAllowed = agent.tier === "free" ? 20 : 50;
    const capped = Math.min(val, maxAllowed);
    updates.maxLeverage = capped;
    changed.push(`max_leverage: ${capped}x`);
  }

  if ("max_position_usd" in body) {
    const val = body.max_position_usd;
    if (typeof val !== "number" || val <= 0) {
      return c.json({ error: "invalid_value", message: "max_position_usd must be a positive number" }, 400);
    }
    const maxAllowed = agent.tier === "free" ? 50000 : 500000;
    const capped = Math.min(val, maxAllowed);
    updates.maxPositionUsd = capped;
    changed.push(`max_position_usd: $${capped}`);
  }

  if (changed.length === 0) {
    return c.json({
      error: "no_changes",
      message: "Provide at least one of: max_daily_loss_usd, max_leverage, max_position_usd",
    }, 400);
  }

  db.update(schema.agents).set(updates).where(eq(schema.agents.id, agentId)).run();

  return c.json({
    success: true,
    changed,
    risk_settings: {
      max_leverage: updates.maxLeverage ?? agent.maxLeverage,
      max_position_usd: updates.maxPositionUsd ?? agent.maxPositionUsd,
      max_daily_loss_usd: "maxDailyLossUsd" in updates ? updates.maxDailyLossUsd : agent.maxDailyLossUsd,
    },
    note: "Daily loss limit blocks new trade opens until UTC midnight when limit is reached.",
  });
});

// ─── GET /position-size — position sizing calculator (Kelly, fixed-risk, fixed-fraction) ───

app.get("/position-size", agentAuth, async (c) => {
  const agentId = c.get("agentId") as string;

  const accountSizeStr = c.req.query("account_size");
  const riskPctStr = c.req.query("risk_pct");
  const entryPriceStr = c.req.query("entry_price");
  const stopLossPriceStr = c.req.query("stop_loss_price");
  const leverageStr = c.req.query("leverage");

  if (!accountSizeStr || !riskPctStr || !entryPriceStr || !stopLossPriceStr) {
    return c.json({
      error: "missing_params",
      message: "Required: account_size, risk_pct (0-100), entry_price, stop_loss_price",
      example: "GET /v1/trade/position-size?account_size=10000&risk_pct=1&entry_price=50000&stop_loss_price=49000&leverage=1",
      optional_params: {
        leverage: "1-100 (default 1 = no leverage)",
      },
      methods_explained: {
        fixed_risk: "Risk exactly risk_pct of account per trade. Most common method.",
        kelly: "Kelly criterion: size based on your historical win rate and avg win/loss ratio.",
        fixed_fraction: "Fixed fraction of account as margin (same as fixed_risk when leverage=1).",
      },
    }, 400);
  }

  const accountSize = parseFloat(accountSizeStr);
  const riskPct = parseFloat(riskPctStr);
  const entryPrice = parseFloat(entryPriceStr);
  const stopLossPrice = parseFloat(stopLossPriceStr);
  const leverage = Math.max(1, Math.min(100, parseFloat(leverageStr ?? "1") || 1));

  if (isNaN(accountSize) || isNaN(riskPct) || isNaN(entryPrice) || isNaN(stopLossPrice)) {
    return c.json({ error: "invalid_params", message: "All params must be valid numbers" }, 400);
  }
  if (riskPct <= 0 || riskPct > 100) {
    return c.json({ error: "invalid_params", message: "risk_pct must be between 0 and 100" }, 400);
  }
  if (entryPrice <= 0 || stopLossPrice <= 0) {
    return c.json({ error: "invalid_params", message: "entry_price and stop_loss_price must be positive" }, 400);
  }
  if (entryPrice === stopLossPrice) {
    return c.json({ error: "invalid_params", message: "entry_price and stop_loss_price must differ" }, 400);
  }

  const riskAmountUsd = accountSize * (riskPct / 100);
  const stopDistancePct = Math.abs(entryPrice - stopLossPrice) / entryPrice;
  const stopDistanceUsd = riskAmountUsd; // how much we're willing to lose

  // Fixed-risk position sizing: position size = risk_amount / stop_distance_pct
  const fixedRiskPositionUsd = riskAmountUsd / stopDistancePct;
  const fixedRiskSizeInAsset = fixedRiskPositionUsd / entryPrice;
  const fixedRiskMarginRequired = fixedRiskPositionUsd / leverage;
  const fixedRiskLeverage = fixedRiskPositionUsd / accountSize;

  // Kelly criterion based on historical trade stats
  let kellyResult = null;
  const trades = db.select({
    realizedPnl: schema.trades.realizedPnl,
    fee: schema.trades.fee,
  }).from(schema.trades)
    .where(eq(schema.trades.agentId, agentId))
    .all();

  if (trades.length >= 10) {
    const netPnls = trades.map(t => t.realizedPnl - t.fee);
    const wins = netPnls.filter(p => p > 0);
    const losses = netPnls.filter(p => p <= 0);
    const winRate = wins.length / netPnls.length;
    const avgWin = wins.length > 0 ? wins.reduce((s, v) => s + v, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, v) => s + v, 0) / losses.length) : 0;

    if (avgLoss > 0) {
      const winLossRatio = avgWin / avgLoss;
      // Kelly formula: f = (win_rate * win_loss_ratio - loss_rate) / win_loss_ratio
      const lossRate = 1 - winRate;
      const kellyFraction = (winRate * winLossRatio - lossRate) / winLossRatio;
      const halfKelly = Math.max(0, kellyFraction / 2); // half-Kelly for safety
      const kellyPositionUsd = halfKelly * accountSize / stopDistancePct;
      const kellySizeInAsset = kellyPositionUsd / entryPrice;

      kellyResult = {
        win_rate_pct: Math.round(winRate * 10000) / 100,
        win_loss_ratio: Math.round(winLossRatio * 100) / 100,
        full_kelly_fraction_pct: Math.round(kellyFraction * 10000) / 100,
        half_kelly_fraction_pct: Math.round(halfKelly * 10000) / 100,
        position_size_usd: Math.round(kellyPositionUsd * 100) / 100,
        size_in_asset: Math.round(kellySizeInAsset * 1e6) / 1e6,
        margin_required: Math.round((kellyPositionUsd / leverage) * 100) / 100,
        note: kellyFraction <= 0
          ? "Kelly is negative — your historical edge is insufficient. Consider not trading or paper trading."
          : "Using half-Kelly for reduced variance. Full Kelly maximizes long-run growth but with extreme drawdowns.",
        trades_used: trades.length,
      };
    }
  }

  const isLong = entryPrice > stopLossPrice;
  const riskRewardExamples = [1.5, 2, 3].map(rr => ({
    rr_ratio: rr,
    take_profit_price: isLong
      ? Math.round((entryPrice + (entryPrice - stopLossPrice) * rr) * 100) / 100
      : Math.round((entryPrice - (stopLossPrice - entryPrice) * rr) * 100) / 100,
    potential_profit_usd: Math.round(riskAmountUsd * rr * 100) / 100,
  }));

  return c.json({
    inputs: {
      account_size: accountSize,
      risk_pct: riskPct,
      risk_amount_usd: Math.round(riskAmountUsd * 100) / 100,
      entry_price: entryPrice,
      stop_loss_price: stopLossPrice,
      leverage,
      direction: isLong ? "long" : "short",
    },
    stop_distance: {
      price_distance: Math.round(Math.abs(entryPrice - stopLossPrice) * 100) / 100,
      pct: Math.round(stopDistancePct * 10000) / 100,
    },
    fixed_risk_sizing: {
      position_size_usd: Math.round(fixedRiskPositionUsd * 100) / 100,
      size_in_asset: Math.round(fixedRiskSizeInAsset * 1e6) / 1e6,
      margin_required: Math.round(fixedRiskMarginRequired * 100) / 100,
      effective_leverage: Math.round(fixedRiskLeverage * 100) / 100,
      max_loss_if_stopped_out: Math.round(riskAmountUsd * 100) / 100,
      pct_of_account: riskPct,
    },
    kelly_sizing: kellyResult ?? {
      note: `Need at least 10 closed trades for Kelly calculation (you have ${trades.length}). Use fixed_risk_sizing for now.`,
    },
    risk_reward_targets: riskRewardExamples,
    risk_guidelines: {
      conservative: "0.5-1% risk per trade — recommended for most agents",
      moderate: "1-2% risk per trade — standard for experienced traders",
      aggressive: "2-5% risk per trade — high risk, use only with strong edge",
      reckless: ">5% per trade — avoid, one losing streak can destroy account",
      your_risk_category:
        riskPct <= 1 ? "conservative" :
        riskPct <= 2 ? "moderate" :
        riskPct <= 5 ? "aggressive" : "reckless",
    },
  });
});

export default app;
