import { Hono } from "hono";
import { randomUUID } from "crypto";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq, and, sql, desc } from "drizzle-orm";
import { agentAuth } from "../middleware/auth.js";
import { simulateMarketOrder, calculateFee, getPrice } from "../engine/hyperliquid.js";
import type { AppEnv } from "../types.js";

const app = new Hono<AppEnv>();
app.use("/*", agentAuth);

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// POST /open — open a new position
app.post("/open", async (c) => {
  const agentId = c.get("agentId") as string;
  const agent = c.get("agent") as typeof schema.agents.$inferSelect;
  const body = await c.req.json();

  const { coin, side, size_usd, leverage } = body as {
    coin: string; side: "long" | "short"; size_usd: number; leverage?: number;
  };

  if (!coin || !side || !size_usd) {
    return c.json({ error: "invalid_request", message: "Provide coin, side (long/short), size_usd" }, 400);
  }

  const lev = Math.min(leverage ?? 5, agent.maxLeverage);
  if (size_usd > agent.maxPositionUsd) {
    return c.json({
      error: "position_too_large",
      max_position_usd: agent.maxPositionUsd,
      message: `Max position size is $${agent.maxPositionUsd}. Upgrade tier for higher limits.`,
    }, 400);
  }

  const buySide = side === "long" ? "buy" as const : "sell" as const;

  try {
    const sim = await simulateMarketOrder(coin.toUpperCase(), buySide, size_usd, lev);
    const fees = calculateFee(size_usd, agent.tier);

    // Create order
    const orderId = `ord_${randomUUID().slice(0, 8)}`;
    db.insert(schema.orders).values({
      id: orderId, agentId, coin: coin.toUpperCase(), side: buySide,
      orderType: "market", sizeUsd: size_usd, leverage: lev,
      status: "filled", fillPrice: sim.fillPrice, fee: fees.totalFee,
    }).run();

    // Create position
    const posId = `pos_${randomUUID().slice(0, 8)}`;
    db.insert(schema.positions).values({
      id: posId, agentId, coin: coin.toUpperCase(), side,
      sizeUsd: size_usd, entryPrice: sim.fillPrice, leverage: lev,
      marginUsed: sim.marginRequired, liquidationPrice: sim.liquidationPrice,
      status: "open",
    }).run();

    // Update order with position
    db.update(schema.orders).set({ positionId: posId }).where(eq(schema.orders.id, orderId)).run();

    // Record trade
    const tradeId = `trd_${randomUUID().slice(0, 8)}`;
    db.insert(schema.trades).values({
      id: tradeId, agentId, orderId, coin: coin.toUpperCase(),
      side: buySide, sizeUsd: size_usd, price: sim.fillPrice, fee: fees.totalFee,
    }).run();

    // Update agent stats
    db.update(schema.agents).set({
      totalVolume: sql`${schema.agents.totalVolume} + ${size_usd}`,
      totalFeesPaid: sql`${schema.agents.totalFeesPaid} + ${fees.totalFee}`,
      lastActive: Math.floor(Date.now() / 1000),
    }).where(eq(schema.agents.id, agentId)).run();

    // Referral commission (20% of our fee markup)
    if (agent.referredBy && fees.ourFee > 0) {
      const commission = round2(fees.ourFee * 0.20);
      if (commission >= 0.01) {
        db.insert(schema.referralEarnings).values({
          id: `ref_${randomUUID().slice(0, 8)}`,
          referrerId: agent.referredBy, referredId: agentId,
          feeAmount: fees.ourFee, commissionAmount: commission, orderId,
        }).run();
      }
    }

    return c.json({
      position_id: posId,
      order_id: orderId,
      coin: coin.toUpperCase(),
      side,
      size_usd,
      entry_price: sim.fillPrice,
      leverage: lev,
      margin_used: sim.marginRequired,
      liquidation_price: sim.liquidationPrice,
      fee: fees.totalFee,
      fee_breakdown: { hyperliquid: fees.hlFee, purple_flea: fees.ourFee },
      status: "open",
      note: "Phase 1: paper trading with real-time Hyperliquid prices. Phase 2: live execution.",
    });
  } catch (err: any) {
    return c.json({ error: "trade_failed", message: err.message }, 400);
  }
});

