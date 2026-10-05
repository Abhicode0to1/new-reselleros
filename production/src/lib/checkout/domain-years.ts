/**
 * Buying a domain for more than one year (Pawan, 5 Oct 2026) — built, SWITCHED OFF.
 *
 * The cart can carry a years choice on a domain line (1, 2, 3, 5 or 10) and the checkout
 * prices it. It stays off on the live site until three other parts land, because each one
 * left out turns "paid for 3 years" into "registered or renewed as if it were 1":
 *
 *   1. The price for N years (Abhishek, lib/domains/live-lookup.ts). ResellerClub quotes a
 *      per-year price for each tenure; the lookup must fill `LiveDomain.pricePerYearByTenure`.
 *      Until it does, a line above 1 year is refused with a reason — never charged at the
 *      1-year price × N, which is a guess.
 *   2. The years on the queued registration (R-031, Abhishek: `provisioning_requests.years`,
 *      written from the paid line's `years`). The register cron already sends a row's years
 *      (R-035) and DMS's `domain.register` takes 1–10.
 *   3. The domain subscription's renewal date N years out (lib/domains/renewal.ts
 *      `domainSubscriptionInsert` sets +1 year), or the renewal reminders start after a year.
 *
 * When all three are in, set MULTI_YEAR_DOMAINS_READY to true. On a developer machine the
 * picker can be tried before that with NEXT_PUBLIC_MULTI_YEAR_DOMAINS_LOCAL=1 (ignored in a
 * production build); a line above 1 year is then still refused until part 1 exists.
 *
 * Bundled with a yearly hosting plan, the domain's FIRST year is free (the bundle rule in
 * cart-checkout.ts); further years are charged. Owner to confirm.
 */

export const MULTI_YEAR_DOMAINS_READY = false;

/** The choices the picker offers. ResellerClub registers 1–10 years. */
export const DOMAIN_YEAR_OPTIONS = [1, 2, 3, 5, 10] as const;

type Env = Record<string, string | undefined>;

/**
 * Whether the years picker is shown and a years choice is accepted. Reads only NODE_ENV and a
 * NEXT_PUBLIC_ variable, so the browser and the server answer the same.
 */
export function multiYearDomainsOn(
  env: Env = { NODE_ENV: process.env.NODE_ENV, NEXT_PUBLIC_MULTI_YEAR_DOMAINS_LOCAL: process.env.NEXT_PUBLIC_MULTI_YEAR_DOMAINS_LOCAL },
  ready: boolean = MULTI_YEAR_DOMAINS_READY,
): boolean {
  if (ready) return true;
  return env.NODE_ENV !== "production" && env.NEXT_PUBLIC_MULTI_YEAR_DOMAINS_LOCAL?.trim() === "1";
}

/** A stored or posted years value, made safe: anything not on the list reads as 1. */
export function cleanDomainYears(raw: unknown): number {
  const n = Number(raw);
  return (DOMAIN_YEAR_OPTIONS as readonly number[]).includes(n) ? n : 1;
}

/** "1 year" / "3 years". */
export function yearsLabel(years: number): string {
  return `${years} year${years === 1 ? "" : "s"}`;
}

export type DomainYearsPrice =
  | { ok: true; years: number; perYear: number; total: number }
  | { ok: false; reason: string };

/**
 * What N years of one domain cost, from the live lookup's row. One year is the 1-year price,
 * as today. More than one needs the per-year price for THAT tenure; without it the answer is
 * a refusal, never the 1-year price multiplied.
 */
export function priceDomainYears(
  hit: { domain: string; price: number; pricePerYearByTenure?: Partial<Record<number, number>> },
  years: number,
  on: boolean = multiYearDomainsOn(),
): DomainYearsPrice {
  if (years === 1) return { ok: true, years: 1, perYear: hit.price, total: Math.round(hit.price) };
  if (!on) {
    return { ok: false, reason: `${hit.domain} (domains are registered for 1 year at a time for now — set it to 1 year in the cart)` };
  }
  if (!(DOMAIN_YEAR_OPTIONS as readonly number[]).includes(years)) {
    return { ok: false, reason: `${hit.domain} (choose 1, 2, 3, 5 or 10 years)` };
  }
  const perYear = hit.pricePerYearByTenure?.[years];
  if (typeof perYear !== "number" || !(perYear > 0)) {
    return { ok: false, reason: `${hit.domain} (its price for ${yearsLabel(years)} couldn't be confirmed — choose 1 year, or try again later)` };
  }
  return { ok: true, years, perYear, total: Math.round(perYear * years) };
}
