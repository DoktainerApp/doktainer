import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
export const DEVELOPMENT_ENCRYPTION_KEY =
  "dev-32-char-encryption-key-here!";
const REJECTED_PRODUCTION_KEYS = new Set([
  DEVELOPMENT_ENCRYPTION_KEY,
  "change-me",
  "changeme",
  "replace-me",
  "replace-with-a-secure-random-key",
]);

export function getEncryptionKeyOrThrow(env = process.env): string {
  const configuredKey = env.ENCRYPTION_KEY?.trim();
  const isProduction = env.NODE_ENV === "production";

  if (!configuredKey) {
    if (isProduction) {
      throw new Error(
        "ENCRYPTION_KEY must be configured before starting Doktainer in production",
      );
    }
    return DEVELOPMENT_ENCRYPTION_KEY;
  }

  if (configuredKey.length < 32) {
    throw new Error("ENCRYPTION_KEY must be at least 32 characters long");
  }

  if (
    isProduction &&
    (REJECTED_PRODUCTION_KEYS.has(configuredKey.toLowerCase()) ||
      /^dev[-_]/i.test(configuredKey) ||
      new Set(configuredKey).size < 8 ||
      /^(.)\1+$/.test(configuredKey))
  ) {
    throw new Error(
      "ENCRYPTION_KEY must use a strong random value and must not use a development or placeholder value in production",
    );
  }

  return configuredKey;
}

export function validateEncryptionConfiguration(env = process.env): void {
  getEncryptionKeyOrThrow(env);
}

function getKey(): Buffer {
  const key = getEncryptionKeyOrThrow();
  // Derive a 32-byte key using SHA-256
  return crypto.createHash("sha256").update(key).digest();
}

/**
 * Encrypt a plaintext string (e.g. SSH private key or password)
 * Returns base64-encoded "iv:authTag:ciphertext"
 */
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

/**
 * Decrypt an encrypted string produced by `encrypt()`
 */
export function decrypt(encoded: string): string {
  const [ivB64, tagB64, dataB64] = encoded.split(":");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Invalid encrypted format");

  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8",
  );
}
