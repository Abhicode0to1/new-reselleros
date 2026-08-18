/**
 * Does this quote's subscription actually exist?
 *
 * ─── WHAT GOES WRONG WITHOUT THIS ───────────────────────────────────────────
 * A subscription is what makes a paid deal keep earning: it carries the renewal date,
 * the seat count and the MRR, and it is the row the renewal cron chases. Delete it — by
 * accident, or while tidying up test data — and the money does not stop, it just stops
 * being *known*. The customer keeps their mailboxes, the reseller keeps paying the
 * vendor, and nothing ever asks for the renewal. It is the quietest way this product can
 * lose a customer's annual revenue.
 *
 * ─── AN ABSENT SUBSCRIPTION IS USUALLY CORRECT, WHICH IS THE HARD PART ──────
 * An accepted quote with no money against it SHOULD have no subscription: `record_payment`
 * creates it when the money arrives. Two of ANUTECH's live accepted quotes are exactly
 * that shape (Q-2026-9776 and Q-2026-9778, both unpaid), and flagging them would train
 * the operator to ignore this warning before it ever caught a real one.
 *
 * So "missing" is only claimed when the subscription is DUE: money received, and the
 * quote is a new sale rather than a renewal or an add-seats top-up, both of which
 * deliberately attach to a subscription that already exists.
 *
 * ─── AND IT COUNTS, RATHER THAN ASKING "IS THERE ONE?" ──────────────────────
 * One quote can create SEVERAL subscriptions — a licence line plus a support-plan line is
 * the normal shape here, and three of ANUTECH's quotes carry exactly two. I nearly read
 * those as duplicates; they are one atomic write, to the microsecond.
 *
 * The consequence is that a check for "zero subscriptions" would miss the more likely
 * accident: two were created, one got deleted. That half-loss is worse than a total one,
 * because the quote still looks connected. So this compares the count of
 * subscription-worthy LINES against the subscriptions that exist.
 */

export interface QuoteLine {
  name?: string | null;
  qty?: number | null;
  rate?: number | null;
}

export interface OrphanInput {
  status: string;
  /** `quotes.payment_status`. 'none' and 'awaiting' both mean no money yet. */
  paymentStatus: string | null | undefined;
  /** ₹ actually received against this quote, across every recorded payment. */
  received: number;
  isRenewal: boolean | null | undefined;
  isAddSeats: boolean | null | undefined;
  lines: readonly QuoteLine[];
  /** Subscriptions whose `quote_id` is this quote. */
  existingSubs: number;
}

export type OrphanState =
  /** No subscription is due yet, and that is correct — not a fault. */
  | { kind: "not-due"; because: string }
  /** Everything the quote should have created exists. */
  | { kind: "healthy"; subs: number }
  /** Money is in and NOTHING was created. */
  | { kind: "missing-all"; expected: number }
  /** Some were created and some are gone — the half-loss a zero-check misses. */
  | { kind: "missing-some"; expected: number; found: number };

/**
 * A line that should become a subscription.
 *
 * Quantity and rate must both be positive. A zero-rate line is a freebie or a note —
 * generate_invoice already refuses a zero-value tax invoice for the same reason — and a
 * zero-quantity line is a leftover row somebody cleared instead of deleting.
 */
export function isSubscriptionLine(l: QuoteLine): boolean {
  return (l.qty ?? 0) > 0 && (l.rate ?? 0) > 0 && Boolean((l.name ?? "").trim());
}

