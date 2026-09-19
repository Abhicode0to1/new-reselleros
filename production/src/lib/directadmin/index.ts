/**
 * DirectAdmin — direct integration, READ-ONLY for now (merge, 2 Sep 2026).
 *
 * The engine (app.anutech.in) can't be redeployed, so — as with ResellerClub for
 * domains — this app talks to DirectAdmin itself, with the same admin API key,
 * from the whitelisted static IP (34.14.190.227). Ported faithfully from the
 * engine's wrapper (domain-management-system: lib/directadmin/*): HTTP Basic
 * auth (admin-user : api-key), the classic `CMD_API_*` endpoints, and DA's
 * URL-encoded response format.
 *
 * ─── WHAT DIRECTADMIN DOES AND DOES NOT GIVE US ─────────────────────────────
 * It holds PACKAGES (disk/bandwidth quotas) and CREATES ACCOUNTS. It does NOT
 * hold selling prices — those are Anutech's own numbers (config, confirmed real
 * by Pardeep). So this is used for two things only:
 *   1. reading package specs (this file — safe, read-only), and
 *   2. later, creating a hosting account on a paid sale (a SEPARATE module that
 *      does not exist yet, and will sit behind the provisioning queue's gates:
 *      creating an account is irreversible resource use).
 *
 * ─── THE RULES ───────────────────────────────────────────────────────────────
 * · Every function here is READ-ONLY. Nothing creates, changes, suspends or
 *   deletes anything. Account creation lives in its own module, added only when
 *   Pardeep opens that door.
 * · NEVER throws to the caller and never invents — a failure returns null, and
 *   the caller must degrade honestly.
 * · SERVER-ONLY (the key is a Cloud Run env var).
 * · DA checks the CALLING IP against its own allowlist; our static NAT IP must
 *   be on it, or DA answers with an HTML login page (detected below as failure).
 */
import "server-only";

const DA_URL = (process.env.DIRECTADMIN_URL?.trim() || "").replace(/\/+$/, "");
const ADMIN_USER = process.env.DIRECTADMIN_ADMIN_USER?.trim() || "";
const API_KEY = process.env.DIRECTADMIN_API_KEY?.trim() || "";

/** True when the credentials exist — the switch between direct and no-op. */
export function daConfigured(): boolean {
  return DA_URL.length > 0 && ADMIN_USER.length > 0 && API_KEY.length > 0;
}

function authHeader(): string {
  return "Basic " + Buffer.from(`${ADMIN_USER}:${API_KEY}`).toString("base64");
}

/**
 * A DirectAdmin classic response is a query string — `list[]=A&list[]=B` or
 * `quota=10000&bandwidth=100000`. Parse it into a plain object, arrays kept as
 * arrays. Returns null when DA handed back an HTML login page (bad creds or an
 * IP that isn't on its allowlist) or a URL-encoded `error=1`.
 */
export function parseDA(text: string): Record<string, string | string[]> | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("<")) return null;                 // HTML login page = not authed / IP blocked
  const params = new URLSearchParams(trimmed);
  if (params.get("error") === "1") return null;             // DA's own error envelope
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    out[key] = all.length > 1 ? all : all[0];
  }
  return out;
}

