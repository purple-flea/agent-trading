import { Hono } from "hono";
import { randomUUID } from "crypto";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq, and, sql } from "drizzle-orm";
import { agentAuth } from "../middleware/auth.js";
import type { AppEnv } from "../types.js";

const app = new Hono<AppEnv>();
app.use("/*", agentAuth);

// Fetch live prices once for alert evaluation
async function fetchMids(): Promise<Record<string, number>> {
  try {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return {};
    const mids = await res.json() as Record<string, string>;
    const prices: Record<string, number> = {};
    for (const [coin, mid] of Object.entries(mids)) {
      prices[coin] = parseFloat(mid);
    }
    return prices;
  } catch {
    return {};
  }
}

// ─── GET /alerts — list alerts, auto-check which ones triggered ───

app.get("/", async (c) => {
  const agentId = c.get("agentId") as string;

  const alerts = db.select().from(schema.priceAlerts)
    .where(eq(schema.priceAlerts.agentId, agentId))
    .all();

  if (alerts.length === 0) {
    return c.json({
      alerts: [],
      triggered: [],
      count: 0,
      tip: "Set alerts with POST /v1/alerts { coin: 'BTC', direction: 'above'|'below', target_price: 100000 }",
    });
  }

  // Fetch live prices to check active alerts
  const activeAlerts = alerts.filter(a => a.active === 1);
  let prices: Record<string, number> = {};
  if (activeAlerts.length > 0) {
    prices = await fetchMids();
  }

  // Auto-trigger alerts that have crossed their threshold
  const nowTs = Math.floor(Date.now() / 1000);
  const justTriggered: string[] = [];

  for (const alert of activeAlerts) {
    const price = prices[alert.coin];
    if (price == null) continue;
    const triggered =
      (alert.direction === "above" && price >= alert.targetPrice) ||
      (alert.direction === "below" && price <= alert.targetPrice);

    if (triggered) {
      db.update(schema.priceAlerts)
        .set({ active: 0, triggeredAt: nowTs })
        .where(eq(schema.priceAlerts.id, alert.id))
        .run();
      alert.active = 0;
      alert.triggeredAt = nowTs;
      justTriggered.push(alert.id);
    }
  }

  // Re-fetch updated state
  const updatedAlerts = db.select().from(schema.priceAlerts)
    .where(eq(schema.priceAlerts.agentId, agentId))
    .all();

  const activeList = updatedAlerts.filter(a => a.active === 1);
  const triggeredList = updatedAlerts.filter(a => a.active === 0);

  return c.json({
    alerts: activeList.map(a => ({
      id: a.id,
      coin: a.coin,
      direction: a.direction,
      target_price: a.targetPrice,
      current_price: prices[a.coin] ?? null,
      distance_pct: prices[a.coin]
        ? parseFloat(((a.targetPrice - prices[a.coin]) / prices[a.coin] * 100).toFixed(2))
        : null,
      note: a.note ?? null,
      created_at: a.createdAt,
    })),
    triggered: triggeredList.map(a => ({
      id: a.id,
      coin: a.coin,
      direction: a.direction,
      target_price: a.targetPrice,
      note: a.note ?? null,
      triggered_at: a.triggeredAt,
    })),
    just_triggered: justTriggered,
    count: activeList.length,
    triggered_count: triggeredList.length,
    prices_source: "Hyperliquid (real-time)",
  });
});

// ─── POST /alerts — create an alert ───

app.post("/", async (c) => {
  const agentId = c.get("agentId") as string;
  const body = await c.req.json().catch(() => ({}));
  const coin = (body.coin as string)?.toUpperCase()?.trim();
  const direction = (body.direction as string)?.toLowerCase()?.trim();
  const targetPrice = parseFloat(body.target_price ?? body.targetPrice);
  const note = (body.note as string)?.slice(0, 200) ?? null;

  if (!coin) {
    return c.json({ error: "missing_coin", message: "Provide { coin: 'BTC' }" }, 400);
  }
  if (direction !== "above" && direction !== "below") {
    return c.json({ error: "invalid_direction", message: "direction must be 'above' or 'below'" }, 400);
  }
  if (isNaN(targetPrice) || targetPrice <= 0) {
    return c.json({ error: "invalid_price", message: "target_price must be a positive number" }, 400);
  }

  // Limit 20 active alerts per agent
  const activeCount = db.select({ count: sql<number>`count(*)` })
    .from(schema.priceAlerts)
    .where(and(eq(schema.priceAlerts.agentId, agentId), eq(schema.priceAlerts.active, 1)))
    .get();

  if ((activeCount?.count ?? 0) >= 20) {
    return c.json({ error: "limit_reached", message: "Maximum 20 active alerts. Delete some first." }, 400);
  }

  const id = `al_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  db.insert(schema.priceAlerts).values({ id, agentId, coin, direction, targetPrice, note }).run();

  // Show current price for context
  const prices = await fetchMids();
  const currentPrice = prices[coin] ?? null;

  return c.json({
    id,
    coin,
    direction,
    target_price: targetPrice,
    current_price: currentPrice,
    distance_pct: currentPrice
      ? parseFloat(((targetPrice - currentPrice) / currentPrice * 100).toFixed(2))
      : null,
    note,
    message: `Alert set: notify when ${coin} goes ${direction} $${targetPrice.toLocaleString()}`,
    check: "GET /v1/alerts to check triggered alerts",
  }, 201);
});

// ─── DELETE /alerts/:id — remove an alert ───

app.delete("/:id", (c) => {
  const agentId = c.get("agentId") as string;
  const alertId = c.req.param("id");

  const alert = db.select().from(schema.priceAlerts)
    .where(and(
      eq(schema.priceAlerts.id, alertId),
      eq(schema.priceAlerts.agentId, agentId),
    )).get();

  if (!alert) {
    return c.json({ error: "not_found", message: "Alert not found" }, 404);
  }

  db.delete(schema.priceAlerts)
    .where(eq(schema.priceAlerts.id, alertId))
    .run();

  return c.json({ message: `Alert ${alertId} deleted`, coin: alert.coin });
});

// ─── DELETE /alerts — clear all triggered alerts ───

app.delete("/", (c) => {
  const agentId = c.get("agentId") as string;

  const result = db.delete(schema.priceAlerts)
    .where(and(
      eq(schema.priceAlerts.agentId, agentId),
      eq(schema.priceAlerts.active, 0),
    )).run();

  return c.json({ message: "Triggered alerts cleared", deleted: result.changes });
});

export default app;
