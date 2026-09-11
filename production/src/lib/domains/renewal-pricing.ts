/**
 * What a domain renewal costs, and when we must refuse to say.
 *
 * ─── THE PRICE COMES FROM THE RATE CARD, AND ONLY FROM THERE ────────────────
 * `sync_domain_catalog` turns each priced TLD into an `items` row —
 * `DOMAIN-<TLD>-<tenant6>`, `vendor = 'domain'` — carrying `prices.register`,
 * `prices.renew` and `prices.transfer`. A renewal is priced from
 * `prices.renew`, which is a DIFFERENT number from the registration price and
 * usually higher: registrars discount the first year and recover it later. Using
 * `msrp` (the register price) would undercharge every renewal in the book, once a
 * year, quietly.
 *
 * ─── AND WHEN THERE IS NO PRICE, IT REFUSES ─────────────────────────────────
 * A tenant that has never run `Sync domains` has no rate card at all — measured
 * on this database, which has zero `DOMAIN-%` items. The honest answer there is
 * "we cannot price this", not a guessed figure and not zero. A ₹0 renewal quote
 * would be accepted by a customer, paid, and then filed at the registrar at real
 * cost to the reseller's wallet.
 *
 * That is the whole reason this returns a discriminated result rather than a
 * number: the caller has to handle "no price" as a case, and cannot reach a
 * number by accident.
 *
 * ─── TLD MATCHING IS ON THE LONGEST SUFFIX ──────────────────────────────────
 * `.co.in` and `.in` are different TLDs at different prices, and `acme.co.in`
 * ends with both. Matching the shortest — or the first found — prices a `.co.in`
 * renewal at the `.in` rate. The rate card is searched longest-first for exactly
 * that reason.
 */

/** A priced TLD as it sits in the catalogue. */
export interface TldRate {
  /** `items.synced_from_partner_id`, e.g. ".co.in". */
  tld: string;
  /** `items.id`, so the quote line can cite the catalogue row it came from. */
  itemId: string;
  /** `prices.renew`, in whole rupees. Null when the feed carried no renew price. */
  renew: number | null;
  /** `items.wholesale` — what it costs US. Null when never set by hand. */
  wholesale: number | null;
}

export type RenewalPrice =
  | {
      ok: true;
      tld: string;
      itemId: string;
      years: number;
      /** Per year, whole rupees. */
      perYear: number;
      /** `perYear × years`, before tax. */
      subtotal: number;
      /** Our cost for the whole term, or null when unknown. */
      cost: number | null;
    }
  | { ok: false; reason: string; nextStep: string };

/** Whole years, and the same 1–10 bound `rcRenewDomain` enforces. */
export function isRenewalTerm(years: number): boolean {
  return Number.isInteger(years) && years >= 1 && years <= 10;
}

/**
 * The rate for a domain name, matched on its longest TLD suffix.
 *
 * Returns null rather than a fallback — see the header.
 */
export function rateForDomain(domain: string, rates: readonly TldRate[]): TldRate | null {
  const name = (domain ?? "").trim().toLowerCase();
  if (!name) return null;

  /* Longest first: `acme.co.in` must match `.co.in` and never `.in`. */
  const sorted = [...rates].sort((a, b) => b.tld.length - a.tld.length);
  return (
    sorted.find((r) => {
      const tld = r.tld.trim().toLowerCase();
      if (!tld) return false;
      const suffix = tld.startsWith(".") ? tld : `.${tld}`;
      return name.endsWith(suffix);
    }) ?? null
  );
}

export function priceRenewal(args: {
  domain: string;
  years: number;
  rates: readonly TldRate[];
}): RenewalPrice {
  if (!isRenewalTerm(args.years)) {
    return {
      ok: false,
      reason: `${args.years} is not a renewal term we can file (whole years, 1 to 10).`,
      nextStep: "Pick a number of years between 1 and 10.",
    };
  }

  const rate = rateForDomain(args.domain, args.rates);
  if (!rate) {
    return {
      ok: false,
      reason: `There is no rate card entry for ${args.domain}'s extension.`,
      nextStep:
        "Run Sync domains on the Items page to pull the rate card, then raise this renewal again. Do not quote a figure by hand — the renewal is filed at the registrar at whatever it really costs.",
    };
  }

  /* Zero is refused as hard as null. A rate card row with `renew: 0` is a feed
     that did not carry the number, not a free renewal — and a ₹0 quote would be
     accepted, paid, and then filed at real cost to the reseller. */
  if (rate.renew === null || rate.renew === undefined || rate.renew <= 0) {
    return {
      ok: false,
      reason: `The rate card has no renewal price for ${rate.tld}.`,
      nextStep: `Set the renewal price on the ${rate.itemId} catalogue item, or re-run Sync domains, then raise this renewal again.`,
    };
  }

  const perYear = Math.round(rate.renew);
  return {
    ok: true,
    tld: rate.tld,
    itemId: rate.itemId,
    years: args.years,
    perYear,
    /* Whole rupees throughout (CLAUDE.md §13 / AGENTS.md). Multiplied, not
       accumulated, so there is one rounding and not one per year. */
    subtotal: perYear * args.years,
    cost: rate.wholesale != null && rate.wholesale > 0 ? Math.round(rate.wholesale) * args.years : null,
  };
}
