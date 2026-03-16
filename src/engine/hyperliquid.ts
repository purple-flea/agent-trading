/**
 * Hyperliquid integration — real execution via SDK signing utilities.
 * Supports both main dex (229 crypto) and XYZ dex (46 RWA/stocks).
 */
import { ethers } from "ethers";
import {
  signL1Action,
  signUserSignedAction,
  orderToWire,
  orderWireToAction,
  floatToWire,
  removeTrailingZeros,
} from "hyperliquid";

const HL_API = "https://api.hyperliquid.xyz";

// ─── Builder fee configuration ───
export const TREASURY_ADDRESS = "0x632881b5f5384e872d8b701dd23f08e63a52faee";

// Builder fee in tenths of basis points: 20 = 2 bps, 10 = 1 bp, 0 = none
const BUILDER_FEE_TENTHS_BPS: Record<string, number> = { free: 20, pro: 10, whale: 0 };

// XYZ (HIP-3) dex index from perpDexs API — asset offset = 100000 + 1*10000 = 110000
const XYZ_ASSET_OFFSET = 110000;

// Default slippage for market orders (0.5%)
const MARKET_SLIPPAGE = 0.005;

// ─── Types ───

interface MarketMeta {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated?: boolean;
  dex: string; // "main" or "xyz"
  category?: string;
}

export interface OrderResult {
  coin: string;
  displayName: string;
  dex: string;
  category?: string;
  side: "buy" | "sell";
  sizeUsd: number;
  sizeInAsset: number;
  fillPrice: number;
  avgPrice: number;
  leverage: number;
  marginRequired: number;
  liquidationPrice: number | null;
  currentPrice: number;
  maxLeverage: number;
  hlOrderId: number;
  hlFills: { px: string; sz: string; fee: string; builderFee?: string }[];
}

export interface HlPosition {
  coin: string;
  szi: string;
  entryPx: string;
  unrealizedPnl: string;
  liquidationPx: string;
  marginUsed: string;
  leverage: number;
  positionValue: string;
  returnOnEquity: string;
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

// ─── Market data cache ───

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
  if (prices[coin]) return parseFloat(prices[coin]);
  if (prices[`xyz:${coin}`]) return parseFloat(prices[`xyz:${coin}`]);
  const clean = coin.replace("xyz:", "");
  if (prices[clean]) return parseFloat(prices[clean]);
  return null;
}

/** Resolve a coin name to its canonical form */
export async function resolveCoin(coin: string): Promise<{ canonical: string; dex: string; market: MarketMeta } | null> {
  const all = await getMarkets();
  const upper = coin.toUpperCase();

  let found = all.find(m => m.name.toUpperCase() === upper);
  if (found) return { canonical: found.name, dex: found.dex, market: found };

  found = all.find(m => m.name.toUpperCase() === `XYZ:${upper}`);
  if (found) return { canonical: found.name, dex: found.dex, market: found };

  const clean = upper.replace("XYZ:", "");
  found = all.find(m => m.name.toUpperCase() === clean || m.name.toUpperCase() === `XYZ:${clean}`);
  if (found) return { canonical: found.name, dex: found.dex, market: found };

  return null;
}

/** Fee structure — what WE charge (builder fee + HL fee estimate) */
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

// ─── Asset index resolution ───

/** Get HL asset index for order wire format */
async function getAssetIndex(canonicalName: string, dex: string): Promise<number> {
  if (dex === "xyz") {
    const xyzData = await getXyzData();
    const idx = xyzData.markets.findIndex(m => m.name === canonicalName);
    if (idx === -1) throw new Error(`XYZ asset not found: ${canonicalName}`);
    return XYZ_ASSET_OFFSET + idx;
  }
  // Main dex
  const mainData = await getMainData();
  const idx = mainData.markets.findIndex(m => m.name === canonicalName);
  if (idx === -1) throw new Error(`Main dex asset not found: ${canonicalName}`);
  return idx;
}

// ─── Price formatting ───

function formatPrice(price: number): string {
  return floatToWire(price);
}

function formatSize(size: number, szDecimals: number): string {
  const rounded = Math.round(size * Math.pow(10, szDecimals)) / Math.pow(10, szDecimals);
  return removeTrailingZeros(rounded.toFixed(szDecimals));
}

