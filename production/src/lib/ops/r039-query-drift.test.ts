/**
 * R-039 — the list query and its test must not drift apart.
 *
 * `supabase/maintenance/r039-monthly-renewals-rolled-a-year.sql` is the file that
 * will actually be run against production. `supabase/tests/r039_damaged_renewals_query.test.sql`
 * proves the query finds the right customers — but it holds its own COPY of the SELECT,
 * because the maintenance file opens a transaction and rolls back, which would discard
 * the test's fixture halfway through.
 *
 * Two copies of a query whose output is a list of customers to telephone is exactly the
 * shape that goes wrong quietly: somebody tunes the live file, the test keeps passing
 * against the old version, and the proof now belongs to a query nobody runs.
 *
 * So this pins the three predicates that DECIDE who is on the list. Not the whole text —
 * formatting and column order may differ and should be allowed to — only the lines where
 * being wrong puts a customer's name on a list, or keeps it off.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const LIVE = "supabase/maintenance/r039-monthly-renewals-rolled-a-year.sql";
const TEST = "supabase/tests/r039_damaged_renewals_query.test.sql";

/** Comments stripped: prose quoting a predicate must not stand in for the predicate (L46). */
const sql = (f: string) =>
  readFileSync(f, "utf8")
    .replace(/^\s*--.*$/gm, "")
    .replace(/\s+/g, " ");

/**
 * The three decisions, and what each one costs when it is wrong.
 *
 * `term_months < 12` — a yearly subscription renewed for a year was never damaged.
 *                      Widen it and healthy annual customers join the list.
 * `interval '45 days'` — the slack that keeps an EARLY renewal off the list. Remove it
 *                      and somebody gets a phone call about a problem they do not have;
 *                      the SQL test's FAIL 4 exists for this and goes red without it.
 * `extension_months = 12` — the bug's actual signature. Without it the query stops
 *                      describing R-012 at all.
 * `payment_status in ('received', 'invoiced')` — no money moved, no damage done. An
 *                      unpaid renewal quote never rolled anything forward.
 */
const DECIDING = [
  "s.term_months < 12",
  "interval '45 days'",
  "q.extension_months = 12",
  "q.payment_status in ('received', 'invoiced')",
] as const;

describe("the R-039 query that will be run on production", () => {
  it.each(DECIDING)("both copies carry: %s", (clause) => {
    const needle = clause.replace(/\s+/g, " ");
    expect(sql(LIVE), `${LIVE} no longer has it`).toContain(needle);
    expect(sql(TEST), `${TEST} is proving a different query`).toContain(needle);
  });

  it("the live file cannot write, whatever is pasted into it", () => {
    /* It runs against PRODUCTION with a human watching, and R-039 says in capitals that
       no data may change. Three separate things have to hold, so a mistake in any one
       of them is still caught by the others. */
    const live = sql(LIVE);
    expect(live).toContain("set local transaction read only");
    expect(live.trimEnd()).toMatch(/rollback;$/);
    expect(live).not.toMatch(/\b(insert into|update |delete from|drop |alter |truncate)\b/i);
  });

  it("says 'unknown' rather than filling in an MRR it cannot know", () => {
    /* AGENTS.md §2. A row with no matching quote still belongs on the list — the damage
       is real — but its corrected MRR is not knowable, and a plausible number in that
       column would be acted on as if it were measured. */
    expect(sql(LIVE)).toContain("else null");
  });
});
