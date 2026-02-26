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

// GET /markets/signals — top trading opportunities (no auth required)
// Uses a simple momentum proxy: RWA markets with >10x leverage sorted by category interest
app.get("/signals", async (c) => {
  try {
    const markets = await getMarkets();
    const prices = await getAllPrices();

    // Score each market: leverage * price_not_null bonus
    const scored = markets
      .filter(m => prices[m.name] && parseFloat(prices[m.name]) > 0)
      .map(m => {
        const price = parseFloat(prices[m.name]);
        // Simple heuristic: higher leverage = more volatile = more opportunities
        // Separate crypto vs RWA for balance
        const isRwa = m.category !== "crypto";
        return {
          coin: m.name,
          ticker: m.name.replace("xyz:", ""),
          price,
          max_leverage: m.maxLeverage,
          category: m.category ?? "crypto",
          is_rwa: isRwa,
          // Score: leverage + category bonus for RWA (underutilized opportunity)
          score: m.maxLeverage + (isRwa ? 5 : 0),
        };
      });

    // Top 5 crypto by leverage
    const topCrypto = scored
      .filter(m => !m.is_rwa)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((m, i) => ({
        rank: i + 1,
        coin: m.coin,
        ticker: m.ticker,
        price: m.price,
        max_leverage: m.max_leverage,
        category: m.category,
        suggested_direction: "long",  // Most crypto maintains bullish bias in perpetuals
        rationale: `High leverage (${m.max_leverage}x) offers efficient capital use for momentum plays`,
        example: `POST /v1/trade/open { "coin": "${m.ticker}", "side": "long", "size_usd": 100, "leverage": ${Math.min(5, m.max_leverage)} }`,
      }));

    // Top 5 RWA (stocks/commodities/indices/forex)
    const topRwa = scored
      .filter(m => m.is_rwa)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((m, i) => ({
        rank: i + 1,
        coin: m.coin,
        ticker: m.ticker,
        price: m.price,
        max_leverage: m.max_leverage,
        category: m.category,
        suggested_direction: m.category === "forex" ? "short" : "long",
        rationale: `RWA perp — trade ${m.ticker} 24/7 without traditional market hours restrictions`,
        example: `POST /v1/trade/open { "coin": "${m.ticker}", "side": "long", "size_usd": 100, "leverage": ${Math.min(5, m.max_leverage)} }`,
      }));

    return c.json({
      generated_at: new Date().toISOString(),
      disclaimer: "Signals based on leverage availability and market structure. Not financial advice.",
      top_crypto: topCrypto,
      top_rwa: topRwa,
      total_markets_analyzed: scored.length,
      tip: "Use GET /v1/markets/:coin for detailed market info before trading",
    });
  } catch (err: any) {
    return c.json({ error: "signals_unavailable", message: err.message }, 503);
  }
});

// GET /markets/multi-price?coins=BTC,ETH,SOL — batch price lookup (no auth)
// NOTE: must be before /:coin wildcard
app.get("/multi-price", async (c) => {
  const coinsParam = c.req.query("coins") || "";
  if (!coinsParam) {
    return c.json({
      error: "missing_coins",
      message: "Provide ?coins=BTC,ETH,SOL (comma-separated, max 20)",
      example: "GET /v1/markets/multi-price?coins=BTC,ETH,SOL,TSLA,GOLD",
    }, 400);
  }

  const requestedCoins = coinsParam.split(",").map(s => s.trim().toUpperCase()).slice(0, 20);
  const allPrices = await getAllPrices();

  const results = await Promise.all(requestedCoins.map(async (rawCoin) => {
    const resolved = await resolveCoin(rawCoin).catch(() => null);
    if (!resolved) return { coin: rawCoin, error: "not_found" };
    const priceStr = allPrices[resolved.canonical];
    return {
      coin: resolved.canonical,
      ticker: resolved.canonical.replace("xyz:", ""),
      price: priceStr ? parseFloat(priceStr) : null,
      category: resolved.market.category,
      max_leverage: resolved.market.maxLeverage,
    };
  }));

  const found = results.filter(r => !("error" in r));
  const notFound = results.filter(r => "error" in r).map(r => (r as any).coin);

  c.header("Cache-Control", "public, max-age=5");
  return c.json({
    prices: found,
    ...(notFound.length > 0 ? { not_found: notFound } : {}),
    count: found.length,
    timestamp: new Date().toISOString(),
  });
});

// GET /markets/summary — quick market conditions overview (no auth)
// NOTE: must be before /:coin wildcard
app.get("/summary", async (c) => {
  try {
    const markets = await getMarkets();
    const prices = await getAllPrices();

    const cryptoMarkets = markets.filter(m => m.category === "crypto");
    const rwaMarkets = markets.filter(m => m.category !== "crypto");

    // Spot-check key markets
    const keyMarketsToCheck = ["BTC", "ETH", "SOL", "xyz:TSLA", "xyz:GOLD", "xyz:NVDA"];
    const snapshots = keyMarketsToCheck.map(coin => ({
      ticker: coin.replace("xyz:", ""),
      price: prices[coin] ? parseFloat(prices[coin]) : null,
    })).filter(m => m.price !== null);

    return c.json({
      as_of: new Date().toISOString(),
      total_markets: markets.length,
      crypto_markets: cryptoMarkets.length,
      rwa_markets: rwaMarkets.length,
      key_prices: snapshots,
      note: "Full market list at GET /v1/markets. Individual prices at GET /v1/markets/:coin/price",
      signals: "GET /v1/markets/signals for top trading opportunities",
    });
  } catch (err: any) {
    return c.json({ error: "summary_unavailable", message: err.message }, 503);
  }
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
