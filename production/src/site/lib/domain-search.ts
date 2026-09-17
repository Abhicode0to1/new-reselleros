/**
 * The site's domain availability lookup — ONE implementation.
 *
 * It used to live inside the hero's DomainSearch card. The always-on search
 * dock (2 Sep 2026, Pardeep: "domain search home page par ek tool ki tarah
 * hamesha visible ho") needs exactly the same lookup, and two copies of a
 * money-and-availability call is precisely how the two drift — one gets fixed,
 * the other keeps lying. So both call this.
 *
 * It asks the site's own proxy (/api/domains/availability), which forwards to
 * the platform. It NEVER invents a result: an unreachable platform returns an
 * error the UI must show, not a guess (the hero used to decide TAKEN with a
 * string hash — see domain-search.real.test.ts, which pins that regression).
 */

/** Default TLDs to check — the platform prices whatever it recognises. */
export const DEFAULT_TLDS = ["in", "com", "co.in", "org", "net"];

export interface DomainResult {
  domain: string;
  available: boolean;
  /**
   * False when the registrar could not be made to answer for THIS name while
   * answering for the others. Distinct from `available: false`, which is a real
   * "somebody owns it" — and the distinction matters in one direction
   * only: showing TAKEN for a name nobody owns loses a sale silently.
   *
   * Optional so an older payload — or the engine fallback path, which
   * does not send it — reads as checked, which is what it was.
   */
  checked?: boolean;
  price: number;
  currency: string;
  years: number;
  priceKnown: boolean;
}

/**
 * " for 2 years" — or nothing at all when the price buys a single year.
 *
 * A price without its term is only safe while every term is the same. That held
 * until 17 Sep 2026, when `rcTldPricing` started reporting the shortest term a
 * registrar actually sells instead of silently dropping anything without a
 * 1-year price. ResellerClub has exactly one such product on this account —
 * `.ai`, a 2-YEAR MINIMUM at ₹8,807 — and rendering that as a bare "₹8,807"
 * states a price for a term that cannot be bought.
 *
 * Silent at one year on purpose. The reader already assumes a year, and
 * "₹863 for 1 year" on every row of a dense result list is noise that buys
 * nothing. The suffix appears exactly when the assumption would be wrong.
 *
 * `.ai` is not in DEFAULT_TLDS, so today this returns "" every time. It is here
 * so that adding one multi-year TLD to that list cannot quietly put a two-year
 * figure in front of a customer.
 */
export function termSuffix(years: number | undefined | null): string {
  const n = typeof years === "number" && Number.isFinite(years) ? Math.round(years) : 1;
  if (n <= 1) return "";
  return ` for ${n} years`;
}

export type SearchOutcome =
  | { ok: true; base: string; domains: DomainResult[] }
  | { ok: false; message: string };

/** The one message shown when the platform can't answer. Honest, and offers a way on. */
export const UNREACHABLE = "Couldn't check right now — please try again, or WhatsApp us.";

/** Strip a typed name down to what a domain label may contain. */
export function normaliseName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
}

export async function searchDomains(base: string, tlds: readonly string[] = DEFAULT_TLDS): Promise<SearchOutcome> {
  try {
    const res = await fetch(
      `/api/domains/availability?name=${encodeURIComponent(base)}&tlds=${tlds.join(",")}`,
      { cache: "no-store" },
    );
    if (!res.ok) return { ok: false, message: UNREACHABLE };
    const body = (await res.json()) as { base?: string; domains?: DomainResult[] };
    return { ok: true, base: body.base ?? base, domains: body.domains ?? [] };
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
}