async function daGet(path: string, query: Record<string, string> = {}): Promise<Record<string, string | string[]> | null> {
  if (!daConfigured()) return null;
  try {
    const u = new URL(`${DA_URL}${path}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    const res = await fetch(u.toString(), {
      headers: { Authorization: authHeader() },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`[directadmin] ${path} HTTP ${res.status}: ${text.slice(0, 160)}`);
      return null;
    }
    const parsed = parseDA(text);
    if (!parsed) {
      /* HTML login page or error=1 — most often the IP isn't on DA's allowlist. */
      console.error(`[directadmin] ${path} not authed / IP not allowed / error: ${text.slice(0, 160)}`);
    }
    return parsed;
  } catch (err) {
    console.error(`[directadmin] ${path} unreachable:`, (err as Error).message);
    return null;
  }
}

export interface DaPackage {
  name: string;
  /** Disk quota in MB (-1 = unlimited), or null when DA didn't say. */
  quotaMB: number | null;
  /** Bandwidth in MB (-1 = unlimited), or null. */
  bandwidthMB: number | null;
}

export function toMB(v: string | string[] | undefined): number | null {
  const s = Array.isArray(v) ? v[0] : v;
  if (s === undefined) return null;
  if (/unlimited/i.test(s)) return -1;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Package names created by the admin/reseller on the server. null on failure. */
export async function daListPackages(): Promise<string[] | null> {
  const data = await daGet("/CMD_API_PACKAGES_USER");
  if (!data) return null;
  const raw = data["list[]"] ?? data["list"] ?? data["packages"] ?? [];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.filter(Boolean);
}

/** Disk/bandwidth for one package. null on failure. */
export async function daPackageDetails(name: string): Promise<DaPackage | null> {
  const data = await daGet("/CMD_API_PACKAGES_USER", { package: name });
  if (!data) return null;
  return { name, quotaMB: toMB(data.quota), bandwidthMB: toMB(data.bandwidth) };
}

/** Every package with its specs — the read-only "specs sync" source. null on failure. */
export async function daAllPackages(): Promise<DaPackage[] | null> {
  const names = await daListPackages();
  if (!names) return null;
  const out: DaPackage[] = [];
  for (const name of names) {
    const d = await daPackageDetails(name);
    if (d) out.push(d);
  }
  return out;
}

/* ── Usage: what the server says an account is actually consuming ─────────────
 *
 * Ported from the DMS engine's lib/directadmin/users.ts (getUserUsage,
 * getAllUserUsage) on 9 Sep 2026.
 *
 * ─── USAGE IS NOT QUOTA, AND THE COLUMN NAMES MAKE THAT EASY TO GET WRONG ────
 * `CMD_API_SHOW_USER_USAGE` returns what an account has CONSUMED. Our
 * `hosting_accounts.disk_quota_mb` / `bandwidth_quota_mb` are the LIMITS the plan
 * grants, written at provisioning. Writing usage into either would replace a
 * 10 GB allowance with "412 MB used" and nobody would notice until a customer
 * was told their plan had shrunk. So these values are read and reported; the
 * limits are reconciled from the PACKAGE (`daPackageDetails`), which is where a
 * limit actually lives.
 */

export interface DaUsage {
  /** MB consumed, not granted. -1 for unlimited, null when DA did not say. */
  diskUsedMB: number | null;
  bandwidthUsedMB: number | null;
  domains: number | null;
  emails: number | null;
  databases: number | null;
  /** DA reports this as "yes"/"no" on the usage record. */
  suspended: boolean | null;
}

function toCount(v: string | string[] | undefined): number | null {
  const s = Array.isArray(v) ? v[0] : v;
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * One account's usage out of DA's key/value record.
 *
 * Exported and pure because it is the half worth testing — the transport around
 * it is a `daGet` away, and this is where DA's field names stop leaking.
 */
export function parseUserUsage(data: Record<string, string | string[]>): DaUsage {
  const flag = (v: string | string[] | undefined): boolean | null => {
    const s = Array.isArray(v) ? v[0] : v;
    if (s === undefined) return null;
    return /^(yes|true|1|on)$/i.test(s.trim());
  };
  return {
    diskUsedMB: toMB(data.quota),
    bandwidthUsedMB: toMB(data.bandwidth),
    domains: toCount(data.vdomains ?? data.domains),
    emails: toCount(data.nemails),
    databases: toCount(data.mysql),
    suspended: flag(data.suspended),
  };
}

/**
 * DA's bulk usage answer nests one query string inside another: the outer keys
 * are usernames and each VALUE is itself URL-encoded
 * (`user1=quota%3D412%26bandwidth%3D900`). Parsing only the outer layer yields a
 * string where a record was expected, which is the kind of thing that reads as
 * "no usage data" rather than as a bug.
 */
export function parseAllUserUsage(data: Record<string, string | string[]>): Record<string, DaUsage> {
  const out: Record<string, DaUsage> = {};
  for (const [user, raw] of Object.entries(data)) {
    if (user === "error" || user === "text" || user === "details") continue;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string" || value === "") continue;
    const inner = parseDA(value);
    if (!inner) continue;
    out[user] = parseUserUsage(inner);
  }
  return out;
}

/** One account's usage. null when DA could not be read; see parseUserUsage. */
export async function daUserUsage(username: string): Promise<DaUsage | null> {
  const data = await daGet("/CMD_API_SHOW_USER_USAGE", { user: username });
  if (!data) return null;
  return parseUserUsage(data);
}

/**
 * Every account's usage. One call where the server supports it, else one each.
 *
 * ─── THE BULK ENDPOINT DOES NOT EXIST ON THIS SERVER ────────────────────────
 * `CMD_API_SHOW_ALL_USER_USAGE` was the only implementation until 11 Sep 2026,
 * the first day this app had real DirectAdmin credentials. Measured against
 * server1.anutech.in:
 *
 *   /CMD_API_SHOW_ALL_USER_USAGE        → 200, and an HTML PAGE (the web UI)
 *   /CMD_API_SHOW_ALL_USERS             → 200, list[]=… (5 accounts)
 *   /CMD_API_SHOW_USER_USAGE?user=X     → 200, bandwidth=…&quota=…
 *
 * A 200 carrying HTML is not an API answer, so `daGet` returned null and
 * `asset-sweep` reported "DirectAdmin could not be read — no account was stamped
 * or flagged" for every run. Identical in symptom to the server being down, which
 * is why nothing noticed. (DMS's `getAllUserUsage` calls the same endpoint and has
 * the same bug; it was not the source of the fix.)
 *
 * ─── THE FALLBACK IS SEQUENTIAL AND CAPPED, ON PURPOSE ──────────────────────
 * The original comment here argued for one call over N, citing this machine
 * producing `exited 3221225794` from ~120 processes in a loop. That was about
 * PROCESSES and does not apply to HTTP requests — but the instinct is right, so
 * the fallback awaits one at a time rather than flooding somebody's control panel,
 * and stops at MAX. A reseller past that cap gets partial usage, which the caller
 * already handles: `asset-sweep` treats an absent account as "not stamped", not
 * as "gone".
 *
 * The bulk call is still tried first, because a newer DirectAdmin may well answer
 * it and one call is better than fifty.
 */
const MAX_USAGE_FALLBACK = 200;

export async function daAllUserUsage(): Promise<Record<string, DaUsage> | null> {
  const bulk = await daGet("/CMD_API_SHOW_ALL_USER_USAGE");
  if (bulk) {
    const parsed = parseAllUserUsage(bulk);
    /* An empty object from a server that HAS accounts means the endpoint
       answered with something that is not usage — the HTML case. Fall through
       rather than reporting "no accounts have usage". */
    if (Object.keys(parsed).length > 0) return parsed;
  }

  const users = await daGet("/CMD_API_SHOW_ALL_USERS");
  if (!users) return null;

  /* `list[]` comes back as an array, or as a single string when there is one
     account. Both shapes, because a one-account server is a real deployment. */
  const raw = users["list[]"] ?? users.list;
  const names = (Array.isArray(raw) ? raw : raw ? [String(raw)] : [])
    .map((n) => String(n).trim())
    .filter(Boolean)
    .slice(0, MAX_USAGE_FALLBACK);

  if (names.length === 0) return null;

  const out: Record<string, DaUsage> = {};
  for (const name of names) {
    const one = await daUserUsage(name);
    /* A single unreadable account is not an unreadable server. Skip it and keep
       going — the caller's job is to notice an account it expected and did not
       get, which it can only do if the others are present. */
    if (one) out[name] = one;
  }
  return out;
}

