import { Hono } from "hono";
import { getMarkets, getMarketsByCategory, getAllPrices, getPrice, resolveCoin, calculateFee } from "../engine/hyperliquid.js";

const app = new Hono();

// GET /markets — all markets across both dexes
app.get("/", async (c) => {
  const markets = await getMarkets();
  const prices = await getAllPrices();

  const enriched = markets.map(m => ({
    coin: m.name,
    display_name: m.name.replace("xyz:", ""),
    price: prices[m.name] ? parseFloat(prices[m.name]) : null,
    max_leverage: m.maxLeverage,
    category: m.category,
    dex: m.dex,
  }));

  const crypto = enriched.filter(m => m.category === "crypto");
  const stocks = enriched.filter(m => m.category === "stocks");
  const commodities = enriched.filter(m => m.category === "commodities");
  const indices = enriched.filter(m => m.category === "indices");
  const forex = enriched.filter(m => m.category === "forex");

  return c.json({
    total_markets: enriched.length,
    crypto_markets: crypto.length,
    rwa_markets: stocks.length + commodities.length + indices.length + forex.length,
    categories: {
      stocks: { count: stocks.length, markets: stocks, note: "US & global equities via HIP-3/XYZ" },
      commodities: { count: commodities.length, markets: commodities, note: "Precious metals, energy, industrial" },
      indices: { count: indices.length, markets: indices, note: "Market indices" },
      forex: { count: forex.length, markets: forex, note: "Currency pairs" },
      crypto: { count: crypto.length, note: `${crypto.length} perpetual contracts (use ?include_crypto=true to list)` },
    },
    fee_tiers: {
      free: "HL fee + 2 bps",
      pro: "HL fee + 1 bp ($50k+ volume/mo)",
      whale: "HL fee only ($500k+ volume/mo)",
    },
    use_cases: {
      hedging: "Short TSLA/NVDA to hedge equity exposure",
      commodities_trading: "Go long GOLD/SILVER as inflation hedge",
      index_tracking: "Trade XYZ100 (crypto index) or JP225 (Nikkei)",
      forex: "Trade JPY/EUR with up to 50x leverage",
      crypto: "229 crypto perps with up to 50x leverage",
    },
  });
});

// GET /markets/stocks — equity perps
app.get("/stocks", async (c) => {
  const markets = await getMarketsByCategory("stocks");
  const prices = await getAllPrices();
  return c.json({
    category: "stocks",
    count: markets.length,
    note: "Equity perpetuals via Hyperliquid HIP-3 (XYZ protocol). Trade 24/7, no market hours restriction.",
    markets: markets.map(m => ({
      coin: m.name,
      ticker: m.name.replace("xyz:", ""),
      price: prices[m.name] ? parseFloat(prices[m.name]) : null,
      max_leverage: m.maxLeverage,
      trade: `POST /v1/trade/open { "coin": "${m.name.replace("xyz:", "")}", "side": "long", "size_usd": 100, "leverage": 5 }`,
    })),
  });
});

// GET /markets/commodities
app.get("/commodities", async (c) => {
  const markets = await getMarketsByCategory("commodities");
  const prices = await getAllPrices();
  return c.json({
    category: "commodities",
    count: markets.length,
    note: "Commodity perpetuals — gold, silver, oil, metals, uranium. Hedge inflation or speculate.",
    markets: markets.map(m => ({
      coin: m.name,
      ticker: m.name.replace("xyz:", ""),
      price: prices[m.name] ? parseFloat(prices[m.name]) : null,
      max_leverage: m.maxLeverage,
    })),
  });
});

// GET /markets/rwa — all real-world assets
app.get("/rwa", async (c) => {
  const markets = await getMarkets();
  const prices = await getAllPrices();
  const rwa = markets.filter(m => m.category !== "crypto");
  return c.json({
    category: "real_world_assets",
    count: rwa.length,
    dex: "HIP-3 / XYZ Protocol on Hyperliquid",
    markets: rwa.map(m => ({
      coin: m.name,
      ticker: m.name.replace("xyz:", ""),
      price: prices[m.name] ? parseFloat(prices[m.name]) : null,
      max_leverage: m.maxLeverage,
      category: m.category,
    })),
  });
});

// GET /markets/:coin — single market
app.get("/:coin", async (c) => {
  const coin = c.req.param("coin").toUpperCase();
  const resolved = await resolveCoin(coin);
  if (!resolved) return c.json({ error: "market_not_found", coin, suggestion: "GET /v1/markets for all available" }, 404);

  const price = await getPrice(resolved.canonical);
  const feeSamples = [100, 1000, 10000].map(size => ({ size_usd: size, ...calculateFee(size, "free") }));

  return c.json({
    coin: resolved.canonical,
    ticker: resolved.canonical.replace("xyz:", ""),
    price,
    max_leverage: resolved.market.maxLeverage,
    category: resolved.market.category,
    dex: resolved.dex,
    fee_examples: feeSamples,
    trade_example: {
      long: `POST /v1/trade/open { "coin": "${resolved.canonical.replace("xyz:", "")}", "side": "long", "size_usd": 1000, "leverage": ${Math.min(5, resolved.market.maxLeverage)} }`,
      short: `POST /v1/trade/open { "coin": "${resolved.canonical.replace("xyz:", "")}", "side": "short", "size_usd": 1000, "leverage": ${Math.min(5, resolved.market.maxLeverage)} }`,
    },
  });
});

// GET /markets/:coin/price
app.get("/:coin/price", async (c) => {
  const coin = c.req.param("coin").toUpperCase();
  const resolved = await resolveCoin(coin);
  if (!resolved) return c.json({ error: "no_price", coin }, 404);
  const price = await getPrice(resolved.canonical);
  return c.json({ coin: resolved.canonical, ticker: resolved.canonical.replace("xyz:", ""), price, timestamp: Date.now() });
});

export default app;
