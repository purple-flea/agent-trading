import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "fs";
import * as schema from "./schema.js";

mkdirSync("data", { recursive: true });
export const sqlite: import("better-sqlite3").Database = new Database("data/trading.db");
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("busy_timeout = 30000");

export const db = drizzle(sqlite, { schema });

const migrations = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, api_key_hash TEXT UNIQUE NOT NULL,
  wallet_agent_id TEXT,
  hl_wallet_address TEXT, hl_signing_key_encrypted TEXT,
  builder_approved INTEGER NOT NULL DEFAULT 0,
  max_leverage INTEGER NOT NULL DEFAULT 10,
  max_position_usd REAL NOT NULL DEFAULT 10000,
  total_volume REAL NOT NULL DEFAULT 0, total_fees_paid REAL NOT NULL DEFAULT 0,
  total_pnl REAL NOT NULL DEFAULT 0, referral_code TEXT UNIQUE NOT NULL,
  referred_by TEXT, tier TEXT NOT NULL DEFAULT 'free',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()), last_active INTEGER
);
CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id),
  coin TEXT NOT NULL, side TEXT NOT NULL, size_usd REAL NOT NULL,
  entry_price REAL NOT NULL, leverage INTEGER NOT NULL,
  margin_used REAL NOT NULL, liquidation_price REAL,
  unrealized_pnl REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open', hl_order_id TEXT,
  opened_at INTEGER NOT NULL DEFAULT (unixepoch()), closed_at INTEGER
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id),
  coin TEXT NOT NULL, side TEXT NOT NULL, order_type TEXT NOT NULL,
  size_usd REAL NOT NULL, price REAL, leverage INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', hl_order_id TEXT,
  fill_price REAL, fee REAL NOT NULL DEFAULT 0, position_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()), filled_at INTEGER
);
CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id),
  order_id TEXT REFERENCES orders(id), coin TEXT NOT NULL,
  side TEXT NOT NULL, size_usd REAL NOT NULL, price REAL NOT NULL,
  fee REAL NOT NULL, realized_pnl REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS referral_earnings (
  id TEXT PRIMARY KEY, referrer_id TEXT NOT NULL, referred_id TEXT NOT NULL,
  fee_amount REAL NOT NULL, commission_amount REAL NOT NULL,
  order_id TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_positions_agent ON positions(agent_id);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_coin ON positions(coin);
CREATE INDEX IF NOT EXISTS idx_orders_agent ON orders(agent_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_trades_agent ON trades(agent_id);
CREATE INDEX IF NOT EXISTS idx_positions_agent_status ON positions(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_trades_agent_created ON trades(agent_id, created_at);
`;

// Incremental migrations for existing databases
const alterMigrations = [
  "ALTER TABLE agents ADD COLUMN hl_wallet_address TEXT",
  "ALTER TABLE agents ADD COLUMN hl_signing_key_encrypted TEXT",
  "ALTER TABLE agents ADD COLUMN builder_approved INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE agents ADD COLUMN generated_wallet INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE agents ADD COLUMN max_daily_loss_usd REAL",
];

export function runMigrations() {
  sqlite.exec(migrations);
  // Run ALTER TABLE migrations (silently ignore if columns already exist)
  for (const sql of alterMigrations) {
    try { sqlite.exec(sql); } catch {}
  }
}

// Auto-migration for referral_withdrawals
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS referral_withdrawals (
    id TEXT PRIMARY KEY,
    referrer_id TEXT NOT NULL,
    amount REAL NOT NULL,
    address TEXT NOT NULL,
    tx_hash TEXT,
    status TEXT NOT NULL DEFAULT "pending",
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
} catch {}

// Auto-migration for copy trading
sqlite.exec(`
CREATE TABLE IF NOT EXISTS copy_subscriptions (
  id TEXT PRIMARY KEY,
  follower_id TEXT NOT NULL REFERENCES agents(id),
  leader_id TEXT NOT NULL REFERENCES agents(id),
  allocation_usdc REAL NOT NULL,
  max_position_size REAL,
  stop_loss_pct REAL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS copy_trades (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES copy_subscriptions(id),
  original_position_id TEXT NOT NULL,
  follower_position_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_copy_sub_follower ON copy_subscriptions(follower_id);
CREATE INDEX IF NOT EXISTS idx_copy_sub_leader ON copy_subscriptions(leader_id);
CREATE INDEX IF NOT EXISTS idx_copy_sub_active ON copy_subscriptions(active);
CREATE INDEX IF NOT EXISTS idx_copy_trades_sub ON copy_trades(subscription_id);
CREATE INDEX IF NOT EXISTS idx_copy_trades_orig ON copy_trades(original_position_id);
`);

// Auto-migration for trade journal
sqlite.exec(`
CREATE TABLE IF NOT EXISTS trade_notes (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  position_id TEXT REFERENCES positions(id),
  note TEXT NOT NULL,
  tags TEXT,
  sentiment TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_notes_agent ON trade_notes(agent_id);
CREATE INDEX IF NOT EXISTS idx_notes_position ON trade_notes(position_id);
`);

// Auto-migration for price alerts
sqlite.exec(`
CREATE TABLE IF NOT EXISTS price_alerts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  coin TEXT NOT NULL,
  direction TEXT NOT NULL,
  target_price REAL NOT NULL,
  note TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  triggered_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_alerts_agent ON price_alerts(agent_id);
CREATE INDEX IF NOT EXISTS idx_alerts_active ON price_alerts(active);
`);

// Auto-migration for watchlist
sqlite.exec(`
CREATE TABLE IF NOT EXISTS watchlist (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  coin TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_watchlist_agent ON watchlist(agent_id);
`);
