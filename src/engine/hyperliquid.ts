/**
 * Hyperliquid integration — supports both main dex (229 crypto) and XYZ dex (46 RWA/stocks)
 */

const HL_API = "https://api.hyperliquid.xyz";

interface MarketMeta {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated?: boolean;
  dex: string; // "" = main, "xyz" = HIP-3
  category?: string;
}

// ─── Category classification for XYZ markets ───
const STOCKS = ["TSLA", "NVDA", "GOOGL", "AAPL", "AMZN", "META", "MSFT", "NFLX", "AMD", "PLTR", "COIN", "MSTR", "HOOD", "INTC", "MU", "SNDK", "ORCL", "CRCL", "COST", "LLY", "TSM", "RIVN", "BABA", "SKHX", "GME", "SMSN", "SOFTBANK", "HYUNDAI", "CRWV"];
const COMMODITIES = ["GOLD", "SILVER", "COPPER", "PLATINUM", "PALLADIUM", "URANIUM", "ALUMINIUM", "CL", "NATGAS"];
const INDICES = ["XYZ100", "JP225", "KR200", "DXY", "SPX", "USAR", "URNM"];
const FOREX = ["JPY", "EUR"];

function classifyMarket(name: string): string {
  const clean = name.replace("xyz:", "");
  if (STOCKS.includes(clean)) return "stocks";
  if (COMMODITIES.includes(clean)) return "commodities";
  if (INDICES.includes(clean)) return "indices";
  if (FOREX.includes(clean)) return "forex";
  return "crypto";
}

let cachedMain: { markets: MarketMeta[]; prices: Record<string, string>; ts: number } | null = null;
let cachedXyz: { markets: MarketMeta[]; prices: Record<string, string>; ts: number } | null = null;
const CACHE_TTL = 30000; // 30s

async function fetchDex(dex: string): Promise<{ markets: MarketMeta[]; prices: Record<string, string> }> {
  const [metaRes, priceRes] = await Promise.all([
    fetch(`${HL_API}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "meta", ...(dex ? { dex } : {}) }),
    }),
    fetch(`${HL_API}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "allMids", ...(dex ? { dex } : {}) }),
    }),
  ]);

  const meta = await metaRes.json() as any;
  const prices = await priceRes.json() as Record<string, string>;

  const markets = meta.universe.map((u: any) => ({
    name: u.name,
    szDecimals: u.szDecimals,
    maxLeverage: u.maxLeverage,
    onlyIsolated: u.onlyIsolated,
    dex: dex || "main",
    category: classifyMarket(u.name),
  }));

  return { markets, prices };
}

async function getMainData() {
  if (cachedMain && Date.now() - cachedMain.ts < CACHE_TTL) return cachedMain;
  const data = await fetchDex("");
  cachedMain = { ...data, ts: Date.now() };
  return cachedMain;
}

async function getXyzData() {
  if (cachedXyz && Date.now() - cachedXyz.ts < CACHE_TTL) return cachedXyz;
  const data = await fetchDex("xyz");
  cachedXyz = { ...data, ts: Date.now() };
  return cachedXyz;
}

/** Get all markets from both dexes */
export async function getMarkets(): Promise<MarketMeta[]> {
  const [main, xyz] = await Promise.all([getMainData(), getXyzData()]);
  return [...main.markets, ...xyz.markets];
}

/** Get markets by category */
export async function getMarketsByCategory(category: string): Promise<MarketMeta[]> {
  const all = await getMarkets();
  return all.filter(m => m.category === category);
}

/** Get all prices from both dexes */
export async function getAllPrices(): Promise<Record<string, string>> {
  const [main, xyz] = await Promise.all([getMainData(), getXyzData()]);
  return { ...main.prices, ...xyz.prices };
}

/** Get price for a specific coin (handles xyz: prefix automatically) */
export async function getPrice(coin: string): Promise<number | null> {
  const prices = await getAllPrices();

  // Try exact match first
  if (prices[coin]) return parseFloat(prices[coin]);

  // Try with xyz: prefix (for RWA markets)
  if (prices[`xyz:${coin}`]) return parseFloat(prices[`xyz:${coin}`]);

  // Try without xyz: prefix
  const clean = coin.replace("xyz:", "");
  if (prices[clean]) return parseFloat(prices[clean]);

  return null;
}

/** Resolve a coin name to its canonical form */
export async function resolveCoin(coin: string): Promise<{ canonical: string; dex: string; market: MarketMeta } | null> {
  const all = await getMarkets();
  const upper = coin.toUpperCase();

  // Exact match
  let found = all.find(m => m.name.toUpperCase() === upper);
  if (found) return { canonical: found.name, dex: found.dex, market: found };

  // Try with xyz: prefix
  found = all.find(m => m.name.toUpperCase() === `XYZ:${upper}`);
  if (found) return { canonical: found.name, dex: found.dex, market: found };

  // Try without prefix
  const clean = upper.replace("XYZ:", "");
  found = all.find(m => m.name.toUpperCase() === clean || m.name.toUpperCase() === `XYZ:${clean}`);
  if (found) return { canonical: found.name, dex: found.dex, market: found };

  return null;
}

/** Fee structure */
export function calculateFee(sizeUsd: number, tier: string): { hlFee: number; ourFee: number; totalFee: number } {
  const hlFeeRate = 0.00035;
  const ourFeeRates: Record<string, number> = { free: 0.0002, pro: 0.0001, whale: 0 };
  const ourRate = ourFeeRates[tier] ?? 0.0002;
  return {
    hlFee: round2(sizeUsd * hlFeeRate),
    ourFee: round2(sizeUsd * ourRate),
    totalFee: round2(sizeUsd * (hlFeeRate + ourRate)),
  };
}

/** Simulate a market order fill with real prices */
export async function simulateMarketOrder(coin: string, side: "buy" | "sell", sizeUsd: number, leverage: number) {
  const resolved = await resolveCoin(coin);
  if (!resolved) throw new Error(`Market not found: ${coin}. Try GET /v1/markets to see available markets.`);

  const { canonical, market } = resolved;
  const price = await getPrice(canonical);
  if (!price) throw new Error(`No price available for ${canonical}`);

  if (leverage > market.maxLeverage) {
    throw new Error(`Max leverage for ${canonical} is ${market.maxLeverage}x`);
  }

  const marginRequired = round2(sizeUsd / leverage);
  const sizeInAsset = sizeUsd / price;

  const slippageBps = Math.min(0.001, 0.0001 * Math.log10(sizeUsd / 100 + 1));
  const fillPrice = side === "buy"
    ? round8(price * (1 + slippageBps))
    : round8(price * (1 - slippageBps));

  const liqDistance = 1 / leverage;
  const liquidationPrice = side === "buy"
    ? round8(fillPrice * (1 - liqDistance + 0.005))
    : round8(fillPrice * (1 + liqDistance - 0.005));

  return {
    coin: canonical,
    displayName: canonical.replace("xyz:", ""),
    dex: resolved.dex,
    category: market.category,
    side,
    sizeUsd,
    sizeInAsset: round8(sizeInAsset),
    fillPrice,
    leverage,
    marginRequired,
    liquidationPrice,
    currentPrice: price,
    maxLeverage: market.maxLeverage,
  };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round8(n: number): number { return Math.round(n * 100000000) / 100000000; }
