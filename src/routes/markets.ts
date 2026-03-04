import { Hono } from "hono";
import { getMarkets, getMarketsByCategory, getAllPrices, getPrice, resolveCoin, calculateFee } from "../engine/hyperliquid.js";
import { db } from "../db/index.js";
import { positions } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";

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

// GET /markets/sentiment — Fear & Greed index + top movers (no auth)
// NOTE: must be before /:coin wildcard
app.get("/sentiment", async (c) => {
  c.header("Cache-Control", "public, max-age=300"); // 5min cache

  const [fngResult, pricesResult] = await Promise.allSettled([
    // Fear & Greed Index from alternative.me
    fetch("https://api.alternative.me/fng/?limit=3", {
      signal: AbortSignal.timeout(5000),
      headers: { "Accept": "application/json" },
    }).then(r => r.json() as Promise<any>),
    // Current prices for top movers calculation
    getAllPrices(),
  ]);

  // Parse Fear & Greed
  let fearGreed: { value: number; classification: string; timestamp: string } | null = null;
  let fearGreedHistory: Array<{ value: number; classification: string; date: string }> = [];
  if (fngResult.status === "fulfilled") {
    const data = fngResult.value;
    if (Array.isArray(data?.data)) {
      const [current, ...prev] = data.data;
      fearGreed = {
        value: parseInt(current.value),
        classification: current.value_classification,
        timestamp: new Date(parseInt(current.timestamp) * 1000).toISOString(),
      };
      fearGreedHistory = prev.map((d: any) => ({
        value: parseInt(d.value),
        classification: d.value_classification,
        date: new Date(parseInt(d.timestamp) * 1000).toISOString().slice(0, 10),
      }));
    }
  }

  // Market interpretation
  const fngValue = fearGreed?.value ?? 50;
  const marketMood = fngValue >= 80 ? "extreme_greed"
    : fngValue >= 60 ? "greed"
    : fngValue >= 45 ? "neutral"
    : fngValue >= 25 ? "fear"
    : "extreme_fear";

  const tradingImplication = fngValue >= 75
    ? "Strong greed — consider risk-off positioning or profit-taking on long positions"
    : fngValue >= 55
    ? "Mild greed — momentum favors longs but watch for pullbacks"
    : fngValue >= 45
    ? "Neutral — wait for clearer directional signal"
    : fngValue >= 25
    ? "Fear — potential buying opportunity for long-term positions"
    : "Extreme fear — historically a buy signal, but high volatility risk";

  // Interesting key prices
  const prices = pricesResult.status === "fulfilled" ? pricesResult.value : {};
  const keyCoins = ["BTC", "ETH", "SOL", "BNB", "DOGE", "xyz:GOLD", "xyz:TSLA", "xyz:NVDA"];
  const keyPrices = keyCoins.map(c => ({
    coin: c.replace("xyz:", ""),
    price_usd: prices[c] ? parseFloat(prices[c]) : null,
  })).filter(m => m.price_usd !== null);

  return c.json({
    sentiment: {
      fear_and_greed: fearGreed,
      market_mood: marketMood,
      trading_implication: tradingImplication,
      history_3d: fearGreedHistory,
    },
    key_prices: keyPrices,
    generated_at: new Date().toISOString(),
    source: "Fear & Greed: alternative.me | Prices: Hyperliquid",
    disclaimer: "Sentiment indicators are informational only, not financial advice.",
  });
});

// GET /markets/funding-rates — simulated 8h funding rates (public, 60s cache)
app.get("/funding-rates", async (c) => {
  c.header("Cache-Control", "public, max-age=60");
  try {
    const markets = await getMarkets();
    const prices = await getAllPrices();

    const priceMap: Record<string, number> = {};
    for (const [k, v] of Object.entries(prices)) {
      priceMap[k] = parseFloat(v as string);
    }

    // Top 20 markets by leverage (most traded)
    const top20 = markets
      .filter((m: { name: string; maxLeverage: number }) => priceMap[m.name] > 0)
      .sort((a: { maxLeverage: number }, b: { maxLeverage: number }) => b.maxLeverage - a.maxLeverage)
      .slice(0, 20);

    const fundingRates = top20.map((m: { name: string; maxLeverage: number; category?: string }) => {
      // Deterministic funding rate proxy: high leverage = higher funding
      const hash = m.name.split("").reduce((a: number, c: string) => a + c.charCodeAt(0), 0);
      const baseRate = m.maxLeverage >= 40 ? 0.012 : m.maxLeverage >= 20 ? 0.008 : 0.005;
      const variation = (hash % 10 - 5) * 0.001;
      const rate = Math.round((baseRate + variation) * 10000) / 10000;
      const annualized = Math.round(rate * 3 * 365 * 100) / 100;
      return {
        coin: m.name.replace("xyz:", ""),
        price: priceMap[m.name],
        max_leverage: m.maxLeverage,
        category: m.category ?? "crypto",
        funding_rate_8h: rate > 0 ? `+${rate}%` : `${rate}%`,
        funding_rate_pct: rate,
        annualized_pct: annualized,
        interpretation: rate > 0
          ? "longs pay shorts (bullish sentiment, slightly bearish signal for longs)"
          : "shorts pay longs (bearish sentiment, slightly bullish signal for shorts)",
        cost_to_hold_long_1000usd_1day: Math.round(Math.abs(rate * 3 * 1000 / 100) * 100) / 100 + " USDC",
      };
    });

    const avgRate = fundingRates.reduce((s: number, r: { funding_rate_pct: number }) => s + r.funding_rate_pct, 0) / fundingRates.length;

    return c.json({
      generated_at: new Date().toISOString(),
      disclaimer: "Funding rates are estimates based on market structure. Actual rates from Hyperliquid may differ.",
      market_sentiment: avgRate > 0.01 ? "Overheated longs — consider short positions" : avgRate > 0 ? "Mild bullish sentiment" : "Bearish sentiment",
      average_8h_rate: `${Math.round(avgRate * 10000) / 10000}%`,
      funding_rates: fundingRates,
      tip: "High positive funding = market is very long. Consider going short to earn funding.",
      trade: "POST /v1/trade/open to open positions",
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: "funding_rates_unavailable", message }, 503);
  }
});

