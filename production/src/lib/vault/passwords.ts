/**
 * Customer credential vault — generation, strength, reuse detection, health.
 *
 * ─── WHAT THIS VAULT IS, AND WHAT IT IS NOT ──────────────────────────────────
 * It holds credentials for consoles this reseller already administers on a
 * customer's behalf: Google Admin, Microsoft 365 admin, DNS registrar, cPanel,
 * distributor portals. That is a standard reseller feature, and the honest
 * comparison is not "versus Bitwarden" but "versus the spreadsheet and the
 * WhatsApp messages these logins live in today".
 *
 * It is NOT zero-knowledge, and the UI must not say that it is. `SECRETS_MASTER_KEY`
 * is a server-side value, so the server — and anyone holding its environment or
 * the Supabase service-role key — can decrypt. A real zero-knowledge vault derives
 * the key from the user's own passphrase in the browser and the server never sees
 * plaintext. Calling this zero-knowledge would be a false security claim made to
 * the reseller's customers. The accurate phrase is "encrypted at rest, decryptable
 * by the server".
 *
 * Which also means: personal and banking passwords do not belong here. Those go in
 * a real zero-knowledge manager.
 *
 * ─── THE ENCRYPTION ITSELF IS NOT IN THIS FILE ───────────────────────────────
 * `lib/crypto/vault.ts` already implements AES-256-GCM envelope encryption
 * (per-value DEK wrapped by the master key, `rosv1:` format) with tests. This
 * module deliberately does not reimplement it — a second crypto path is how one of
 * them ends up unreviewed.
 */

/** Console types the vault covers. */
export type VaultCategory =
  | "google_admin" | "m365_admin" | "dns_registrar"
  | "cpanel" | "distributor" | "other";

// ─── Generation ─────────────────────────────────────────────────────────────

/** Ambiguous glyphs are excluded: these get read aloud and mistyped. */
const LOWER = "abcdefghijkmnopqrstuvwxyz";       // no l
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";        // no I, O
const DIGIT = "23456789";                        // no 0, 1
const SYMBOL = "!@#$%^&*()-_=+[]{};:,.?";

export const DEFAULT_LENGTH = 20;
export const MIN_LENGTH = 12;

export interface GenerateOptions {
  length?: number;
  symbols?: boolean;
}

/**
 * A cryptographically random password.
 *
 * REJECTION SAMPLING, NOT MODULO. The obvious `bytes[i] % alphabet.length` is
 * biased: with a 62-character alphabet, 256 % 62 = 8, so the first 8 characters
 * come up measurably more often than the rest. It looks random and is not, and the
 * bias is invisible in any eyeball test. Values in the non-uniform tail are
 * discarded and redrawn instead.
 *
 * Uses `crypto.getRandomValues` — never `Math.random()`, which is seeded,
 * predictable and has no place near a credential.
 */
export function generatePassword(opts: GenerateOptions = {}): string {
  const length = Math.max(MIN_LENGTH, Math.floor(opts.length ?? DEFAULT_LENGTH));
  const useSymbols = opts.symbols !== false;

  const alphabet = LOWER + UPPER + DIGIT + (useSymbols ? SYMBOL : "");
  const n = alphabet.length;

  // Largest multiple of n that fits in a byte. Anything at or above it would skew
  // the distribution, so it is thrown away.
  const limit = Math.floor(256 / n) * n;

  const out: string[] = [];
  const buf = new Uint8Array(64);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b >= limit) continue;               // discard, do not fold
      out.push(alphabet[b % n]);
      if (out.length === length) break;
    }
  }
  return out.join("");
}

// ─── Strength ───────────────────────────────────────────────────────────────

export type Strength = "weak" | "fair" | "strong";

export interface StrengthResult {
  strength: Strength;
  /** Distinct character classes present, 0…4. */
  classes: number;
  length: number;
  /** Why it is not strong. Empty when it is. */
  problems: string[];
}

const SEQUENCES = ["abcdef", "qwerty", "asdfgh", "123456", "098765"];
const COMMON = [
  "password", "passw0rd", "admin", "welcome", "letmein", "qwerty",
  "iloveyou", "changeme", "google", "microsoft", "office365", "india",
];

/**
 * How strong a stored password is.
 *
 * A HEURISTIC, and labelled as one. It is not entropy: real entropy needs the
 * generator's alphabet and length, which is knowable for passwords this app
 * generated and unknowable for one a customer chose in 2019. What it does is catch
 * the passwords that actually get broken — short ones, single-class ones, and ones
 * containing a dictionary word or a keyboard run.
 */
export function assessStrength(password: string | null | undefined): StrengthResult {
  const p = (password ?? "").toString();
  const length = p.length;
  const problems: string[] = [];

  const classes =
    (/[a-z]/.test(p) ? 1 : 0) +
    (/[A-Z]/.test(p) ? 1 : 0) +
    (/[0-9]/.test(p) ? 1 : 0) +
    (/[^A-Za-z0-9]/.test(p) ? 1 : 0);

  if (length === 0) {
    return { strength: "weak", classes: 0, length: 0, problems: ["Empty."] };
  }
  if (length < MIN_LENGTH) problems.push(`Only ${length} characters — ${MIN_LENGTH} is the floor.`);
  if (classes <= 1) problems.push("Uses a single kind of character.");
  else if (classes === 2 && length < 16) problems.push("Only two kinds of character at this length.");

  const lower = p.toLowerCase();
  const word = COMMON.find((w) => lower.includes(w));
  if (word) problems.push(`Contains a well-known word ("${word}").`);

  const seq = SEQUENCES.find((s) => lower.includes(s) || lower.includes([...s].reverse().join("")));
  if (seq) problems.push("Contains a keyboard or counting run.");

  // A run of the same character is the other classic.
  if (/(.)\1{3,}/.test(p)) problems.push("Repeats one character four or more times.");

  const strength: Strength =
    problems.length === 0 && length >= 16 && classes >= 3 ? "strong"
    : problems.length === 0 || (problems.length === 1 && length >= MIN_LENGTH && classes >= 3) ? "fair"
    : "weak";

  return { strength, classes, length, problems };
}

