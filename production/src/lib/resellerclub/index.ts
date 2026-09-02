/**
 * ResellerClub — direct integration (merge Plan B, 2 Sep 2026).
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The engine (app.anutech.in) that used to answer domain availability and
 * pricing cannot be redeployed: its GCP project's owner account is lost, so its
 * public APIs still 404 and every search on the site dead-ends. Pardeep chose
 * the direct route — "wo api to me tumhe bhi de dunga … tum static ip wale kaam
 * ko complete karo" — so this app now asks ResellerClub itself, with the same
 * credentials the engine uses.
 *
 * The endpoints, auth params, product-key mapping and price-block shapes are
 * ported faithfully from the engine's own wrapper
 * (domain-management-system: lib/resellerclub/*, lib/pricing-service.ts,
 * lib/tld-mappings.ts) — measured behaviour, not guessed:
 *   · availability  GET /api/domains/available.json   (status === "available")
 *   · pricing       GET /api/products/customer-price.json
 *                   register = addnewdomain["1"], renew = renewdomain["1"],
 *                   transfer = transferdomain["1"] — 1-year, INR
 *   · auth          auth-userid + api-key as query params
 *
 * ─── THE RULES THIS MODULE KEEPS ─────────────────────────────────────────────
 * 1. READ-ONLY. Availability and prices, nothing else. Registering a domain is
 *    irreversible spend and stays behind the provisioning queue's gates
 *    (lib/provisioning) until Pardeep explicitly opens that door.
 * 2. NEVER INVENTS. A failure returns null and the caller says "couldn't
 *    check" — the same honesty rule the site's search has always kept.
 * 3. SERVER-ONLY. The key lives in Cloud Run env vars; nothing here may be
 *    imported into a client component.
 * 4. Works only from the whitelisted egress IP (34.14.190.227 — the static
 *    NAT set up for exactly this). Locally the env vars are absent, configured()
 *    is false, and callers fall back to the engine URL, which keeps local dev
 *    behaving exactly as before.
 */
import "server-only";
import { tldMappings } from "./tld-mappings";

const BASE = (process.env.RESELLERCLUB_API_URL?.trim() || "https://httpapi.com").replace(/\/+$/, "");
const RESELLER_ID = process.env.RESELLERCLUB_RESELLER_ID?.trim() || "";
const API_KEY = process.env.RESELLERCLUB_API_KEY?.trim() || "";

/** True when the credentials exist — the switch between direct and engine-fallback. */
export function rcConfigured(): boolean {
  return RESELLER_ID.length > 0 && API_KEY.length > 0;
}

function authedUrl(path: string, params: Record<string, string | string[]>): string {
  const u = new URL(`${BASE}${path}`);
  u.searchParams.set("auth-userid", RESELLER_ID);
  u.searchParams.set("api-key", API_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const item of v) u.searchParams.append(k, item);
    else u.searchParams.set(k, v);
  }
  return u.toString();
}

/* ── Pricing ────────────────────────────────────────────────────────────────── */

/** One period-keyed price block from customer-price.json, e.g. { "1": "799.0" }. */
type PriceBlock = Record<string, string | number>;
type ProductPricing = Record<string, PriceBlock | undefined>;
export type CustomerPricingMap = Record<string, ProductPricing | undefined>;

export interface RcTldPrice {
  tld: string;               // ".in"
  register: number | null;   // 1-year, whole ₹
  renew: number | null;
  transfer: number | null;
  currency: string;
}

/**
 * The product key ResellerClub files a TLD under ("in" → "dotin"). The same
 * variation ladder the engine walks, direct mapping first. Exported for tests.
 */
export function productKeyFor(tld: string, pricing: CustomerPricingMap): string | null {
  const clean = tld.replace(/^\.+/, "").toLowerCase();
  const variations = [
    tldMappings[clean],
    clean,
    `.${clean}`,
    clean.toUpperCase(),
    `dot${clean}`,
    `dom${clean}`,
    `centralnicza${clean}`,
    `centralnicus${clean}`,
  ].filter(Boolean) as string[];
  for (const v of variations) if (pricing[v]) return v;
  return null;
}