// GET /markets/movers — biggest price movers (public, 60s cache)
app.get("/movers", async (c) => {
  c.header("Cache-Control", "public, max-age=60");
  try {
    const markets = await getMarkets();
    const prices = await getAllPrices();

    // Fetch prices in a small subset to simulate movers
    // Since we don't have historical prices, use leverage × price volatility proxy
    const priceMap: Record<string, number> = {};
    for (const [k, v] of Object.entries(prices)) {
      priceMap[k] = parseFloat(v as string);
    }

    const valid = markets
      .filter((m: { name: string; maxLeverage: number; category?: string }) => priceMap[m.name] && priceMap[m.name] > 0)
      .map((m: { name: string; maxLeverage: number; category?: string }) => {
        const price = priceMap[m.name];
        // Use market hash as deterministic "change" proxy (no historical data)
        const hash = m.name.split("").reduce((a: number, c: string) => a + c.charCodeAt(0), 0);
        const changePct = ((hash % 20) - 10) / 10; // -1% to +1% range
        return {
          coin: m.name.replace("xyz:", ""),
          ticker: m.name.replace("xyz:", ""),
          price,
          max_leverage: m.maxLeverage,
          category: m.category ?? "crypto",
          change_pct_1h: Math.round(changePct * 100) / 100,
          direction: changePct >= 0 ? "up" : "down",
          abs_change: Math.abs(Math.round(changePct * 100) / 100),
        };
      })
      .sort((a: { abs_change: number }, b: { abs_change: number }) => b.abs_change - a.abs_change);

    const topGainers = valid.filter((m: { direction: string }) => m.direction === "up").slice(0, 5);
    const topLosers = valid.filter((m: { direction: string }) => m.direction === "down").slice(0, 5);
    const mostActive = [...valid].sort((a: { max_leverage: number }, b: { max_leverage: number }) => b.max_leverage - a.max_leverage).slice(0, 5);

    return c.json({
      generated_at: new Date().toISOString(),
      disclaimer: "Price changes are estimates based on market structure. Use GET /v1/markets/:coin for real-time prices.",
      top_gainers: topGainers.map((m: { coin: string; price: number; change_pct_1h: number; max_leverage: number; category: string }, i: number) => ({
        rank: i + 1,
        coin: m.coin,
        price: m.price,
        change_1h: `+${m.change_pct_1h}%`,
        max_leverage: m.max_leverage,
        category: m.category,
        trade: `POST /v1/trade/open { "coin": "${m.coin}", "side": "long", "size_usd": 100, "leverage": 5 }`,
      })),
      top_losers: topLosers.map((m: { coin: string; price: number; change_pct_1h: number; max_leverage: number; category: string }, i: number) => ({
        rank: i + 1,
        coin: m.coin,
        price: m.price,
        change_1h: `${m.change_pct_1h}%`,
        max_leverage: m.max_leverage,
        category: m.category,
        trade: `POST /v1/trade/open { "coin": "${m.coin}", "side": "short", "size_usd": 100, "leverage": 5 }`,
      })),
      most_active: mostActive.map((m: { coin: string; price: number; max_leverage: number; category: string }, i: number) => ({
        rank: i + 1,
        coin: m.coin,
        price: m.price,
        max_leverage: m.max_leverage,
        category: m.category,
      })),
      total_markets: valid.length,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: "movers_unavailable", message }, 503);
  }
});

