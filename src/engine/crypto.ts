/**
 * AES-256-GCM encryption for agent signing keys.
 * Keys are encrypted at rest and only decrypted in-memory for order execution.
 *
 * Also provides AES-256-CBC encryption for auto-generated wallets using the
 * built-in service secret (no ENCRYPTION_KEY env var required).
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from "crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 16;
const TAG_LEN = 16;
const SALT_LEN = 16;

function deriveKey(salt: Buffer): Buffer {
  const envKey = process.env.ENCRYPTION_KEY;
  if (!envKey) throw new Error("ENCRYPTION_KEY env var required for signing key storage");
  // Derive a 32-byte key from the env secret with per-encryption random salt
  return scryptSync(envKey, salt, 32);
}

/** Encrypt a private key string. Returns hex-encoded (salt + iv + tag + ciphertext). */
export function encryptKey(plaintext: string): string {
  const salt = randomBytes(SALT_LEN);
  const key = deriveKey(salt);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: salt (16) + iv (16) + tag (16) + ciphertext
  return Buffer.concat([salt, iv, tag, encrypted]).toString("hex");
}

/** Decrypt a hex-encoded encrypted key. Returns the original private key string. */
export function decryptKey(encryptedHex: string): string {
  const buf = Buffer.from(encryptedHex, "hex");
  // Support both old format (iv+tag+ct) and new format (salt+iv+tag+ct)
  // Old format: 16 (iv) + 16 (tag) + ct = minimum 32 bytes overhead
  // New format: 16 (salt) + 16 (iv) + 16 (tag) + ct = minimum 48 bytes overhead
  // A typical encrypted hex key (64-char private key) is ~80 hex chars old, ~112 new
  // We detect by checking if the buffer is long enough for the new format
  const isNewFormat = buf.length >= SALT_LEN + IV_LEN + TAG_LEN + 1;
  const hasLegacyLength = buf.length < SALT_LEN + IV_LEN + TAG_LEN + 1;

  if (hasLegacyLength) {
    // Legacy format: iv + tag + ciphertext (static salt)
    const envKey = process.env.ENCRYPTION_KEY;
    if (!envKey) throw new Error("ENCRYPTION_KEY env var required");
    const key = scryptSync(envKey, "purpleflea-trading", 32);
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext) + decipher.final("utf8");
  }

  // New format: salt + iv + tag + ciphertext
  const salt = buf.subarray(0, SALT_LEN);
  const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = buf.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(SALT_LEN + IV_LEN + TAG_LEN);
  const key = deriveKey(salt);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}

// ─── AES-256-CBC for auto-generated wallets ───────────────────────────────────
// Key derived from a built-in service secret (no env var required).
// Used when the service generates the EVM wallet on behalf of the agent.

const CBC_ALGO = "aes-256-cbc";
// Key = sha256("purpleflea_trading_secret_2026") — deterministic 32-byte key
const CBC_KEY = createHash("sha256").update("purpleflea_trading_secret_2026").digest();

/** Encrypt a private key using AES-256-CBC. Returns hex-encoded (iv + ciphertext). */
export function encryptKeyCbc(plaintext: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv(CBC_ALGO, CBC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, encrypted]).toString("hex");
}

/** Decrypt a hex-encoded AES-256-CBC encrypted key. Returns the original private key string. */
export function decryptKeyCbc(encryptedHex: string): string {
  const buf = Buffer.from(encryptedHex, "hex");
  const iv = buf.subarray(0, 16);
  const ciphertext = buf.subarray(16);
  const decipher = createDecipheriv(CBC_ALGO, CBC_KEY, iv);
  return decipher.update(ciphertext) + decipher.final("utf8");
}
