import { Hono } from "hono";
import { randomBytes } from "crypto";
import { Wallet } from "ethers";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq } from "drizzle-orm";
import { hashApiKey, agentAuth } from "../middleware/auth.js";
import { encryptKey, encryptKeyCbc, decryptKeyCbc } from "../engine/crypto.js";
import { approveBuilderFee } from "../engine/hyperliquid.js";
import type { AppEnv } from "../types.js";

const app = new Hono<AppEnv>();

app.post("/register", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const referralCode = body.referral_code as string | undefined;
  const walletAgentId = body.wallet_agent_id as string | undefined;
  const hlWalletAddress = body.hl_wallet_address as string | undefined;
  const hlSigningKey = body.hl_signing_key as string | undefined;

  // Validate HL wallet address format if provided
  if (hlWalletAddress && !/^0x[0-9a-fA-F]{40}$/.test(hlWalletAddress)) {
    return c.json({ error: "invalid_wallet", message: "hl_wallet_address must be a valid Ethereum address (0x...)" }, 400);
  }

  // Validate signing key format if provided (must start with 0x and be a valid hex private key)
  if (hlSigningKey && !/^0x[0-9a-fA-F]{64}$/.test(hlSigningKey)) {
    return c.json({ error: "invalid_signing_key", message: "hl_signing_key must be a valid 32-byte hex private key (0x...)" }, 400);
  }

  const agentId = `ag_${randomBytes(6).toString("hex")}`;
  const apiKey = `sk_trade_${randomBytes(24).toString("hex")}`;
  const keyHash = hashApiKey(apiKey);
  const myReferralCode = `ref_${randomBytes(4).toString("hex")}`;

  // Prevent referral chain gaming: an agent who was themselves referred cannot
  // act as a referrer (depth limit of 1 prevents circular self-referral schemes).
  let referrerId: string | null = null;
  if (referralCode) {
    const referrer = db.select().from(schema.agents)
      .where(eq(schema.agents.referralCode, referralCode)).get();
    if (referrer && referrer.referredBy === null) {
      referrerId = referrer.id;
    }
  }

  let finalAddress: string;
  let encryptedKey: string;
  let isGenerated = false;

  if (hlWalletAddress && hlSigningKey) {
    // Agent supplied their own wallet — use GCM encryption (requires ENCRYPTION_KEY env)
    finalAddress = hlWalletAddress.toLowerCase();
    encryptedKey = encryptKey(hlSigningKey);
  } else if (hlSigningKey && !hlWalletAddress) {
    // Signing key without address is not useful — derive address from key
    const wallet = new Wallet(hlSigningKey);
    finalAddress = wallet.address.toLowerCase();
    encryptedKey = encryptKey(hlSigningKey);
  } else {
    // No wallet provided — generate a fresh EVM wallet for the agent
    const wallet = Wallet.createRandom();
    finalAddress = wallet.address.toLowerCase();
    // Use CBC encryption (built-in service key, no env var required)
    encryptedKey = encryptKeyCbc(wallet.privateKey);
    isGenerated = true;
  }

  // Approve builder fee on Hyperliquid (one-time setup, only when we have the key)
  let builderApproved = 0;
  if (hlSigningKey && !isGenerated) {
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
    hlWalletAddress: finalAddress,
    hlSigningKeyEncrypted: encryptedKey,
    generatedWallet: isGenerated ? 1 : 0,
    builderApproved,
  }).run();

  const depositAddress = finalAddress;

  return c.json({
    agent_id: agentId,
    api_key: apiKey,
    referral_code: myReferralCode,
    tier: "free",
    deposit_address: depositAddress,
    hl_wallet: {
      address: depositAddress,
      generated: isGenerated,
      signing_key_stored: true,
      builder_fee_approved: builderApproved === 1,
      execution: "real",
      onboarding: isGenerated
        ? "Fund this address on Hyperliquid to start trading"
        : "Deposit USDC to your Hyperliquid account via https://app.hyperliquid.xyz/join/PF",
    },
    message: isGenerated
      ? "Wallet auto-generated. Fund this address on Hyperliquid to start trading."
      : "Store your API key securely — it cannot be recovered. Never share your signing key.",
    fee_structure: {
      free: "Hyperliquid fee + 2 bps (0.02%) builder fee",
      pro: "Hyperliquid fee + 1 bp (0.01%) — $50k+ monthly volume",
      whale: "Hyperliquid fee only (0 markup) — $500k+ monthly volume",
    },
    referral_commission: "20% of our fee markup from referred agents",
    next_steps: isGenerated
      ? [
          `Deposit USDC to ${depositAddress} on Hyperliquid`,
          "GET /v1/markets — browse 275+ perpetual markets",
          "GET /v1/auth/deposit-address — retrieve your deposit address anytime",
          "POST /v1/trade/open — open a real position on Hyperliquid",
        ]
      : [
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
      generated: agent.generatedWallet === 1,
      signing_key_stored: !!agent.hlSigningKeyEncrypted,
      builder_fee_approved: agent.builderApproved === 1,
      execution: agent.hlSigningKeyEncrypted ? "real" : "not_configured",
    },
  });
});

app.get("/deposit-address", agentAuth, (c) => {
  const agent = c.get("agent") as typeof schema.agents.$inferSelect;
  if (!agent.hlWalletAddress) {
    return c.json({ error: "no_wallet", message: "No wallet associated with this account." }, 404);
  }
  return c.json({
    deposit_address: agent.hlWalletAddress,
    generated: agent.generatedWallet === 1,
    message: agent.generatedWallet === 1
      ? "Fund this address on Hyperliquid to start trading"
      : "Deposit USDC to this address on Hyperliquid",
    instructions: [
      `Send USDC to ${agent.hlWalletAddress} on Hyperliquid`,
      "Minimum deposit: $10 USDC",
      "Funds are available immediately after deposit",
    ],
  });
});

export default app;
