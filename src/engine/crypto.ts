/**
 * AES-256-GCM encryption for agent signing keys.
 * Keys are encrypted at rest and only decrypted in-memory for order execution.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 16;
const TAG_LEN = 16;

function getEncryptionKey(): Buffer {
  const envKey = process.env.ENCRYPTION_KEY;
  if (!envKey) throw new Error("ENCRYPTION_KEY env var required for signing key storage");
  // Derive a 32-byte key from the env secret
  return scryptSync(envKey, "purpleflea-trading", 32);
}

/** Encrypt a private key string. Returns hex-encoded (iv + tag + ciphertext). */
export function encryptKey(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv (16) + tag (16) + ciphertext
  return Buffer.concat([iv, tag, encrypted]).toString("hex");
}

/** Decrypt a hex-encoded encrypted key. Returns the original private key string. */
export function decryptKey(encryptedHex: string): string {
  const key = getEncryptionKey();
  const buf = Buffer.from(encryptedHex, "hex");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}
