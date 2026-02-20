import { Hono } from "hono";
import { getMarkets, getAllPrices, getPrice, getMarketByName, calculateFee } from "../engine/hyperliquid.js";

const app = new Hono();

// GET /markets — list all available markets
app.get("/", async (c) => {
  const markets = await getMarkets();
  const prices = await getAllPrices();

  const enriched = markets.map(m => ({
    coin: m.name,
    price: prices[m.name] ? parseFloat(prices[m.name]) : null,
    max_leverage: m.maxLeverage,
    size_decimals: m.szDecimals,
    isolated_only: m.onlyIsolated ?? false,
  }));

  // Categorize
  const rwa = enriched.filter(m => ["SPX"].includes(m.coin));
  const major = enriched.filter(m => ["BTC", "ETH", "SOL", "XRP", "DOGE", "LINK", "AVAX", "MATIC", "ARB", "OP"].includes(m.coin));
  const all = enriched;

  return c.json({
    total_markets: enriched.length,
    categories: {
      rwa: rwa,
      major_crypto: major,
    },
    all_markets: all,
    fee_tiers: {
      free: "HL fee + 2 bps",
      pro: "HL fee + 1 bp ($50k+ volume/mo)",
      whale: "HL fee only ($500k+ volume/mo)",
    },
  });
});

// GET /markets/:coin — single market info
app.get("/:coin", async (c) => {
  const coin = c.req.param("coin").toUpperCase();
  const market = await getMarketByName(coin);
  if (!market) return c.json({ error: "market_not_found", coin }, 404);

  const price = await getPrice(coin);

  // Example fees for different sizes
  const feeSamples = [100, 1000, 10000].map(size => ({
    size_usd: size,
    ...calculateFee(size, "free"),
  }));

  return c.json({
    coin,
    price,
    max_leverage: market.maxLeverage,
    size_decimals: market.szDecimals,
    isolated_only: market.onlyIsolated ?? false,
    fee_examples: feeSamples,
  });
});

// GET /markets/:coin/price
app.get("/:coin/price", async (c) => {
  const coin = c.req.param("coin").toUpperCase();
  const price = await getPrice(coin);
  if (!price) return c.json({ error: "no_price", coin }, 404);
  return c.json({ coin, price, timestamp: Date.now() });
});

export default app;
