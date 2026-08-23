/**
 * Phase 1: what a customer's reply changes about the lead.
 *
 * ─── THE PROBLEM THIS SOLVES, AND WHY IT IS NOT "A BETTER REPLY" ────────────
 * On 22 Aug 2026 a customer wrote twice to say they wanted 20 users of Business
 * Standard, not 50 of Starter. The reply drafts kept quoting 50/Starter, and three
 * attempts at fixing the REPLY all missed the point: `leads.seats` was still 50 and
 * `leads.plan` was still Starter. Nothing had ever written the correction down. While
 * that is true, every quote, every draft and every renewal derived from that row is
 * wrong too, and each fix is a fresh coat of paint on the same rot.
 *
 * So this writes the customer's own words into the record. The reply then states the
 * current facts because they ARE current.
 *
 * ─── NO MODEL. THE EXTRACTOR ALREADY DOES THIS, DETERMINISTICALLY ───────────
 * `lib/inbound/extract.ts` reads seats and product with tested regexes that already
 * handle how this market actually writes ("20 email id", "20 IDs", "20 licences"), and
 * every value it returns carries the `source` sentence it was read from. That is
 * strictly better here than an LLM: it cannot invent a number, it cannot drift between
 * runs, and the audit trail comes free. A model would add a wait, a cost, a failure
 * mode, and the one risk this must not have.
 *
 * ─── AND IT REFUSES MORE THAN IT ACCEPTS ────────────────────────────────────
 * Every rule below is a reason NOT to write. A wrong automated write is worse than no
 * automated write, because the operator stops checking a field that has been "handled".
 */
import type { ExtractedEntities } from "@/lib/inbound/extract";

/** The lead fields Phase 1 is allowed to touch. Nothing about money or stage. */
export interface LeadFacts {
  seats: number | null;
  plan:  string | null;
}

export interface Correction {
  field: "seats" | "plan";
  /** What the row said. Null when it was blank. */
  from: string | null;
  /** What it will say. */
  to: string;
  /** The value to write, correctly typed for the column. */
  value: number | string;
  /** The customer's own sentence. Non-empty, always — see `skipped` for why. */
  source: string;
}

export interface SkippedCorrection {
  field: "seats" | "plan";
  /** Written for the activity log and for a human asking "why didn't it update?". */
  reason: string;
}

export interface CorrectionPlan {
  corrections: Correction[];
  skipped: SkippedCorrection[];
}

/**
 * Seat bounds, matching the public enquiry schema (`api/public/enquiry/workspace`:
 * `min(1).max(10000)`). A reply reading "we have 250000 employees worldwide" is a fact
 * about the company, not an order, and writing it would blow up every derived figure.
 */
const SEATS_MIN = 1;
const SEATS_MAX = 10_000;

/**
 * The shortest source sentence worth trusting. A one-word source cannot be checked by
 * the operator reading the audit row, which defeats the point of recording it.
 */
const MIN_SOURCE_LEN = 3;

export function planCorrections(args: {
  current: LeadFacts;
  extracted: ExtractedEntities;
  /**
   * The reply text with the quoted thread already removed
   * (`lib/inbound/strip-quoted.ts`). Passed in — not stripped here — so a caller
   * cannot accidentally hand over a raw body: if this is empty, nothing is applied.
   */
  freshText: string;
}): CorrectionPlan {
  const corrections: Correction[] = [];
  const skipped: SkippedCorrection[] = [];

  /* Nothing new was written. A reply that is pure quoted thread — a read receipt, a
     "thanks", a top-post with no content — must never move the record. */
  if (!args.freshText.trim()) {
    return {
      corrections: [],
      skipped: [
        { field: "seats", reason: "no new text in this reply (quoted thread only)" },
        { field: "plan",  reason: "no new text in this reply (quoted thread only)" },
      ],
    };
  }

  // ── seats ────────────────────────────────────────────────────────────────
  const s = args.extracted.seats;
  if (s.value === null) {
    skipped.push({ field: "seats", reason: "no seat count stated in this reply" });
  } else if (!s.source || s.source.trim().length < MIN_SOURCE_LEN) {
    /* A value with nothing quotable behind it cannot be audited, and an unauditable
       automated write is the kind nobody can undo confidently later. */
    skipped.push({ field: "seats", reason: `read ${s.value} but could not quote where from — not applied` });
  } else if (!Number.isInteger(s.value) || s.value < SEATS_MIN || s.value > SEATS_MAX) {
    skipped.push({ field: "seats", reason: `${s.value} is outside ${SEATS_MIN}-${SEATS_MAX}, so it is unlikely to be an order` });
  } else if (s.value === args.current.seats) {
    /* Not a "no change" to report — restating the same number is the customer
       CONFIRMING, and a log line for it is noise. */
  } else {
    corrections.push({
      field: "seats",
      from: args.current.seats === null ? null : String(args.current.seats),
      to: String(s.value),
      value: s.value,
      source: s.source.trim(),
    });
  }

  // ── plan / product ───────────────────────────────────────────────────────
  const p = args.extracted.product;
  const newPlan = p.value?.name?.trim() ?? "";
  if (!newPlan) {
    skipped.push({ field: "plan", reason: "no catalogue product named in this reply" });
  } else if (!p.source || p.source.trim().length < MIN_SOURCE_LEN) {
    skipped.push({ field: "plan", reason: `read "${newPlan}" but could not quote where from — not applied` });
  } else if (samePlan(newPlan, args.current.plan)) {
    /* Same product, possibly spelled differently. Confirmation, not a change. */
  } else {
    corrections.push({
      field: "plan",
      from: args.current.plan?.trim() || null,
      to: newPlan,
      value: newPlan,
      source: p.source.trim(),
    });
  }

  return { corrections, skipped };
}

/**
 * Is this the product the lead already records?
 *
 * `leads.plan` holds two shapes in live data — the catalogue name
 * ("Google Workspace Business Starter") and a slug from the buy page
 * ("google-workspace-starter"). Comparing them raw would report a change on every
 * reply and rewrite the row endlessly, each write logging a "correction" that
 * corrected nothing.
 */
export function samePlan(next: string, current: string | null): boolean {
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const a = norm(next);
  const b = norm(current ?? "");
  if (!b) return false;
  if (a === b) return true;
  /* A slug is usually the name with words dropped ("google-workspace-starter" vs
     "Google Workspace Business Starter"), so containment either way is the same
     product. Deliberately not a fuzzy score: "Business Starter" and
     "Business Standard" are different products and must never collapse. */
  return a.includes(b) || b.includes(a);
}

/**
 * One activity-log line per change, in the operator's terms.
 *
 * The customer's sentence is quoted verbatim and last, because the first question
 * anybody asks about an automated write is "says who?".
 */
export function correctionDetail(c: Correction): string {
  const label = c.field === "seats" ? "Seats" : "Plan";
  const from = c.from ?? "(blank)";
  return `${label}: ${from} → ${c.to} · from the customer's reply: "${truncate(c.source, 160)}"`;
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}
