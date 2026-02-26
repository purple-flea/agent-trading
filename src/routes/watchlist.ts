import { Hono } from "hono";
import { randomUUID } from "crypto";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { agentAuth } from "../middleware/auth.js";
import type { AppEnv } from "../types.js";

const app = new Hono<AppEnv>();
app.use("/*", agentAuth);

// ─── GET /watchlist — list saved coins + live prices ───

app.get("/", async (c) => {
  const agentId = c.get("agentId") as string;

  const items = db.select().from(schema.watchlist)
    .where(eq(schema.watchlist.agentId, agentId))
    .all();

  if (items.length === 0) {
    return c.json({
      watchlist: [],
      count: 0,
      tip: "Add coins with POST /v1/watchlist { coin: 'BTC', note?: '...' }",
    });
  }

  // Fetch live prices from Hyperliquid for all coins
  let prices: Record<string, number | null> = {};
  try {
    const hlRes = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
      signal: AbortSignal.timeout(5000),
    });
    if (hlRes.ok) {
      const mids = await hlRes.json() as Record<string, string>;
      for (const [coin, mid] of Object.entries(mids)) {
        prices[coin] = parseFloat(mid);
      }
    }
  } catch {
    // Continue without prices
  }

  return c.json({
    watchlist: items.map(item => ({
      id: item.id,
      coin: item.coin,
      note: item.note ?? null,
      price_usd: prices[item.coin] ?? null,
      added_at: item.createdAt,
      trade: `POST /v1/trade/open { coin: "${item.coin}", side: "long"|"short", size_usd: ..., leverage: ... }`,
    })),
    count: items.length,
    prices_source: "Hyperliquid (real-time mid prices)",
  });
});

// ─── POST /watchlist — add a coin to watchlist ───

app.post("/", async (c) => {
  const agentId = c.get("agentId") as string;
  const body = await c.req.json().catch(() => ({}));
  const coin = (body.coin as string)?.toUpperCase()?.trim();
  const note = (body.note as string)?.slice(0, 200) ?? null;

  if (!coin) {
    return c.json({ error: "missing_coin", message: "Provide { coin: 'BTC' }" }, 400);
  }

  // Check for duplicates
  const existing = db.select().from(schema.watchlist)
    .where(and(
      eq(schema.watchlist.agentId, agentId),
      eq(schema.watchlist.coin, coin),
    )).get();

  if (existing) {
    return c.json({ error: "already_watching", coin, message: `${coin} is already on your watchlist`, id: existing.id }, 400);
  }

  const id = `wl_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  db.insert(schema.watchlist).values({ id, agentId, coin, note }).run();

  return c.json({
    id,
    coin,
    note,
    message: `${coin} added to watchlist`,
    view: "GET /v1/watchlist",
    trade: `POST /v1/trade/open { coin: "${coin}", side: "long", size_usd: 100, leverage: 5 }`,
  }, 201);
});

// ─── DELETE /watchlist/:coin — remove a coin ───

app.delete("/:coin", (c) => {
  const agentId = c.get("agentId") as string;
  const coin = c.req.param("coin").toUpperCase();

  const item = db.select().from(schema.watchlist)
    .where(and(
      eq(schema.watchlist.agentId, agentId),
      eq(schema.watchlist.coin, coin),
    )).get();

  if (!item) {
    return c.json({ error: "not_found", message: `${coin} is not on your watchlist` }, 404);
  }

  db.delete(schema.watchlist)
    .where(and(
      eq(schema.watchlist.agentId, agentId),
      eq(schema.watchlist.coin, coin),
    )).run();

  return c.json({ message: `${coin} removed from watchlist`, coin });
});

// ─── PATCH /watchlist/:coin — update note ───

app.patch("/:coin", async (c) => {
  const agentId = c.get("agentId") as string;
  const coin = c.req.param("coin").toUpperCase();
  const body = await c.req.json().catch(() => ({}));
  const note = (body.note as string)?.slice(0, 200) ?? null;

  const item = db.select().from(schema.watchlist)
    .where(and(
      eq(schema.watchlist.agentId, agentId),
      eq(schema.watchlist.coin, coin),
    )).get();

  if (!item) {
    return c.json({ error: "not_found", message: `${coin} is not on your watchlist` }, 404);
  }

  db.update(schema.watchlist).set({ note }).where(
    and(eq(schema.watchlist.agentId, agentId), eq(schema.watchlist.coin, coin))
  ).run();

  return c.json({ coin, note, message: "Note updated" });
});

export default app;