export function orphanState(input: OrphanInput): OrphanState {
  if (input.status !== "accepted") {
    return { kind: "not-due", because: "This quote has not been accepted yet." };
  }
  if (input.isRenewal) {
    /* A renewal rolls the EXISTING subscription's dates forward; it never creates a
       second one, and a new row here would double the MRR. */
    return { kind: "not-due", because: "A renewal extends the existing subscription rather than creating one." };
  }
  if (input.isAddSeats) {
    return { kind: "not-due", because: "An add-seats quote tops up the existing subscription rather than creating one." };
  }

  /* THE GUARD THAT KEEPS THIS WARNING WORTH READING.
     Read the received AMOUNT first and the status label second: the label is something
     somebody has to remember to move, the payments are what happened. */
  const paid = input.received > 0
    || input.paymentStatus === "received"
    || input.paymentStatus === "partial"
    || input.paymentStatus === "invoiced";
  if (!paid) {
    return {
      kind: "not-due",
      because: "No payment recorded yet — the subscription is created when the money arrives.",
    };
  }

  const expected = input.lines.filter(isSubscriptionLine).length;
  if (expected === 0) {
    /* Nothing on the quote could become a subscription — a one-off charge, say. Reporting
       "missing" here would be inventing an expectation. */
    return { kind: "not-due", because: "Nothing on this quote is a recurring line." };
  }

  if (input.existingSubs === 0)        return { kind: "missing-all", expected };
  if (input.existingSubs < expected)   return { kind: "missing-some", expected, found: input.existingSubs };
  return { kind: "healthy", subs: input.existingSubs };
}

/** Is this a fault the operator has to act on? */
export function isOrphan(s: OrphanState): boolean {
  return s.kind === "missing-all" || s.kind === "missing-some";
}

/**
 * The sentence the quote page shows.
 *
 * States the CONSEQUENCE, not the condition. "No subscription found" invites a shrug;
 * "this deal will never be renewed" is the fact that makes somebody press the button.
 */
export function orphanNote(s: OrphanState): string | null {
  switch (s.kind) {
    case "missing-all":
      return `This quote is paid but has no subscription, so nothing will ever chase its renewal and it is missing from your MRR. ${s.expected === 1 ? "One subscription" : `${s.expected} subscriptions`} should exist.`;
    case "missing-some":
      /* Named separately because the quote still LOOKS connected — which is exactly why
         this one goes unnoticed for a year. */
      return `Only ${s.found} of ${s.expected} subscriptions from this quote still exist. The missing ${s.expected - s.found === 1 ? "one" : "ones"} will never be renewed and are absent from your MRR.`;
    case "not-due":
    case "healthy":
      return null;
  }
}

/* ── Which lines have no subscription yet ──────────────────────────────────── */

export interface ExistingSub {
  plan: string | null;
  domain: string | null;
}

/** Same normalisation the DB's unique index uses: `lower(domain)`. */
function key(plan: string | null | undefined, domain: string | null | undefined): string {
  return `${(plan ?? "").trim().toLowerCase()}|${(domain ?? "").trim().toLowerCase()}`;
}

/**
 * The subscription-worthy lines that do NOT already have a subscription.
 *
 * ─── WHY THE RECOVERY CANNOT JUST RE-RUN THE INSERT ─────────────────────────
 * `record_payment` protects itself with `on conflict (tenant_id, quote_id, lower(domain))
 * do nothing`. That index is real — but it is PARTIAL:
 *
 *     WHERE quote_id IS NOT NULL AND domain IS NOT NULL
 *
 * A support-plan line carries no domain (the live ANUTECH ones do not), so those rows sit
 * outside the index entirely and a blind replay would create a second support
 * subscription — inventing MRR out of a repair. Recovery therefore works out what is
 * missing itself and inserts only that.
 *
 * ─── MATCHED ON PLAN + DOMAIN, THE SAME PAIR THE INDEX USES ─────────────────
 * Two Workspace lines on one quote for two different domains are two real subscriptions,
 * so the domain has to be part of the key. Two lines with the same plan AND the same
 * domain are the same subscription and must not double.
 */
export function missingLines<T extends QuoteLine & { domain?: string | null }>(
  lines: readonly T[],
  existing: readonly ExistingSub[],
): T[] {
  /* A multiset, not a Set: if the quote genuinely has two identical lines and only one
     subscription exists, one is still missing. Counting is the only way to see that. */
  const have = new Map<string, number>();
  for (const s of existing) {
    const k = key(s.plan, s.domain);
    have.set(k, (have.get(k) ?? 0) + 1);
  }

  const out: T[] = [];
  for (const l of lines) {
    if (!isSubscriptionLine(l)) continue;
    const k = key(l.name, l.domain);
    const n = have.get(k) ?? 0;
    if (n > 0) have.set(k, n - 1);
    else out.push(l);
  }
  return out;
}
