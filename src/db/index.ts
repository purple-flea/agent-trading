import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "fs";
import * as schema from "./schema.js";

mkdirSync("data", { recursive: true });
export const sqlite: import("better-sqlite3").Database = new Database("data/trading.db");
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("busy_timeout = 5000");

export const db = drizzle(sqlite, { schema });

const migrations = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, api_key_hash TEXT UNIQUE NOT NULL,
  wallet_agent_id TEXT, max_leverage INTEGER NOT NULL DEFAULT 10,
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
`;

export function runMigrations() {
  sqlite.exec(migrations);
}
