/**
 * Client for the DMS Engine API — the hosting/domains app at app.anutech.in.
 *
 * ─── WHAT DMS IS TO US ───────────────────────────────────────────────────────
 * DMS keeps its own customer portal and admin panel, and keeps registering
 * domains and creating hosting accounts. It is not being retired and we are not
 * taking its data. What this module buys is a WINDOW: we can show a customer's
 * domains and hosting inside pages we already have, and hand a person across to
 * DMS to do the actual work.
 *
 * So everything here is read-only by construction. There is no write method and
 * adding one is a deliberate decision, not a small extension — see the key note
 * below.
 *
 * ─── IT NEVER THROWS, AND THAT IS THE POINT ──────────────────────────────────
 * Every function resolves to a tagged result instead of rejecting. A page that
 * shows DMS data is always a page that has its OWN reason to exist — a customer
 * record, a dashboard — and DMS being unreachable must degrade that page to a
 * quiet "couldn't reach the hosting engine" strip, never a 500.
 *
 * This is the same call the DMS side already makes in the other direction:
 * `lib/integrations/billing-customer.ts` there resolves a failure to "not
 * linked" rather than throwing, for exactly this reason.
 *
 * ─── FAIL CLOSED ON CONFIG ───────────────────────────────────────────────────
 * No URL or no key configured means `{ ok: false, reason: "not_configured" }` —
 * never a call to a default host. A missing env var must not be able to send a
 * request somewhere unintended, and a local dev box with a blank `.env` must be
 * unable to reach production DMS by accident.
 *
 * ─── THE KEY WE HOLD IS THE READ KEY ─────────────────────────────────────────
 * `DMS_ENGINE_READ_KEY` maps to DMS's `ENGINE_READ_API_KEY`, which grants reads
 * and nothing else. DMS deliberately keeps a separate, stronger key for actions
 * that spend money. If a future feature needs to register or renew something,
 * it needs that other key and a different module — do not widen this one.
 */
import "server-only";

const BASE_URL = (process.env.DMS_ENGINE_URL ?? "").trim().replace(/\/+$/, "");
const READ_KEY = (process.env.DMS_ENGINE_READ_KEY ?? "").trim();

/** How long we wait before deciding DMS is not going to answer. */
const TIMEOUT_MS = 8000;

export type EngineFailure =
  | "not_configured"
  | "unauthorized"
  | "unreachable"
  | "bad_response";

export type EngineResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: EngineFailure; detail?: string };

export interface EngineHealth {
  ok: boolean;
  service: string;
  contractVersion: number;
  database: boolean;
  capabilities: { resellerclub: boolean; directadmin: boolean };
  panelUrls: { admin: string; customer: string };
}

export interface EngineDomain {
  id: string;
  domainName: string;
  status: string;
  registeredAt: string | null;
  expiresAt: string | null;
  autoRenew: boolean;
  privacyProtection: boolean;
  nameservers: string[];
}

export interface EngineHosting {
  id: string;
  domainName: string;
  planName: string;
  status: string;
  startDate: string | null;
  expiryDate: string | null;
  autoRenew: boolean;
  isTrial: boolean;
  directAdminUsername: string | null;
}

export interface EngineServices {
  /** False when DMS has no account for this email — a normal state, not an error. */
  linked: boolean;
  customer?: { id: string; email: string; name: string; companyName: string | null };
  domains: EngineDomain[];
  hostings: EngineHosting[];
}

/** True when both the URL and the read key are present. */
export function isEngineConfigured(): boolean {
  return BASE_URL.length > 0 && READ_KEY.length > 0;
}

/**
 * The DMS panel a human should be sent to. Derived from the configured engine
 * URL rather than a second env var, so the two can never point at different
 * deployments — a mismatch that would silently send staff to production DMS
 * from a local ResellerOS.
 */
export function dmsPanelUrl(which: "admin" | "customer"): string | null {
  if (BASE_URL.length === 0) return null;
  return which === "admin" ? `${BASE_URL}/admin` : `${BASE_URL}/dashboard`;
}

async function engineGet<T>(path: string): Promise<EngineResult<T>> {
  if (!isEngineConfigured()) {
    return { ok: false, reason: "not_configured" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "GET",
      headers: { "x-integration-key": READ_KEY, accept: "application/json" },
      signal: controller.signal,
      // These are per-request live reads behind a staff page. Caching them would
      // show an admin a domain's expiry that stopped being true hours ago.
      cache: "no-store",
    });

    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "unauthorized" };
    }
    if (!res.ok) {
      return { ok: false, reason: "bad_response", detail: `HTTP ${res.status}` };
    }

    const body = (await res.json()) as T;
    return { ok: true, data: body };
  } catch (err) {
    // An abort lands here too — from the caller's point of view a timeout and a
    // refused connection are the same fact: DMS did not answer.
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "unreachable", detail };
  } finally {
    clearTimeout(timer);
  }
}

/** Is the engine reachable, and what is wired up behind it? */
export function getEngineHealth(): Promise<EngineResult<EngineHealth>> {
  return engineGet<EngineHealth>("/api/integrations/engine/health");
}

/**
 * Every domain and hosting account DMS holds for one email address.
 * `linked: false` means DMS has no account for them — render "no services",
 * not an error.
 */
export function getEngineServices(email: string): Promise<EngineResult<EngineServices>> {
  return engineGet<EngineServices>(
    `/api/integrations/engine/services?email=${encodeURIComponent(email)}`
  );
}