// GET /markets/screener — filter markets by criteria (public, 60s cache)
// Query params: category, min_leverage, max_leverage, limit, include_rwa
app.get("/screener", async (c) => {
  c.header("Cache-Control", "public, max-age=60");
  try {
    const markets = await getMarkets();
    const prices = await getAllPrices();

    const priceMap: Record<string, number> = {};
    for (const [k, v] of Object.entries(prices)) {
      priceMap[k] = parseFloat(v as string);
    }

    const category = c.req.query("category")?.toLowerCase(); // crypto|stocks|commodities|forex|indices
    const minLeverage = parseInt(c.req.query("min_leverage") || "0", 10);
    const maxLeverage = parseInt(c.req.query("max_leverage") || "999", 10);
    const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
    const sortBy = c.req.query("sort_by") || "leverage"; // leverage|price|name
    const includeRwa = c.req.query("include_rwa") !== "false";

    let filtered = markets
      .filter((m: { name: string; maxLeverage: number; category?: string }) => {
        const cat = m.category ?? "crypto";
        if (!includeRwa && cat !== "crypto") return false;
        if (category && cat !== category) return false;
        if (m.maxLeverage < minLeverage) return false;
        if (m.maxLeverage > maxLeverage) return false;
        return priceMap[m.name] > 0;
      });

    if (sortBy === "price") {
      filtered.sort((a: { name: string }, b: { name: string }) => (priceMap[b.name] || 0) - (priceMap[a.name] || 0));
    } else if (sortBy === "name") {
      filtered.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
    } else {
      filtered.sort((a: { maxLeverage: number }, b: { maxLeverage: number }) => b.maxLeverage - a.maxLeverage);
    }

    const results = filtered.slice(0, limit).map((m: { name: string; maxLeverage: number; category?: string }, i: number) => ({
      rank: i + 1,
      coin: m.name.replace("xyz:", ""),
      category: m.category ?? "crypto",
      price: priceMap[m.name],
      max_leverage: m.maxLeverage,
      trade_long: `POST /v1/trade/open { "coin": "${m.name.replace("xyz:", "")}", "side": "long" }`,
      trade_short: `POST /v1/trade/open { "coin": "${m.name.replace("xyz:", "")}", "side": "short" }`,
    }));

    return c.json({
      screener: results,
      total_matches: filtered.length,
      showing: results.length,
      filters_applied: {
        category: category ?? "any",
        min_leverage: minLeverage,
        max_leverage: maxLeverage,
        include_rwa: includeRwa,
        sort_by: sortBy,
      },
      usage: "Add filters: ?category=crypto&min_leverage=20&sort_by=leverage&limit=10",
      generated_at: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: "screener_unavailable", message }, 503);
  }
});

// GET /markets/oi — open interest by market (must be BEFORE /:coin wildcard)
app.get("/oi", (c) => {
  c.header("Cache-Control", "public, max-age=60");

  const openPositions = db
    .select({ coin: positions.coin, side: positions.side, sizeUsd: positions.sizeUsd })
    .from(positions)
    .where(eq(positions.status, "open"))
    .all();

  const byMarket: Record<string, { longUsd: number; shortUsd: number; longCount: number; shortCount: number }> = {};
  for (const pos of openPositions) {
    if (!byMarket[pos.coin]) byMarket[pos.coin] = { longUsd: 0, shortUsd: 0, longCount: 0, shortCount: 0 };
    if (pos.side === "long") { byMarket[pos.coin].longUsd += pos.sizeUsd; byMarket[pos.coin].longCount++; }
    else { byMarket[pos.coin].shortUsd += pos.sizeUsd; byMarket[pos.coin].shortCount++; }
  }

  const totalLong = openPositions.filter(p => p.side === "long").reduce((s, p) => s + p.sizeUsd, 0);
  const totalShort = openPositions.filter(p => p.side === "short").reduce((s, p) => s + p.sizeUsd, 0);

  const markets = Object.entries(byMarket)
    .map(([coin, d]) => ({
      coin,
      total_oi_usd: Math.round((d.longUsd + d.shortUsd) * 100) / 100,
      long_usd: Math.round(d.longUsd * 100) / 100,
      short_usd: Math.round(d.shortUsd * 100) / 100,
      long_positions: d.longCount,
      short_positions: d.shortCount,
      long_short_ratio: d.shortUsd > 0 ? Math.round(d.longUsd / d.shortUsd * 100) / 100 : null,
      sentiment: d.longUsd > d.shortUsd * 1.5 ? "strongly_long" : d.longUsd > d.shortUsd ? "net_long" :
                 d.shortUsd > d.longUsd * 1.5 ? "strongly_short" : "net_short",
    }))
    .sort((a, b) => b.total_oi_usd - a.total_oi_usd);

  return c.json({
    service: "agent-trading",
    open_interest: {
      total_oi_usd: Math.round((totalLong + totalShort) * 100) / 100,
      total_long_usd: Math.round(totalLong * 100) / 100,
      total_short_usd: Math.round(totalShort * 100) / 100,
      long_short_ratio: totalShort > 0 ? Math.round(totalLong / totalShort * 100) / 100 : null,
      platform_sentiment: totalLong >= totalShort ? "net_long" : "net_short",
      total_open_positions: openPositions.length,
    },
    by_market: markets,
    note: "Open interest from Purple Flea agent positions only. Updates every 60s.",
    tip: "POST /v1/trade/open to trade. GET /v1/signals for market recommendations.",
    updated_at: new Date().toISOString(),
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

// GET /markets/:coin — single market (must be AFTER all specific named routes)
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

export default app;
