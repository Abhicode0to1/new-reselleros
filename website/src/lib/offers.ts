/**
 * Time-boxed price offers — today: ".in domain ₹1, this month".
 *
 * Pardeep, 1 Sep 2026: "domain ke liye offer nikalna chahta hoon — is mahine .in domain
 * 1 INR me."
 *
 * ─── THE RULE THAT MATTERS: AN OFFER ENDS ITSELF ────────────────────────────
 * `until` is checked at render time, so on 1 October the site returns to the normal rate
 * with NO deploy and NO reminder. A forgotten banner selling ₹1 domains in November is
 * not a marketing bug, it is a wrong price on a public page — the same disease as every
 * other wrong figure this project has fought.
 *
 * The offer touches the FIRST YEAR only. The renewal stays printed beside it at full
 * rate, because "renewal price next to the first-year price" is this site's whole
 * positioning — an offer that hides the renewal would unsay the Why-us page.
 *
 * ⚠️ Like every price here, this drives the DISPLAY and the cart line. Checkout does not
 * charge yet, and whether domains are a real Anutech offering is still the open decision
 * flagged in README.md. The mechanism is real; the commercials remain Pardeep's.
 */

export interface DomainOffer {
  /** First-year price during the offer, ₹. */
  price: number;
  /** Chip text — kept short, it renders inline in tables. */
  label: string;
  /** Last day (inclusive), IST. */
  until: string; // YYYY-MM-DD
}

export const DOMAIN_OFFERS: Readonly<Record<string, DomainOffer>> = {
  ".in": { price: 1, label: "SEPTEMBER OFFER", until: "2026-09-30" },
};

/** IST "today", so the offer flips at Indian midnight — where the customers are. */
function istToday(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

export interface EffectivePrice {
  /** What the buyer pays for year one. */
  reg: number;
  /** Present only while an offer is live. */
  offer?: { was: number; label: string };
}

export function effectiveReg(tld: string, normalReg: number, now: Date = new Date()): EffectivePrice {
  const o = DOMAIN_OFFERS[tld];
  if (!o) return { reg: normalReg };
  if (istToday(now) > o.until) return { reg: normalReg };
  /* An "offer" above the normal rate is a data error, not a discount — refuse it. */
  if (o.price >= normalReg) return { reg: normalReg };
  return { reg: o.price, offer: { was: normalReg, label: o.label } };
}
