/**
 * Envelope encryption for tenant secrets (AES-256-GCM).
 *
 * Today `tenant_secrets` holds Razorpay key secrets, Gemini API keys and
 * WhatsApp tokens in PLAINTEXT. A database dump, a leaked service-role key, or
 * anyone with read access to that one table walks away with every third-party
 * credential the business owns.
 *
 * ── HOW IT WORKS ─────────────────────────────────────────────────────────────
 * Envelope, not direct encryption. Each value gets its own random 32-byte data
 * key (DEK); the DEK encrypts the value, and the MASTER key encrypts the DEK.
 * Both travel together in the stored string.
 *
 * The reason is key rotation. With direct encryption, changing the master key
 * means decrypting and re-encrypting every secret — which requires the old key,
 * a migration window, and a way to roll back if it fails halfway. With an
 * envelope you re-wrap the DEKs, which is small, fast, and per-row recoverable.
 * Nothing here does rotation yet, but the format does not have to change when it
 * is added, and that is the point of choosing it now.
 *
 * AES-256-GCM is authenticated: a tampered ciphertext fails to decrypt rather
 * than silently returning different bytes. That matters for an API key — a
 * silently corrupted one would produce confusing third-party auth failures
 * instead of an obvious local error.
 *
 * ── THE RULE THAT MAKES THIS SAFE TO DEPLOY ──────────────────────────────────
 * `decryptSecret` passes NON-envelope input straight through. Existing plaintext
 * secrets keep working the moment this ships, and become encrypted the next time
 * they are saved. Without that, deploying encryption would break Razorpay, Gemini
 * and WhatsApp for every tenant simultaneously, and the only fix would be
 * re-entering every credential by hand.
 *
 * ── WHAT WILL LOSE YOUR SECRETS ──────────────────────────────────────────────
 * Losing SECRETS_MASTER_KEY. There is no recovery: the DEKs are wrapped with it
 * and nothing else can unwrap them. Store it in Secret Manager (Cloud Run) or the
 * deployment's env, keep an offline copy, and never rotate it by simply replacing
 * the value — that orphans every secret already encrypted under the old one.
 *
 * A missing key is therefore treated differently from a wrong one: with no key
 * configured this module refuses to ENCRYPT (so nothing new becomes unreadable)
 * while still passing plaintext through on read.
 */
import crypto from "node:crypto";

/** Marks a stored value as an envelope produced by this module, version 1. */
const PREFIX = "rosv1";
const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;   // AES-256
const IV_BYTES  = 12;   // GCM standard nonce length (the 16-byte auth tag is implicit)

const b64  = (b: Buffer) => b.toString("base64url");
const ub64 = (s: string) => Buffer.from(s, "base64url");

/**
 * The master key, from SECRETS_MASTER_KEY (base64, 32 bytes decoded).
 *
 * Read on every call rather than cached at module load: a serverless instance can
 * outlive an env change, and a cached null would keep refusing long after the key
 * was supplied.
 */
function masterKey(): Buffer | null {
  const raw = process.env.SECRETS_MASTER_KEY?.trim();
  if (!raw) return null;
  let key: Buffer;
  try { key = Buffer.from(raw, "base64"); } catch { return null; }
  // A short key would still "work" in the sense of producing ciphertext, which is
  // exactly the kind of quiet weakness worth refusing outright.
  if (key.length !== KEY_BYTES) return null;
  return key;
}

/** True when a usable master key is present. */
export function isVaultConfigured(): boolean {
  return masterKey() !== null;
}

/** True when a stored value is one of our envelopes rather than plaintext. */
export function isEncrypted(stored: string | null | undefined): boolean {
  return typeof stored === "string" && stored.startsWith(`${PREFIX}:`);
}

/**
 * Encrypt a secret. Throws when no master key is configured — callers must
 * decide whether to store plaintext or refuse, and doing that silently is how a
 * secret ends up unencrypted while everyone believes otherwise.
 */
