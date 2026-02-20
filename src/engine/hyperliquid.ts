/**
 * Hyperliquid integration layer.
 * 
 * For now: read-only (market data, prices).
 * Phase 2: execute trades via master account + agent wallets.
 * 
 * We use the raw REST API for simplicity and to avoid SDK version issues.
 */

const HL_API = "https://api.hyperliquid.xyz";

interface MarketMeta {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated?: boolean;
}

let cachedMeta: { markets: MarketMeta[]; timestamp: number } | null = null;

export async function getMarkets(): Promise<MarketMeta[]> {
  // Cache for 60 seconds
  if (cachedMeta && Date.now() - cachedMeta.timestamp < 60000) {
    return cachedMeta.markets;
  }

  const res = await fetch(`${HL_API}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "meta" }),
  });
  const data = await res.json() as any;
  const markets = data.universe.map((u: any) => ({
    name: u.name,
    szDecimals: u.szDecimals,
    maxLeverage: u.maxLeverage,
    onlyIsolated: u.onlyIsolated,
  }));

  cachedMeta = { markets, timestamp: Date.now() };
  return markets;
}

export async function getAllPrices(): Promise<Record<string, string>> {
  const res = await fetch(`${HL_API}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "allMids" }),
  });
  return await res.json() as Record<string, string>;
}

export async function getPrice(coin: string): Promise<number | null> {
  const prices = await getAllPrices();
  const p = prices[coin];
  return p ? parseFloat(p) : null;
}

export async function getMarketByName(coin: string): Promise<MarketMeta | undefined> {
  const markets = await getMarkets();
  return markets.find(m => m.name.toUpperCase() === coin.toUpperCase());
}

/**
 * Fee structure for our service:
 * - We add a markup on top of Hyperliquid's fees
 * - HL taker fee: 0.035%, HL maker fee: 0.01%
 * - Our markup: 0.02% (2 bps) for free tier, 0.01% for pro, 0% for whale
 * - This is our revenue from trading
 */
export function calculateFee(sizeUsd: number, tier: string): { hlFee: number; ourFee: number; totalFee: number } {
  const hlFeeRate = 0.00035; // taker fee
  const ourFeeRates: Record<string, number> = {
    free: 0.0002,  // 2 bps
    pro: 0.0001,   // 1 bp
    whale: 0,      // 0 bps
  };
  const ourRate = ourFeeRates[tier] ?? 0.0002;
  const hlFee = round2(sizeUsd * hlFeeRate);
  const ourFee = round2(sizeUsd * ourRate);
  return { hlFee, ourFee, totalFee: round2(hlFee + ourFee) };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Simulate a market order fill (Phase 1 — paper trading with real prices).
 * Phase 2 will actually execute on Hyperliquid.
 */
export async function simulateMarketOrder(coin: string, side: "buy" | "sell", sizeUsd: number, leverage: number) {
  const price = await getPrice(coin);
  if (!price) throw new Error(`No price found for ${coin}`);

  const market = await getMarketByName(coin);
  if (!market) throw new Error(`Market ${coin} not found`);

  if (leverage > market.maxLeverage) {
    throw new Error(`Max leverage for ${coin} is ${market.maxLeverage}x`);
  }

  const marginRequired = round2(sizeUsd / leverage);
  const sizeInCoin = sizeUsd / price;

  // Simulate slippage (0.01% for small orders, up to 0.1% for large)
  const slippageBps = Math.min(0.001, 0.0001 * Math.log10(sizeUsd / 100 + 1));
  const fillPrice = side === "buy"
    ? round8(price * (1 + slippageBps))
    : round8(price * (1 - slippageBps));

  // Estimate liquidation price
  const liqDistance = 1 / leverage;
  const liquidationPrice = side === "buy"
    ? round8(fillPrice * (1 - liqDistance + 0.005)) // 0.5% maintenance margin
    : round8(fillPrice * (1 + liqDistance - 0.005));

  return {
    coin,
    side,
    sizeUsd,
    sizeInCoin: round8(sizeInCoin),
    fillPrice,
    leverage,
    marginRequired,
    liquidationPrice,
    currentPrice: price,
  };
}

function round8(n: number): number {
  return Math.round(n * 100000000) / 100000000;
}
