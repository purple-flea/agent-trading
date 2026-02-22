/**
 * AES-256-GCM encryption for agent signing keys.
 * Keys are encrypted at rest and only decrypted in-memory for order execution.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

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
