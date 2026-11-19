import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** AES-256-GCM. The workspace and key name are bound in as associated data, so a stored value cannot be moved to another workspace. */
function key(): Buffer {
  const raw = process.env.SECRETS_KEY;
  if (!raw) throw new Error("SECRETS_KEY is not set, so workspace keys cannot be stored.");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("SECRETS_KEY must be 32 random bytes, base64 encoded.");
  return k;
}

export const secretsAvailable = () => { try { key(); return true; } catch { return false; } };

export function encryptSecret(plain: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
}

export function decryptSecret(stored: string, aad: string): string {
  const [v, iv, tag, ct] = stored.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Unreadable stored key.");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}

/** The only part of a key that is ever shown again. */
export const keyHint = (plain: string) => (plain.length >= 12 ? `••••${plain.slice(-4)}` : "••••");