// ─── Order execution ───

/** Set leverage for an asset on the agent's HL account */
async function setLeverage(
  wallet: ethers.Wallet,
  assetIndex: number,
  leverage: number,
  isCross: boolean = true,
): Promise<void> {
  const action = {
    type: "updateLeverage",
    asset: assetIndex,
    isCross,
    leverage,
  };
  const nonce = Date.now();
  const signature = await signL1Action(wallet, action, null, nonce, true);
  await fetch(`${HL_API}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, nonce, signature, vaultAddress: null }),
  });
}

/** Submit a real market order to Hyperliquid */
export async function submitMarketOrder(
  signingKey: string,
  walletAddress: string,
  coin: string,
  isBuy: boolean,
  sizeUsd: number,
  leverage: number,
  tier: string,
): Promise<OrderResult> {
  const resolved = await resolveCoin(coin);
  if (!resolved) throw new Error(`Market not found: ${coin}. Try GET /v1/markets to see available markets.`);

  const { canonical, dex, market } = resolved;
  const price = await getPrice(canonical);
  if (!price) throw new Error(`No price available for ${canonical}`);

  if (leverage > market.maxLeverage) {
    throw new Error(`Max leverage for ${canonical} is ${market.maxLeverage}x`);
  }

  const sizeInAsset = sizeUsd / price;
  const formattedSize = formatSize(sizeInAsset, market.szDecimals);
  const actualSize = parseFloat(formattedSize);
  if (actualSize <= 0) throw new Error(`Position size too small for ${canonical} (min size: ${Math.pow(10, -market.szDecimals)} units)`);

  // Aggressive IoC price with slippage
  const slippagePrice = isBuy
    ? price * (1 + MARKET_SLIPPAGE)
    : price * (1 - MARKET_SLIPPAGE);

  const assetIndex = await getAssetIndex(canonical, dex);
  const wallet = new ethers.Wallet(signingKey);

  // Determine if this is an agent wallet (signing key != master wallet)
  const derivedAddress = wallet.address.toLowerCase();
  const isAgentWallet = derivedAddress !== walletAddress.toLowerCase();

  // Set leverage before order
  await setLeverage(wallet, assetIndex, leverage);

  // Build order wire
  const orderWire = orderToWire({
    coin: canonical,
    is_buy: isBuy,
    sz: formattedSize,
    limit_px: formatPrice(slippagePrice),
    order_type: { limit: { tif: "Ioc" as const } },
    reduce_only: false,
  } as any, assetIndex);

  // Attach builder fee (our revenue)
  const builderFeeTenths = BUILDER_FEE_TENTHS_BPS[tier] ?? 20;
  const builder = builderFeeTenths > 0
    ? { address: TREASURY_ADDRESS, fee: builderFeeTenths }
    : undefined;

  const action = orderWireToAction([orderWire], "na", builder);
  const nonce = Date.now();
  const signature = await signL1Action(wallet, action, isAgentWallet ? null : null, nonce, true);

  const res = await fetch(`${HL_API}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, nonce, signature, vaultAddress: null }),
  });

  const result = await res.json() as any;

  // Parse response
  if (result.status === "err") {
    throw new Error(`Hyperliquid order rejected: ${result.response || JSON.stringify(result)}`);
  }

  const statuses = result?.response?.data?.statuses;
  if (!statuses || statuses.length === 0) {
    throw new Error(`Unexpected HL response: ${JSON.stringify(result)}`);
  }

  const status = statuses[0];
  if (status.error) {
    throw new Error(`Order error: ${status.error}`);
  }

  // Extract fill info
  const filled = status.filled;
  if (!filled) {
    throw new Error(`Order not filled (may have been placed as resting). Response: ${JSON.stringify(status)}`);
  }

  const avgPx = parseFloat(filled.avgPx);
  const totalSz = parseFloat(filled.totalSz);
  const oid = filled.oid;

  // Fetch fills for detailed breakdown
  const fills = await getUserFills(walletAddress, oid, dex);

  // Estimate liquidation price
  const liqDistance = 1 / leverage;
  const liquidationPrice = isBuy
    ? round8(avgPx * (1 - liqDistance + 0.005))
    : round8(avgPx * (1 + liqDistance - 0.005));

  return {
    coin: canonical,
    displayName: canonical.replace("xyz:", ""),
    dex,
    category: market.category,
    side: isBuy ? "buy" : "sell",
    sizeUsd: round2(totalSz * avgPx),
    sizeInAsset: totalSz,
    fillPrice: avgPx,
    avgPrice: avgPx,
    leverage,
    marginRequired: round2((totalSz * avgPx) / leverage),
    liquidationPrice,
    currentPrice: price,
    maxLeverage: market.maxLeverage,
    hlOrderId: oid,
    hlFills: fills,
  };
}

