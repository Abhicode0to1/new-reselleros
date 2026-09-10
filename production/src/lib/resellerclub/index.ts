/**
 * ResellerClub — direct integration (merge Plan B, 2 Sep 2026).
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Pardeep chose the direct route — "wo api to me tumhe bhi de dunga … tum static
 * ip wale kaam ko complete karo" — so this app asks ResellerClub itself, with the
 * same credentials the engine uses, rather than proxying through the engine.
 *
 * ⚠️ CORRECTED 8 Sep 2026. This paragraph used to say the engine
 * "cannot be redeployed: its GCP project's owner account is lost, so its public
 * APIs still 404 and every search on the site dead-ends". Measured:
 * `app.anutech.in/api/health` returns **200**, and its repo
 * (C:\xampp\htdocs\Domain-Management-Project, branch
 * `primary-billing-integration`) was deployed the same morning. The engine is
 * alive and under active development.
 *
 * The direct route is still the right one — it is fewer hops, and the decision
 * to absorb that engine into this app was taken on 8 Sep — but "the engine is
 * dead" was load-bearing in the wrong way: it was the stated reason domain
 * ordering stayed switched off, and it was not true.
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
  /**
   * Strictly `status === "available"`, as the engine decides it — or NULL when
   * this particular name could not be determined. Null exists because of the
   * malformed-key case below: the alternative is a row silently missing from the
   * results, which reads as "we don't offer that" for a name that may be free.
   */
  available: boolean | null;
}

/**
 * ResellerClub sometimes answers a multi-TLD query with ONE CONCATENATED KEY.
 *
 * Ported from the DMS engine's `searchDomainWithTlds` on 10 Sep 2026 — the one
 * thing that function knew which this app did not. Asked for `acme` across
 * `com,net,org`, RC occasionally returns
 *
 *     { "acme.com,net,org": { "status": "available" } }
 *
 * instead of three keys. Our reader mapped that to a single entry named
 * `acme.com,net,org`, so the route's per-TLD lookups all missed and the search
 * returned `{ domains: [] }` with HTTP 200 — an empty result page for a name
 * that might be entirely free, with no error anywhere to explain it.
 *
 * The single status CANNOT be split across the three names: it is one answer to
 * a question about three domains, and guessing which one it describes would be
 * inventing availability. So the affected TLDs are re-asked one at a time, which
 * is what DMS did and the only correct move.
 */
export function looksConcatenated(key: string): boolean {
  return key.includes(",");
}

/** Which TLDs a concatenated key was trying to answer for. */
export function tldsInConcatenatedKey(key: string, name: string): string[] {
  const out: string[] = [];
  const parts = key.split(",").map((x) => x.trim()).filter(Boolean);
  parts.forEach((part, i) => {
    if (i === 0) {
      /* The first part is a whole domain: "acme.com" -> "com". */
      const stripped = part.toLowerCase().startsWith(`${name.toLowerCase()}.`)
        ? part.slice(name.length + 1)
        : part.split(".").slice(1).join(".");
      if (stripped) out.push(stripped.toLowerCase());
    } else {
      /* The rest are bare TLDs: "net", "org". */
      out.push(part.toLowerCase());
    }
  });
  return out;
}

/**
 * Read RC's availability JSON into entries, saying which TLDs still need asking.
 *
 * Pure, so the concatenated-key case can be tested without a network — it is
 * rare enough in the wild that a test is the only thing keeping it handled.
 */
export function parseAvailability(
  data: Record<string, { status?: string } | undefined>,
  name: string,
): { entries: RcAvailability[]; needsRetry: string[] } {
  const entries: RcAvailability[] = [];
  const needsRetry: string[] = [];

  for (const [key, d] of Object.entries(data)) {
    if (!d || typeof d !== "object") continue;
    if (looksConcatenated(key)) {
      needsRetry.push(...tldsInConcatenatedKey(key, name));
      continue;
    }
    entries.push({ domain: key.toLowerCase(), available: d.status === "available" });
  }
  return { entries, needsRetry };
}

async function fetchAvailability(
  name: string,
  tlds: readonly string[],
): Promise<Record<string, { status?: string } | undefined> | null> {
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
    return data;
  } catch (err) {
    console.error("[resellerclub] available unreachable:", (err as Error).message);
    return null;
  }
}

/**
 * Availability for one name across TLDs. Null = upstream unreachable/errored —
 * the caller must say "couldn't check", never guess.
 *
 * An entry with `available: null` means RC answered for the batch but not
 * usefully for that name, and the re-ask failed too.
 */
export async function rcAvailability(
  name: string,
  tlds: readonly string[],
): Promise<RcAvailability[] | null> {
  const data = await fetchAvailability(name, tlds);
  if (!data) return null;

  const { entries, needsRetry } = parseAvailability(data, name);
  if (needsRetry.length === 0) return entries;

  console.warn(
    `[resellerclub] available returned a concatenated key; re-asking ${needsRetry.length} TLD(s) individually`,
  );

  /* One request per affected TLD. Sequential rather than parallel: this is the
     rare path, and a burst of single-TLD calls is the shape a rate limiter
     objects to. The caller caps how many TLDs can be asked for. */
  for (const tld of needsRetry) {
    const one = await fetchAvailability(name, [tld]);
    const hit = one
      ? parseAvailability(one, name).entries.find((e) => e.domain === `${name.toLowerCase()}.${tld}`)
      : undefined;
    entries.push(
      hit ?? {
        /* Still no usable answer. Reported as unknown, never as taken — a name
           shown as taken is one the customer will not try to buy. */
        domain: `${name.toLowerCase()}.${tld}`,
        available: null,
      },
    );
  }
  return entries;
}
