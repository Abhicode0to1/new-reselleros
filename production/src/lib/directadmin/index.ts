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