/** Submit a close order (reduce-only) to Hyperliquid */
export async function submitCloseOrder(
  signingKey: string,
  walletAddress: string,
  coin: string,
  tier: string,
): Promise<{ avgPrice: number; totalSz: number; hlOrderId: number; fills: any[] }> {
  const resolved = await resolveCoin(coin);
  if (!resolved) throw new Error(`Market not found: ${coin}`);

  const { canonical, dex, market } = resolved;

  // Get the user's current position to determine size and direction
  const positions = await getHlPositions(walletAddress, dex === "xyz" ? "xyz" : undefined);
  const pos = positions.find(p => p.coin === canonical || p.coin === canonical.replace("xyz:", ""));
  if (!pos || parseFloat(pos.szi) === 0) {
    throw new Error(`No open position for ${canonical} on Hyperliquid`);
  }

  const posSize = parseFloat(pos.szi);
  const isBuy = posSize < 0; // Buy to close short, sell to close long
  const closeSize = Math.abs(posSize);

  const price = await getPrice(canonical);
  if (!price) throw new Error(`No price for ${canonical}`);

  const slippagePrice = isBuy
    ? price * (1 + MARKET_SLIPPAGE)
    : price * (1 - MARKET_SLIPPAGE);

  const assetIndex = await getAssetIndex(canonical, dex);
  const wallet = new ethers.Wallet(signingKey);

  const orderWire = orderToWire({
    coin: canonical,
    is_buy: isBuy,
    sz: formatSize(closeSize, market.szDecimals),
    limit_px: formatPrice(slippagePrice),
    order_type: { limit: { tif: "Ioc" as const } },
    reduce_only: true,
  } as any, assetIndex);

  const builderFeeTenths = BUILDER_FEE_TENTHS_BPS[tier] ?? 20;
  const builder = builderFeeTenths > 0
    ? { address: TREASURY_ADDRESS, fee: builderFeeTenths }
    : undefined;

  const action = orderWireToAction([orderWire], "na", builder);
  const nonce = Date.now();
  const signature = await signL1Action(wallet, action, null, nonce, true);

  const res = await fetch(`${HL_API}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, nonce, signature, vaultAddress: null }),
  });

  const result = await res.json() as any;

  if (result.status === "err") {
    throw new Error(`Hyperliquid close rejected: ${result.response || JSON.stringify(result)}`);
  }

  const statuses = result?.response?.data?.statuses;
  if (!statuses?.[0]?.filled) {
    throw new Error(`Close order not filled: ${JSON.stringify(result)}`);
  }

  const filled = statuses[0].filled;
  const fills = await getUserFills(walletAddress, filled.oid, dex);

  return {
    avgPrice: parseFloat(filled.avgPx),
    totalSz: parseFloat(filled.totalSz),
    hlOrderId: filled.oid,
    fills,
  };
}

// ─── Builder fee approval ───

/** Approve our builder fee on the agent's HL account (one-time) */
export async function approveBuilderFee(signingKey: string): Promise<void> {
  const wallet = new ethers.Wallet(signingKey);

  // Approve 2 bps (0.02%) — covers all tiers
  const action = {
    type: "approveBuilderFee" as const,
    hyperliquidChain: "Mainnet" as const,
    signatureChainId: "0xa4b1" as const,
    maxFeeRate: "0.02%",
    builder: TREASURY_ADDRESS.toLowerCase(),
    nonce: Date.now(),
  };

  const signature = await signUserSignedAction(
    wallet as any,
    action,
    [
      { name: "hyperliquidChain", type: "string" },
      { name: "maxFeeRate", type: "string" },
      { name: "builder", type: "address" },
      { name: "nonce", type: "uint64" },
    ],
    "HyperliquidTransaction:ApproveBuilderFee",
    true,
  );

  const res = await fetch(`${HL_API}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, nonce: action.nonce, signature }),
  });

  const result = await res.json() as any;
  if (result.status === "err") {
    throw new Error(`Builder fee approval failed: ${result.response || JSON.stringify(result)}`);
  }
}

