/**
 * Which quotes belong to THIS enquiry.
 *
 * ─── WHY lead_id ALONE WAS NOT ENOUGH ───────────────────────────────────────
 * The already-quoted banner keyed on lead_id and nothing else, which sounded exact and was
 * nearly useless. In ANUTECH's live books on 18 Aug 2026, ELEVEN of thirteen quotes carry
 * `lead_id = null` — including Q-…-0010 and Q-…-0011, the two ₹1,34,138 duplicates fifteen
 * minutes apart that this whole guard exists to prevent. The banner could not see either of
 * them, so the screen said "Send quote" and would have cheerfully allowed a third.
 *
 * lead_id is null on most quotes because it is only written when the builder is opened FROM
 * a lead. Open /quotes directly, or pick an existing customer, and the row is filed under
 * customer_id or a typed customer_name instead. A guard that only understands one of three
 * filing systems is a guard that is off most of the time.
 *
 * ─── SO IT MATCHES ON THREE THINGS, AND SAYS WHICH ONE ──────────────────────
 * lead id, customer id, and — last — an exact name. They are not equally trustworthy, so
 * the match carries its own basis and the banner prints it. "Matched by name" invites the
 * two seconds of checking that "already quoted" does not.
 *
 * ─── AND IT OVER-MATCHES ON PURPOSE ─────────────────────────────────────────
 * Two different people called Pardeep Sharma would collide on the name rule. That is the
 * safe direction to be wrong in, because this warns and never blocks: the cost of a false
 * positive is a rep reading one extra line; the cost of a false negative is the customer
 * holding two quotes at two prices and asking which one is real. That already happened.
 *
 * The name rule is deliberately EXACT after trimming and case-folding — no fuzzy matching,
 * no first-name-only, no company-contains. "Sharma Traders" and "Sharma Enterprises" are
 * different businesses, and a guard nobody believes is worse than no guard.
 */

export type MatchBasis = "lead" | "customer" | "name";

export interface QuoteCandidate {
  id: string;
  createdAt: string;
  /** ₹, whole rupees. */
  amount: number;
  status?: string | null;
  leadId?: string | null;
  customerId?: string | null;
  /** `quotes.customer_name` — free text, present even on prospect-only quotes. */
  customerName?: string | null;
}

/** Who this enquiry is about, from the lead it converted to and what the extractor read. */
export interface EnquiryIdentity {
  leadId?: string | null;
  customerId?: string | null;
  /** Names worth matching on: the contact, and the lead's company. */
  names?: readonly (string | null | undefined)[];
}

export interface MatchedQuote extends QuoteCandidate {
  /** How this one was tied to the enquiry. Shown, because they differ in strength. */
  via: MatchBasis;
}

/** Case-folded, whitespace-collapsed. Nothing else — see the header on fuzzy matching. */
function norm(s: string | null | undefined): string {
  return (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Too short or too generic to identify anybody.
 *
 * "Prospect" is what the quote builder saves when no name was given, so matching on it
 * would tie together every unnamed quote in the tenant.
 */
const USELESS_NAMES: ReadonlySet<string> = new Set([
  "", "prospect", "customer", "client", "n/a", "na", "unknown", "test", "-",
]);

function usableName(s: string | null | undefined): string {
  const n = norm(s);
  return n.length >= 4 && !USELESS_NAMES.has(n) ? n : "";
}

export function matchQuotesToEnquiry(
  identity: EnquiryIdentity,
  quotes: readonly QuoteCandidate[],
): MatchedQuote[] {
  const wantLead     = (identity.leadId ?? "").trim();
  const wantCustomer = (identity.customerId ?? "").trim();
  const wantNames    = new Set((identity.names ?? []).map(usableName).filter(Boolean));

  const out: MatchedQuote[] = [];
  for (const q of quotes) {
    /* Strongest first, and only one basis is recorded — the one that actually decided it. */
    if (wantLead && (q.leadId ?? "").trim() === wantLead) {
      out.push({ ...q, via: "lead" });
      continue;
    }
    if (wantCustomer && (q.customerId ?? "").trim() === wantCustomer) {
      out.push({ ...q, via: "customer" });
      continue;
    }
    const qn = usableName(q.customerName);
    if (qn && wantNames.has(qn)) {
      out.push({ ...q, via: "name" });
    }
  }
  return out;
}

/**
 * The weakest basis in a set of matches — that is what the banner must own up to.
 *
 * If one quote matched on lead id and another only on a name, the honest headline is the
 * name: reporting the strongest would let the shakier match ride on its confidence.
 */
export function weakestBasis(matches: readonly MatchedQuote[]): MatchBasis | null {
  if (matches.length === 0) return null;
  if (matches.some((m) => m.via === "name")) return "name";
  if (matches.some((m) => m.via === "customer")) return "customer";
  return "lead";
}

/** The caveat printed after the count. Empty when the match is by id and needs none. */
export function basisCaveat(basis: MatchBasis | null): string {
  switch (basis) {
    case "name":
      /* Says what to check, not just that it is uncertain — §24. */
      return " Matched by customer name, so check it is the same person before you rely on it.";
    case "customer":
    case "lead":
    case null:
      return "";
  }
}