export function encryptSecret(plaintext: string): string {
  const master = masterKey();
  if (!master) {
    throw new Error("SECRETS_MASTER_KEY is not set (or is not 32 bytes of base64) — refusing to pretend a value was encrypted");
  }
  if (typeof plaintext !== "string" || plaintext === "") {
    throw new Error("Nothing to encrypt");
  }

  // Per-value data key.
  const dek = crypto.randomBytes(KEY_BYTES);

  // 1. Encrypt the value with the DEK.
  const iv = crypto.randomBytes(IV_BYTES);
  const c1 = crypto.createCipheriv(ALGO, dek, iv);
  const ct = Buffer.concat([c1.update(plaintext, "utf8"), c1.final()]);
  const tag = c1.getAuthTag();

  // 2. Wrap the DEK with the master key.
  const wIv = crypto.randomBytes(IV_BYTES);
  const c2 = crypto.createCipheriv(ALGO, master, wIv);
  const wrapped = Buffer.concat([c2.update(dek), c2.final()]);
  const wTag = c2.getAuthTag();

  return [PREFIX, b64(wIv), b64(wTag), b64(wrapped), b64(iv), b64(tag), b64(ct)].join(":");
}

/**
 * Decrypt a stored secret.
 *
 * PLAINTEXT PASSES THROUGH UNCHANGED. That is deliberate and is what lets this
 * ship without a migration: every secret saved before encryption existed keeps
 * working, and is upgraded the next time it is written.
 *
 * Throws when the value IS an envelope but cannot be opened — a missing key, a
 * wrong key, or tampering. Returning null or "" there would hand a caller an
 * empty API key and turn a key-management problem into a confusing third-party
 * authentication failure.
 */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined || stored === "") return null;
  if (!isEncrypted(stored)) return stored;          // legacy plaintext

  const parts = stored.split(":");
  if (parts.length !== 7) {
    throw new Error("Stored secret is marked encrypted but malformed — refusing to guess at its contents");
  }
  const [, wIvB, wTagB, wrappedB, ivB, tagB, ctB] = parts;

  const master = masterKey();
  if (!master) {
    throw new Error("Stored secret is encrypted but SECRETS_MASTER_KEY is not set — the value cannot be read without it");
  }

  let dek: Buffer;
  try {
    const d2 = crypto.createDecipheriv(ALGO, master, ub64(wIvB));
    d2.setAuthTag(ub64(wTagB));
    dek = Buffer.concat([d2.update(ub64(wrappedB)), d2.final()]);
  } catch {
    // GCM's tag check failed: wrong master key, or the row was altered.
    throw new Error("Could not unwrap the data key — wrong SECRETS_MASTER_KEY, or the stored value was modified");
  }

  try {
    const d1 = crypto.createDecipheriv(ALGO, dek, ub64(ivB));
    d1.setAuthTag(ub64(tagB));
    return Buffer.concat([d1.update(ub64(ctB)), d1.final()]).toString("utf8");
  } catch {
    throw new Error("Could not decrypt the secret — the stored value was modified");
  }
}

/**
 * Encrypt when possible, otherwise return the plaintext unchanged.
 *
 * For write paths that must not fail because a deployment has no master key yet.
 * The caller gets told which happened so it can warn rather than assume — a
 * secret quietly stored in the clear is exactly the state this module exists to
 * end, and it must never be indistinguishable from success.
 */
export function encryptSecretIfPossible(plaintext: string): { value: string; encrypted: boolean } {
  if (!isVaultConfigured()) return { value: plaintext, encrypted: false };
  return { value: encryptSecret(plaintext), encrypted: true };
}

/** Generate a master key, for setup instructions. Never called by the app. */
export function generateMasterKey(): string {
  return crypto.randomBytes(KEY_BYTES).toString("base64");
}

/** Mask any secret for display/logging. Never returns more than a hint. */
export function maskSecret(value: string | null | undefined): string {
  if (!value) return "—";
  if (isEncrypted(value)) return "encrypted";
  return value.length <= 8 ? "•".repeat(value.length) : `${value.slice(0, 4)}…${value.slice(-2)}`;
}
