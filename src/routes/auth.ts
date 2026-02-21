import { Hono } from "hono";
import { randomBytes } from "crypto";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq } from "drizzle-orm";
import { hashApiKey, agentAuth } from "../middleware/auth.js";
import { encryptKey } from "../engine/crypto.js";
import { approveBuilderFee } from "../engine/hyperliquid.js";
import type { AppEnv } from "../types.js";

const app = new Hono<AppEnv>();

app.post("/register", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const referralCode = body.referral_code as string | undefined;
  const walletAgentId = body.wallet_agent_id as string | undefined;
  const hlWalletAddress = body.hl_wallet_address as string | undefined;
  const hlSigningKey = body.hl_signing_key as string | undefined;

  // Validate HL wallet address format
  if (hlWalletAddress && !/^0x[0-9a-fA-F]{40}$/.test(hlWalletAddress)) {
    return c.json({ error: "invalid_wallet", message: "hl_wallet_address must be a valid Ethereum address (0x...)" }, 400);
  }

  // Validate signing key format (must start with 0x and be a valid hex private key)
  if (hlSigningKey && !/^0x[0-9a-fA-F]{64}$/.test(hlSigningKey)) {
    return c.json({ error: "invalid_signing_key", message: "hl_signing_key must be a valid 32-byte hex private key (0x...)" }, 400);
  }

  const agentId = `ag_${randomBytes(6).toString("hex")}`;
  const apiKey = `sk_trade_${randomBytes(24).toString("hex")}`;
  const keyHash = hashApiKey(apiKey);
  const myReferralCode = `ref_${randomBytes(4).toString("hex")}`;

  let referrerId: string | null = null;
  if (referralCode) {
    const referrer = db.select().from(schema.agents)
      .where(eq(schema.agents.referralCode, referralCode)).get();
    if (referrer) referrerId = referrer.id;
  }

  // Encrypt signing key if provided
  let encryptedKey: string | null = null;
  if (hlSigningKey) {
    encryptedKey = encryptKey(hlSigningKey);
  }

  // Approve builder fee on Hyperliquid (one-time setup)
  let builderApproved = 0;
  if (hlSigningKey) {
    try {
      await approveBuilderFee(hlSigningKey);
      builderApproved = 1;
    } catch (err: any) {
      // Non-fatal — agent can still register, approval can be retried later
      console.warn(`Builder fee approval failed for ${agentId}: ${err.message}`);
    }
  }

  db.insert(schema.agents).values({
    id: agentId,
    apiKeyHash: keyHash,
    referralCode: myReferralCode,
    referredBy: referrerId,
    walletAgentId: walletAgentId ?? null,
    hlWalletAddress: hlWalletAddress?.toLowerCase() ?? null,
    hlSigningKeyEncrypted: encryptedKey,
    builderApproved,
  }).run();

  return c.json({
    agent_id: agentId,
    api_key: apiKey,
    referral_code: myReferralCode,
    tier: "free",
    hl_wallet: hlWalletAddress ? {
      address: hlWalletAddress.toLowerCase(),
      signing_key_stored: !!hlSigningKey,
      builder_fee_approved: builderApproved === 1,
      execution: hlSigningKey ? "real" : "requires_signing_key",
      onboarding: "Deposit USDC to your Hyperliquid account via https://app.hyperliquid.xyz/join/PF",
    } : {
      message: "No HL wallet connected. Provide hl_wallet_address and hl_signing_key for real execution.",
      onboarding: "1. Create wallet at https://app.hyperliquid.xyz/join/PF  2. Create API Agent Wallet in settings  3. Re-register with hl_wallet_address + hl_signing_key",
    },
    fee_structure: {
      free: "Hyperliquid fee + 2 bps (0.02%) builder fee",
      pro: "Hyperliquid fee + 1 bp (0.01%) — $50k+ monthly volume",
      whale: "Hyperliquid fee only (0 markup) — $500k+ monthly volume",
    },
    referral_commission: "20% of our fee markup from referred agents",
    message: "Store your API key securely — it cannot be recovered. Never share your signing key.",
    next_steps: [
      "Deposit USDC to your HL wallet via https://app.hyperliquid.xyz/join/PF",
      "GET /v1/markets — browse 275+ perpetual markets",
      "POST /v1/trade/open — open a real position on Hyperliquid",
      "GET /v1/trade/positions — view real positions from HL",
    ],
  }, 201);
});

app.get("/account", agentAuth, (c) => {
  const agent = c.get("agent") as typeof schema.agents.$inferSelect;
  return c.json({
    agent_id: agent.id,
    tier: agent.tier,
    max_leverage: agent.maxLeverage,
    max_position_usd: agent.maxPositionUsd,
    total_volume: agent.totalVolume,
    total_fees_paid: agent.totalFeesPaid,
    total_pnl: agent.totalPnl,
    referral_code: agent.referralCode,
    hl_wallet: {
      address: agent.hlWalletAddress,
      connected: !!agent.hlWalletAddress,
      signing_key_stored: !!agent.hlSigningKeyEncrypted,
      builder_fee_approved: agent.builderApproved === 1,
      execution: agent.hlSigningKeyEncrypted ? "real" : "not_configured",
    },
  });
});

export default app;