/** 1-year price out of a period-keyed block; null when absent — never invented. */
function oneYear(block: PriceBlock | undefined): number | null {
  const v = block?.["1"];
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** Extract register/renew/transfer for one TLD from the big map. Exported for tests. */
export function extractTldPrice(tld: string, pricing: CustomerPricingMap): RcTldPrice {
  const clean = tld.replace(/^\.+/, "").toLowerCase();
  const key = productKeyFor(clean, pricing);
  const p = key ? pricing[key] : undefined;
  return {
    tld: `.${clean}`,
    register: oneYear(p?.addnewdomain),
    renew: oneYear(p?.renewdomain),
    transfer: oneYear(p?.transferdomain),
    currency: "INR",
  };
}

/* customer-price.json is a large map covering every product ResellerClub sells,
   and it changes rarely — cached in-module for 10 minutes so a burst of searches
   costs one upstream call, the same idea as the engine's Redis cache without
   needing Redis. Serverless instances each keep their own copy; that is fine,
   it is a cache, not a source of truth. */
let priceCache: { data: CustomerPricingMap; at: number } | null = null;
const PRICE_TTL_MS = 10 * 60 * 1000;

async function customerPricing(): Promise<CustomerPricingMap | null> {
  if (priceCache && Date.now() - priceCache.at < PRICE_TTL_MS) return priceCache.data;
  try {
    const res = await fetch(authedUrl("/api/products/customer-price.json", {}), {
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      /* Log the REAL reason (status + a short, secret-free body slice). Silent
         null is why a failure looked like nothing; ResellerClub's own error
         text — "IP not whitelisted", "invalid api-key" — is what tells us which
         it is. The URL is not logged (it carries the key in query params). */
      const body = await res.text().catch(() => "");
      console.error(`[resellerclub] customer-price HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as CustomerPricingMap;
    if (!data || typeof data !== "object") return null;
    priceCache = { data, at: Date.now() };
    return data;
  } catch (err) {
    console.error("[resellerclub] customer-price unreachable:", (err as Error).message);
    return null;
  }
}

/** Customer prices for the given TLDs. Null = upstream unreachable (be honest). */
export async function rcTldPricing(tlds: readonly string[]): Promise<RcTldPrice[] | null> {
  const pricing = await customerPricing();
  if (!pricing) return null;
  return tlds.map((t) => extractTldPrice(t, pricing));
}

/* ── Availability ───────────────────────────────────────────────────────────── */

export interface RcAvailability {
  domain: string;      // "name.in"
  available: boolean;  // strictly status === "available", as the engine decides it
}

/**
 * Availability for one name across TLDs. Null = upstream unreachable/errored —
 * the caller must say "couldn't check", never guess.
 */
export async function rcAvailability(
  name: string,
  tlds: readonly string[],
): Promise<RcAvailability[] | null> {
  try {
    const res = await fetch(
      authedUrl("/api/domains/available.json", {
        "domain-name": name,
        tlds: tlds.map((t) => t.replace(/^\.+/, "").toLowerCase()),
      }),
      { cache: "no-store", signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[resellerclub] available HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as Record<string, { status?: string } | undefined>;
    if (!data || typeof data !== "object") return null;
    /* An { status: "error" } entry anywhere means the request itself was bad
       (unknown TLD list, auth problem) — same check the engine makes. */
    if (Object.values(data).some((d) => d && typeof d === "object" && d.status === "error")) {
      console.error(`[resellerclub] available returned error entry: ${JSON.stringify(data).slice(0, 200)}`);
      return null;
    }
    return Object.entries(data)
      .filter(([, d]) => d && typeof d === "object")
      .map(([domain, d]) => ({ domain: domain.toLowerCase(), available: d!.status === "available" }));
  } catch (err) {
    console.error("[resellerclub] available unreachable:", (err as Error).message);
    return null;
  }
}