// POST /close — close a position
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

  const currentPrice = await getPrice(position.coin);
  if (!currentPrice) return c.json({ error: "no_price" }, 500);

  // Calculate PnL
  const priceDiff = currentPrice - position.entryPrice;
  const pnlPercent = priceDiff / position.entryPrice;
  const rawPnl = position.side === "long"
    ? position.sizeUsd * pnlPercent
    : position.sizeUsd * (-pnlPercent);
  const leveragedPnl = round2(rawPnl); // PnL is already on the full position size

  const fees = calculateFee(position.sizeUsd, agent.tier);

  // Close position
  db.update(schema.positions).set({
    status: "closed",
    unrealizedPnl: leveragedPnl,
    closedAt: Math.floor(Date.now() / 1000),
  }).where(eq(schema.positions.id, position_id)).run();

  // Record closing order
  const closeSide = position.side === "long" ? "sell" : "buy";
  const orderId = `ord_${randomUUID().slice(0, 8)}`;
  db.insert(schema.orders).values({
    id: orderId, agentId, coin: position.coin, side: closeSide,
    orderType: "market", sizeUsd: position.sizeUsd, leverage: position.leverage,
    status: "filled", fillPrice: currentPrice, fee: fees.totalFee,
    positionId: position_id,
  }).run();

  // Record trade
  db.insert(schema.trades).values({
    id: `trd_${randomUUID().slice(0, 8)}`, agentId, orderId,
    coin: position.coin, side: closeSide, sizeUsd: position.sizeUsd,
    price: currentPrice, fee: fees.totalFee, realizedPnl: leveragedPnl,
  }).run();

  // Update agent stats
  db.update(schema.agents).set({
    totalVolume: sql`${schema.agents.totalVolume} + ${position.sizeUsd}`,
    totalFeesPaid: sql`${schema.agents.totalFeesPaid} + ${fees.totalFee}`,
    totalPnl: sql`${schema.agents.totalPnl} + ${leveragedPnl}`,
    lastActive: Math.floor(Date.now() / 1000),
  }).where(eq(schema.agents.id, agentId)).run();

  return c.json({
    position_id,
    coin: position.coin,
    side: position.side,
    entry_price: position.entryPrice,
    exit_price: currentPrice,
    size_usd: position.sizeUsd,
    leverage: position.leverage,
    pnl: leveragedPnl,
    pnl_percent: round2(pnlPercent * 100),
    fee: fees.totalFee,
    status: "closed",
  });
});

// GET /positions — all open positions
app.get("/positions", agentAuth, async (c) => {
  const agentId = c.get("agentId") as string;
  const openOnly = c.req.query("status") !== "all";

  const query = openOnly
    ? db.select().from(schema.positions).where(and(
        eq(schema.positions.agentId, agentId),
        eq(schema.positions.status, "open"),
      )).all()
    : db.select().from(schema.positions).where(eq(schema.positions.agentId, agentId))
        .orderBy(desc(schema.positions.openedAt)).limit(50).all();

  // Enrich with current prices
  const enriched = await Promise.all(query.map(async (p) => {
    const currentPrice = await getPrice(p.coin);
    let unrealizedPnl = 0;
    if (currentPrice && p.status === "open") {
      const priceDiff = currentPrice - p.entryPrice;
      const pnlPercent = priceDiff / p.entryPrice;
      unrealizedPnl = p.side === "long"
        ? round2(p.sizeUsd * pnlPercent)
        : round2(p.sizeUsd * (-pnlPercent));
    }
    return {
      ...p,
      current_price: currentPrice,
      unrealized_pnl: p.status === "open" ? unrealizedPnl : p.unrealizedPnl,
    };
  }));

  return c.json({ positions: enriched, count: enriched.length });
});

// GET /history — trade history
app.get("/history", agentAuth, (c) => {
  const agentId = c.get("agentId") as string;
  const limit = parseInt(c.req.query("limit") ?? "50");

  const trades = db.select().from(schema.trades)
    .where(eq(schema.trades.agentId, agentId))
    .orderBy(desc(schema.trades.createdAt))
    .limit(limit).all();

  return c.json({ trades, count: trades.length });
});

export default app;
