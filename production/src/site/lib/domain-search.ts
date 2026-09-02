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
  price: number;
  currency: string;
  years: number;
  priceKnown: boolean;
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