// ─── Reuse detection without a crackable store ──────────────────────────────

/**
 * A keyed fingerprint used ONLY to spot two entries sharing a password.
 *
 * WHY NOT A PLAIN HASH. `sha256(password)` would let anyone who obtained the
 * database run a wordlist against it offline and recover short passwords — and
 * these are admin consoles. A KEYED MAC cannot be attacked that way without the
 * master key, which is not in the database.
 *
 * Truncated to 16 hex characters. Enough that a collision between a handful of a
 * tenant's credentials is not a practical concern, short enough that it is
 * obviously not a store of the value.
 *
 * @param hmacHex Full hex HMAC-SHA256 of the password under the master key,
 *        computed server-side by the caller. This module stays free of crypto
 *        imports so it can be unit-tested in the browser environment too.
 */
export function reuseFingerprint(hmacHex: string): string {
  return (hmacHex ?? "").toString().trim().toLowerCase().slice(0, 16);
}

// ─── Health ─────────────────────────────────────────────────────────────────

/** Rotate a customer console password at least this often. */
export const ROTATION_DAYS = 90;

export interface VaultEntryHealth {
  id: string;
  title: string;
  category: VaultCategory | string;
  customerId: string | null;
  /** Fingerprint from `reuseFingerprint`, or null when not computed. */
  fingerprint: string | null;
  lastRotatedAt: string | null;
  /** Only present when the caller has decrypted it for a health sweep. */
  password?: string | null;
}

export type HealthCode = "weak" | "reused" | "stale" | "never_rotated";

export interface HealthFinding {
  id: string;
  title: string;
  code: HealthCode;
  severity: "critical" | "high" | "medium";
  message: string;
  action: string;
  /** For `reused`: the other entries sharing this password. */
  sharedWith?: string[];
}

function daysBetweenIso(fromIso: string, toIso: string): number | null {
  const a = Date.parse(fromIso), b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Health sweep over the vault.
 *
 * `today` is a parameter so this is pure and can be tested at a chosen date.
 *
 * Reuse is judged from fingerprints, so it works WITHOUT decrypting anything —
 * which matters, because a health sweep that had to decrypt every password would
 * be a bulk-decrypt job running on a schedule, and that is precisely the operation
 * you least want automated.
 */
export function vaultHealth(entries: VaultEntryHealth[], today: string): HealthFinding[] {
  const out: HealthFinding[] = [];

  // ── Reuse ─────────────────────────────────────────────────────────────
  const byPrint = new Map<string, VaultEntryHealth[]>();
  for (const e of entries) {
    const fp = (e.fingerprint ?? "").trim();
    if (!fp) continue;
    const list = byPrint.get(fp) ?? [];
    list.push(e);
    byPrint.set(fp, list);
  }
  for (const group of byPrint.values()) {
    if (group.length < 2) continue;
    for (const e of group) {
      out.push({
        id: e.id, title: e.title, code: "reused", severity: "critical",
        message: `Shares a password with ${group.length - 1} other ${group.length === 2 ? "entry" : "entries"}.`,
        action: "Change them to separate passwords — one leak currently opens all of them.",
        sharedWith: group.filter((g) => g.id !== e.id).map((g) => g.title),
      });
    }
  }

  // ── Age and strength ──────────────────────────────────────────────────
  for (const e of entries) {
    if (!e.lastRotatedAt) {
      out.push({
        id: e.id, title: e.title, code: "never_rotated", severity: "medium",
        message: "No rotation date recorded, so its age is unknown.",
        action: "Rotate it once and the clock becomes honest from then on.",
      });
    } else {
      const age = daysBetweenIso(e.lastRotatedAt, today);
      if (age !== null && age > ROTATION_DAYS) {
        out.push({
          id: e.id, title: e.title, code: "stale",
          severity: age > ROTATION_DAYS * 2 ? "high" : "medium",
          message: `Last changed ${age} days ago.`,
          action: `Rotate it — the target for a customer console is every ${ROTATION_DAYS} days.`,
        });
      }
    }

    // Only assessed when the caller decrypted it for this sweep. Absent means
    // "not checked", which is different from "fine", so nothing is claimed.
    if (typeof e.password === "string" && e.password.length > 0) {
      const s = assessStrength(e.password);
      if (s.strength === "weak") {
        out.push({
          id: e.id, title: e.title, code: "weak", severity: "high",
          message: s.problems[0] ?? "Weak password.",
          action: "Replace it with a generated one.",
        });
      }
    }
  }

  const order = { critical: 0, high: 1, medium: 2 } as const;
  return out.sort(
    (a, b) => order[a.severity] - order[b.severity] || a.title.localeCompare(b.title) || a.code.localeCompare(b.code)
  );
}
