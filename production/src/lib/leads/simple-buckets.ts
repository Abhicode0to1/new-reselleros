/**
 * The four buckets the simple leads page draws, and the promise that they add up.
 *
 * ─── WHY THIS IS A MODULE AND NOT A useMemo IN THE PAGE ──────────────────────
 * Pardeep has asked three times how the counts on the leads page can be right. The old
 * answer was a comment explaining that the folders partition; this is the same claim made
 * as code that a test can fail. `bucketLeads` returns EVERY lead in exactly one bucket and
 * exports the arithmetic, so the page can print "2 + 12 + 15 = 29" from the same numbers it
 * rendered rather than from a second count that can drift.
 *
 * ─── THE BUG THIS SHAPE EXISTS TO PREVENT ───────────────────────────────────
 * A partition of three (open / won / junk) silently drops a lead that is `lost` and NOT
 * junk. There are none in this workspace today, so a three-way split would have looked
 * correct for as long as nobody lost a real deal. `closedOther` catches them, and
 * `everyLeadPlaced` is asserted rather than assumed.
 *
 * Measured against the live workspace on 25 Aug 2026: 29 leads = 2 open + 12 won +
 * 15 junk records + 0 lost-not-junk. Those 15 junk records are only SIX companies —
 * Kavita Iyer appears four times — which is why they are grouped rather than listed.
 */

import type { Lead } from "@/lib/supabase/database.types";

/** Stages a lead can sit in while still being live work. */
const OPEN_STAGES = ["new", "contact", "demo", "trial", "quote"] as const;

export type OpenStage = (typeof OPEN_STAGES)[number];

/** Same test the big page uses (`leads/page.tsx`), lifted so both can share one truth. */
export function isOpenLead(l: Pick<Lead, "stage" | "is_junk">): boolean {
  return l.stage !== "won" && l.stage !== "lost" && !l.is_junk;
}

export interface DuplicateGroup {
  /** The company name these records share, exactly as stored. */
  company: string;
  /** Every record for that company, newest first. */
  records: Lead[];
  /** Seats, if any record has them — a merge needs something to keep. */
  seats: number | null;
}

export interface Buckets {
  /** Open work, in the order the page should show it. */
  todo: readonly Lead[];
  won: readonly Lead[];
  /** Junk, grouped by company: 15 records become 6 rows. */
  duplicates: readonly DuplicateGroup[];
  /** Lost but NOT junk — a real lost deal. Zero today; not dropped. */
  closedOther: readonly Lead[];
  counts: {
    todo: number;
    won: number;
    /** Junk ROWS, which is what has to add up. */
    duplicateRecords: number;
    /** Distinct companies inside those rows — the number worth showing. */
    duplicatePeople: number;
    closedOther: number;
    total: number;
  };
  /** Money on the open work, whole rupees. Nulls count as zero. */
  openValue: number;
  wonValue: number;
  /** False means a lead went missing — the page must not render a total. */
  everyLeadPlaced: boolean;
}

/**
 * Which lead needs attention first.
 *
 * ─── WHAT THIS CANNOT DO YET, STATED RATHER THAN FAKED ──────────────────────
 * Pardeep's rule is "whoever asked first" — a customer's unanswered question outranks a
 * reminder you set for yourself. The `leads` table cannot express that: there is no column
 * saying when THEY last wrote, only `updated_at` for when the row last changed. So this
 * sorts by the closest thing the data supports — a follow-up date that has come due, then
 * the longest-untouched row — and the gap is a known one, not a silent approximation.
 */