// ─── Position queries ───

/** Get real positions from Hyperliquid clearinghouse */
export async function getHlPositions(walletAddress: string, dex?: string): Promise<HlPosition[]> {
  const body: any = { type: "clearinghouseState", user: walletAddress };
  if (dex) body.dex = dex;

  const res = await fetch(`${HL_API}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const state = await res.json() as any;
  if (!state?.assetPositions) return [];

  return state.assetPositions
    .filter((ap: any) => parseFloat(ap.position.szi) !== 0)
    .map((ap: any) => ({
      coin: ap.position.coin,
      szi: ap.position.szi,
      entryPx: ap.position.entryPx,
      unrealizedPnl: ap.position.unrealizedPnl,
      liquidationPx: ap.position.liquidationPx || null,
      marginUsed: ap.position.marginUsed,
      leverage: ap.position.leverage?.value ?? 1,
      positionValue: ap.position.positionValue,
      returnOnEquity: ap.position.returnOnEquity,
    }));
}

/** Get all positions across both dexes */
export async function getAllHlPositions(walletAddress: string): Promise<HlPosition[]> {
  const [main, xyz] = await Promise.all([
    getHlPositions(walletAddress),
    getHlPositions(walletAddress, "xyz"),
  ]);
  return [...main, ...xyz];
}

/** Get user fills for an order */
async function getUserFills(walletAddress: string, oid: number, dex?: string): Promise<any[]> {
  try {
    const body: any = { type: "userFills", user: walletAddress };
    if (dex === "xyz") body.dex = "xyz";

    const res = await fetch(`${HL_API}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const fills = await res.json() as any[];
    return (fills || []).filter((f: any) => f.oid === oid).map((f: any) => ({
      px: f.px,
      sz: f.sz,
      fee: f.fee,
      builderFee: f.builderFee,
    }));
  } catch {
    return [];
  }
}

// ─── Order book ───

export interface OrderBookLevel {
  price: number;
  size: number;
  total: number; // cumulative size
  notional: number; // price × size in USD
}

export interface OrderBook {
  coin: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  spread: number;
  spreadPct: number;
  midPrice: number;
  timestamp: number;
}

/** Fetch L2 order book from Hyperliquid */
export async function getOrderBook(coin: string, depth: number = 20): Promise<OrderBook | null> {
  const resolved = await resolveCoin(coin);
  if (!resolved) return null;

  const body: any = { type: "l2Book", coin: resolved.canonical };
  if (resolved.dex === "xyz") body.dex = "xyz";

  const res = await fetch(`${HL_API}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json() as any;
  if (!data?.levels || data.levels.length < 2) return null;

  const rawBids: Array<{ px: string; sz: string; n: number }> = data.levels[0] ?? [];
  const rawAsks: Array<{ px: string; sz: string; n: number }> = data.levels[1] ?? [];

  const mapLevels = (levels: typeof rawBids): OrderBookLevel[] => {
    let cumulative = 0;
    return levels.slice(0, depth).map(l => {
      const price = parseFloat(l.px);
      const size = parseFloat(l.sz);
      cumulative += size;
      return {
        price,
        size,
        total: round8(cumulative),
        notional: round2(price * size),
      };
    });
  };

  const bids = mapLevels(rawBids);
  const asks = mapLevels(rawAsks);

  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 0;
  const midPrice = bestBid && bestAsk ? round8((bestBid + bestAsk) / 2) : 0;
  const spread = bestAsk && bestBid ? round8(bestAsk - bestBid) : 0;
  const spreadPct = midPrice > 0 ? round8((spread / midPrice) * 100) : 0;

  return {
    coin: resolved.canonical,
    bids,
    asks,
    spread,
    spreadPct,
    midPrice,
    timestamp: Date.now(),
  };
}

// ─── Utilities ───

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round8(n: number): number { return Math.round(n * 100000000) / 100000000; }
