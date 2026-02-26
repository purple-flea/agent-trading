import { sqliteTable, text, real, integer, index } from "drizzle-orm/sqlite-core";

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  apiKeyHash: text("api_key_hash").unique().notNull(),
  walletAgentId: text("wallet_agent_id"), // linked universal wallet agent
  hlWalletAddress: text("hl_wallet_address"), // Hyperliquid wallet address (for real execution)
  hlSigningKeyEncrypted: text("hl_signing_key_encrypted"), // AES-256-GCM encrypted signing key
  builderApproved: integer("builder_approved").default(0).notNull(), // 1 if builder fee approved on HL
  maxLeverage: integer("max_leverage").default(10).notNull(),
  maxPositionUsd: real("max_position_usd").default(10000).notNull(),
  totalVolume: real("total_volume").default(0).notNull(),
  totalFeesPaid: real("total_fees_paid").default(0).notNull(),
  totalPnl: real("total_pnl").default(0).notNull(),
  referralCode: text("referral_code").unique().notNull(),
  referredBy: text("referred_by"),
  tier: text("tier").default("free").notNull(), // free, pro, whale
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
  lastActive: integer("last_active"),
});

export const positions = sqliteTable("positions", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  coin: text("coin").notNull(),
  side: text("side").notNull(), // long, short
  sizeUsd: real("size_usd").notNull(),
  entryPrice: real("entry_price").notNull(),
  leverage: integer("leverage").notNull(),
  marginUsed: real("margin_used").notNull(),
  liquidationPrice: real("liquidation_price"),
  unrealizedPnl: real("unrealized_pnl").default(0).notNull(),
  status: text("status").default("open").notNull(), // open, closed, liquidated
  hlOrderId: text("hl_order_id"), // Hyperliquid order ID
  openedAt: integer("opened_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
  closedAt: integer("closed_at"),
}, (table) => [
  index("idx_positions_agent").on(table.agentId),
  index("idx_positions_status").on(table.status),
  index("idx_positions_coin").on(table.coin),
]);

export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  coin: text("coin").notNull(),
  side: text("side").notNull(), // buy, sell
  orderType: text("order_type").notNull(), // market, limit, stop_loss, take_profit
  sizeUsd: real("size_usd").notNull(),
  price: real("price"), // null for market orders
  leverage: integer("leverage").notNull(),
  status: text("status").default("pending").notNull(), // pending, filled, cancelled, failed
  hlOrderId: text("hl_order_id"),
  fillPrice: real("fill_price"),
  fee: real("fee").default(0).notNull(),
  positionId: text("position_id"),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
  filledAt: integer("filled_at"),
}, (table) => [
  index("idx_orders_agent").on(table.agentId),
  index("idx_orders_status").on(table.status),
]);

export const trades = sqliteTable("trades", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  orderId: text("order_id").references(() => orders.id),
  coin: text("coin").notNull(),
  side: text("side").notNull(),
  sizeUsd: real("size_usd").notNull(),
  price: real("price").notNull(),
  fee: real("fee").notNull(),
  realizedPnl: real("realized_pnl").default(0).notNull(),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
}, (table) => [
  index("idx_trades_agent").on(table.agentId),
]);

export const referralEarnings = sqliteTable("referral_earnings", {
  id: text("id").primaryKey(),
  referrerId: text("referrer_id").notNull(),
  referredId: text("referred_id").notNull(),
  feeAmount: real("fee_amount").notNull(),
  commissionAmount: real("commission_amount").notNull(),
  orderId: text("order_id"),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
});

export const referralWithdrawals = sqliteTable("referral_withdrawals", {
  id: text("id").primaryKey(),
  referrerId: text("referrer_id").notNull(),
  amount: real("amount").notNull(),
  address: text("address").notNull(),
  txHash: text("tx_hash"),
  status: text("status").default("pending").notNull(),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
});

// ─── Copy Trading ───

export const copySubscriptions = sqliteTable("copy_subscriptions", {
  id: text("id").primaryKey(),
  followerId: text("follower_id").notNull().references(() => agents.id),
  leaderId: text("leader_id").notNull().references(() => agents.id),
  allocationUsdc: real("allocation_usdc").notNull(),
  maxPositionSize: real("max_position_size"),
  stopLossPct: real("stop_loss_pct"),
  active: integer("active").default(1).notNull(), // 1=active, 0=inactive
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
}, (table) => [
  index("idx_copy_sub_follower").on(table.followerId),
  index("idx_copy_sub_leader").on(table.leaderId),
  index("idx_copy_sub_active").on(table.active),
]);

export const copyTrades = sqliteTable("copy_trades", {
  id: text("id").primaryKey(),
  subscriptionId: text("subscription_id").notNull().references(() => copySubscriptions.id),
  originalPositionId: text("original_position_id").notNull(),
  followerPositionId: text("follower_position_id"),
  status: text("status").default("open").notNull(), // open, closed, failed
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
}, (table) => [
  index("idx_copy_trades_sub").on(table.subscriptionId),
  index("idx_copy_trades_orig").on(table.originalPositionId),
]);

// ─── Trade Journal ───

export const tradeNotes = sqliteTable("trade_notes", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  positionId: text("position_id").references(() => positions.id),
  note: text("note").notNull(), // agent's reasoning / strategy annotation
  tags: text("tags"), // comma-separated tags: "momentum,breakout,earnings"
  sentiment: text("sentiment"), // bullish | bearish | neutral
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
  updatedAt: integer("updated_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
}, (table) => [
  index("idx_notes_agent").on(table.agentId),
  index("idx_notes_position").on(table.positionId),
]);

// ─── Price Alerts ───

export const priceAlerts = sqliteTable("price_alerts", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  coin: text("coin").notNull(),
  direction: text("direction").notNull(), // "above" | "below"
  targetPrice: real("target_price").notNull(),
  note: text("note"),
  active: integer("active").default(1).notNull(), // 1=active, 0=triggered
  triggeredAt: integer("triggered_at"),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
}, (table) => [
  index("idx_alerts_agent").on(table.agentId),
  index("idx_alerts_active").on(table.active),
]);

// ─── Watchlist ───

export const watchlist = sqliteTable("watchlist", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  coin: text("coin").notNull(), // e.g. "BTC", "ETH", "TSLA"
  note: text("note"), // optional agent note
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)).notNull(),
}, (table) => [
  index("idx_watchlist_agent").on(table.agentId),
]);