function urgency(a: Lead, b: Lead): number {
  /* ─── NOT `Infinity` FOR AN UNDATED LEAD ──────────────────────────────────
     The first cut mapped a null follow-up to POSITIVE_INFINITY and subtracted.
     Two undated leads then gave `Infinity - Infinity` = NaN, `NaN !== 0` is true,
     so the comparator returned NaN and the sort silently did nothing — the tie-break
     below was unreachable. Caught by its own test, which is why the test exists.
     Dated-vs-undated is a decision, not a subtraction. */
  const da = a.follow_up_date ? Date.parse(a.follow_up_date) : null;
  const db = b.follow_up_date ? Date.parse(b.follow_up_date) : null;
  if (da !== null && db !== null && da !== db) return da - db;
  if (da !== null && db === null) return -1; // a promise you made beats one you never made
  if (da === null && db !== null) return 1;

  /* Both undated, or due the same day: the one nobody has touched for longest. */
  const touched = (l: Lead) => Date.parse(l.updated_at ?? l.created_at ?? "") || 0;
  return touched(a) - touched(b);
}

export function bucketLeads(leads: readonly Lead[]): Buckets {
  const todo: Lead[] = [];
  const won: Lead[] = [];
  const junk: Lead[] = [];
  const closedOther: Lead[] = [];

  for (const l of leads) {
    /* Junk first: a junk lead also carries a stage (all 15 here are `lost`), so testing
       stage before is_junk would count the same row in two buckets — which is exactly
       how "Junk 15 + Won 12 + Lost 15" came to exceed a total of 29. */
    if (l.is_junk) junk.push(l);
    else if (l.stage === "won") won.push(l);
    else if (l.stage === "lost") closedOther.push(l);
    else todo.push(l);
  }

  todo.sort(urgency);
  won.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  /* Group junk by company so 15 records read as the 6 people they are. */
  const byCompany = new Map<string, Lead[]>();
  for (const l of junk) {
    const key = (l.company ?? "").trim() || "(no name)";
    const list = byCompany.get(key);
    if (list) list.push(l);
    else byCompany.set(key, [l]);
  }
  const duplicates: DuplicateGroup[] = [...byCompany.entries()]
    .map(([company, records]) => ({
      company,
      records: [...records].sort(
        (a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? ""),
      ),
      seats: records.find((r) => (r.seats ?? 0) > 0)?.seats ?? null,
    }))
    /* Worst duplication first — that is the one worth merging. */
    .sort((a, b) => b.records.length - a.records.length || a.company.localeCompare(b.company));

  const sum = (xs: readonly Lead[]) => xs.reduce((n, l) => n + (l.value ?? 0), 0);

  const counts = {
    todo: todo.length,
    won: won.length,
    duplicateRecords: junk.length,
    duplicatePeople: duplicates.length,
    closedOther: closedOther.length,
    total: leads.length,
  };

  return {
    todo,
    won,
    duplicates,
    closedOther,
    counts,
    openValue: sum(todo),
    wonValue: sum(won),
    everyLeadPlaced:
      counts.todo + counts.won + counts.duplicateRecords + counts.closedOther === counts.total,
  };
}

/**
 * The one thing to do next for a lead, as a verb the rep can act on.
 *
 * Stage names never reach the screen. "contact" and "quote" are this codebase's words, and
 * a rep should not have to learn the difference to know that one needs a quote written and
 * the other needs a phone call.
 */
export interface NextStep {
  /** The button's own words. */
  action: string;
  /** Why it is the next step, in a sentence. */
  because: string;
  /** True when the lead has no follow-up date at all — the gap worth naming. */
  unscheduled: boolean;
}

export function nextStep(l: Pick<Lead, "stage" | "follow_up_date" | "created_at">): NextStep {
  const unscheduled = !l.follow_up_date;

  if (l.stage === "quote") {
    return unscheduled
      ? {
          action: "Pick a day",
          because: "Their quote has gone out. No day was ever chosen, so nothing is chasing it.",
          unscheduled,
        }
      : { action: "Call them", because: "Their quote has gone out and today is the day you chose.", unscheduled };
  }

  if (l.stage === "demo" || l.stage === "trial") {
    return { action: "Check in", because: "They are trying it. Ask how it is going before the trial runs out.", unscheduled };
  }

  /* new / contact — nothing has been priced yet. */
  return {
    action: "Send a quote",
    because: unscheduled
      ? "Nothing has been priced for them yet, and no day is set to do it."
      : "Nothing has been priced for them yet.",
    unscheduled,
  };
}
