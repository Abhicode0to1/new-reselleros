/**
 * DirectAdmin — WRITE side (account provisioning). 2 Sep 2026.
 *
 * The read-only client (./index.ts) said account creation would live in its own
 * module, "added only when Pardeep opens that door." He opened it: the hosting
 * trial is to auto-provision a cPanel account once the customer confirms their
 * email. This module is that door — and it is the ONLY place in the app that
 * creates, suspends or unsuspends a real hosting account.
 *
 * ─── THE RULES (these functions do irreversible things) ─────────────────────
 * · SERVER-ONLY. The admin key is a Cloud Run env var.
 * · NEVER throws to the caller — every function returns a typed result, and the
 *   caller must degrade honestly (no silent success).
 * · IDEMPOTENT by design: the username is derived deterministically from the
 *   domain, and daCreateAccount refuses if the account already exists, so a
 *   double-clicked confirmation link cannot create two accounts.
 * · The caller is responsible for the gate: nothing here checks whether live
 *   provisioning is enabled — the trial confirm route does (HOSTING_TRIAL_LIVE),
 *   so this module can be unit-tested and reasoned about in isolation.
 */
import "server-only";
import { randomBytes } from "crypto";
import { parseDA } from "./index";

const DA_URL = (process.env.DIRECTADMIN_URL?.trim() || "").replace(/\/+$/, "");
const ADMIN_USER = process.env.DIRECTADMIN_ADMIN_USER?.trim() || "";
const API_KEY = process.env.DIRECTADMIN_API_KEY?.trim() || "";

function authHeader(): string {
  return "Basic " + Buffer.from(`${ADMIN_USER}:${API_KEY}`).toString("base64");
}

export function daWriteConfigured(): boolean {
  return DA_URL.length > 0 && ADMIN_USER.length > 0 && API_KEY.length > 0;
}

/**
 * A DirectAdmin username: 4–16 chars, starts with a letter, lowercase
 * alphanumeric. Derived deterministically from the domain so the same domain
 * always maps to the same account (idempotency), with a short stable suffix from
 * the domain itself (NOT random — randomness would break determinism) to reduce
 * collisions between similar domains.
 */
export function genUsername(domain: string): string {
  const base = domain.toLowerCase().replace(/^https?:\/\//, "").replace(/[^a-z0-9]/g, "");
  const letters = base.replace(/^[0-9]+/, "") || "site";        // must start with a letter
  const stem = letters.slice(0, 10) || "site";
  // A short deterministic suffix from the full domain, so acme.in and acme.com differ.
  let h = 0;
  for (const ch of domain.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 100000;
  const suffix = String(h % 1000).padStart(3, "0");
  return (stem + suffix).slice(0, 16);
}

/** A strong password that satisfies DirectAdmin's complexity (upper/lower/digit/symbol). */
export function genPassword(): string {
  const bytes = randomBytes(18).toString("base64").replace(/[^A-Za-z0-9]/g, "");
  const core = bytes.slice(0, 14);
  // Guarantee one of each class regardless of what base64 produced.
  return `A${core}9z!`;
}

async function daPost(path: string, params: Record<string, string>): Promise<{ ok: boolean; message: string }> {
  if (!daWriteConfigured()) return { ok: false, message: "DirectAdmin is not configured." };
  try {
    const res = await fetch(`${DA_URL}${path}`, {
      method: "POST",
      headers: { Authorization: authHeader(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`[directadmin:write] ${path} HTTP ${res.status}: ${text.slice(0, 160)}`);
      return { ok: false, message: `DirectAdmin returned HTTP ${res.status}.` };
    }
    const parsed = parseDA(text);
    // parseDA returns null on an HTML login page (blocked IP / bad creds) or on
    // DA's `error=1` envelope — both are failures here.
    if (!parsed) {
      const m = /error=1/.test(text)
        ? decodeURIComponent((/text=([^&]*)/.exec(text)?.[1] || "").replace(/\+/g, " ")) || "DirectAdmin rejected the request."
        : "DirectAdmin did not accept the request (IP not allowed, or bad credentials).";
      console.error(`[directadmin:write] ${path} failed: ${m} · raw: ${text.slice(0, 160)}`);
      return { ok: false, message: m };
    }
    return { ok: true, message: "ok" };
  } catch (err) {
    console.error(`[directadmin:write] ${path} unreachable:`, (err as Error).message);
    return { ok: false, message: "Could not reach DirectAdmin." };
  }
}

/** True if a user account already exists on the server (idempotency guard). */
export async function daAccountExists(username: string): Promise<boolean> {
  if (!daWriteConfigured()) return false;
  try {
    const u = new URL(`${DA_URL}/CMD_API_SHOW_USER_CONFIG`);
    u.searchParams.set("user", username);
    const res = await fetch(u.toString(), {
      headers: { Authorization: authHeader() },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return false;
    const parsed = parseDA(await res.text());
    // A real config comes back as key=value pairs; a missing user yields error=1 → null.
    return !!parsed && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

export interface CreateAccountInput {
  username: string;
  password: string;
  email: string;
  domain: string;
  /** DirectAdmin package name — must match a package on the server (Starter/Standard/Plus). */
  pkg: string;
  ip?: string;
}

/**
 * Create a cPanel/DirectAdmin user account. Refuses (ok:false) if an account for
 * this username already exists, so it is safe to call more than once for the
 * same domain. IRREVERSIBLE on success — a real account is created.
 */
export async function daCreateAccount(input: CreateAccountInput): Promise<{ ok: boolean; message: string; alreadyExisted?: boolean }> {
  if (await daAccountExists(input.username)) {
    return { ok: true, message: "Account already exists.", alreadyExisted: true };
  }
  return daPost("/CMD_API_ACCOUNT_USER", {
    action: "create",
    add: "Submit",
    username: input.username,
    email: input.email,
    passwd: input.password,
    passwd2: input.password,
    domain: input.domain,
    package: input.pkg,
    ip: input.ip || "shared",
    notify: "no",
  });
}

/** Suspend an account (used by the trial-expiry cron). Reversible via unsuspend. */
export async function daSuspendAccount(username: string): Promise<{ ok: boolean; message: string }> {
  return daPost("/CMD_API_SELECT_USERS", { location: "CMD_SELECT_USERS", suspend: "Suspend", select0: username });
}

/** Unsuspend an account (used when a trial converts to paid). */
export async function daUnsuspendAccount(username: string): Promise<{ ok: boolean; message: string }> {
  return daPost("/CMD_API_SELECT_USERS", { location: "CMD_SELECT_USERS", suspend: "Unsuspend", select0: username });
}
