/**
 * `formatDate` renders IST, on a server that is not in IST.
 *
 * ─── THE BUG THESE PIN, AND WHY NOTHING CAUGHT IT ───────────────────────────
 * Until 11 Sep 2026 the function assembled a date from two different clocks:
 *
 *   const day   = d.getDate();                                   // local zone
 *   const month = d.toLocaleString("en-IN", { month: "short",
 *                           timeZone: "Asia/Kolkata" });         // IST
 *   const year  = d.getFullYear();                               // local zone
 *
 * Production runs on Cloud Run, which is UTC. IST is UTC+5:30, so for any
 * timestamp after 18:30 UTC — the evening in India — the UTC day is one behind
 * the IST day, and the output mixed them. Across a month boundary it produced a
 * date that exists in NEITHER zone:
 *
 *   2026-09-30T19:00:00Z  =  1 Oct 2026, 00:30 IST
 *     old output   30 Oct 2026      ← UTC day 30, IST month October
 *     correct      1 Oct 2026
 *
 * 129 files call this. It renders invoice dates, expiry dates, renewal dates
 * and payment receipts, so the defect was printing a wrong day on money
 * documents and an impossible one at every month end.
 *
 * ─── WHY IT SURVIVED A 7,300-TEST SUITE ─────────────────────────────────────
 * This development machine's timezone IS Asia/Calcutta. Locally the local clock
 * and the pinned clock agree, so the buggy and correct versions are
 * indistinguishable here — every existing test passed either way, and a
 * mutation that swapped the pinned formatter for a local one survived.
 *
 * So these tests FORCE `TZ=UTC`. That is the only configuration where the two
 * implementations disagree, which makes it the only one that proves which is in
 * use. It is also what production actually is.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { formatDate } from "./utils";

let savedTz: string | undefined;

beforeEach(() => {
  savedTz = process.env.TZ;
  /* Node re-reads `process.env.TZ` for subsequent Date operations. Verified on
     this machine: with TZ unset the same timestamp formats as 5 Sept, and with
     TZ=UTC an unpinned formatter gives 4 Sept. */
  process.env.TZ = "UTC";
});

afterEach(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

describe("on a UTC server, dates are still Indian dates", () => {
  it("keeps an evening-IST timestamp on the right day", () => {
    // 00:30 IST on 5 September.
    expect(formatDate("2026-09-04T19:00:00Z")).toBe("5 Sept 2026");
  });

  /* ─── THE ONE THAT PRINTED AN IMPOSSIBLE DATE ────────────────────────────
     The old version took the day from UTC (30) and the month from IST
     (October) and rendered "30 Oct 2026" — a day that is not 30 September in
     UTC nor 1 October in IST. A customer reading it on an invoice has no way
     to reconcile it with anything. */
  it("crosses a month boundary without inventing a date", () => {
    expect(formatDate("2026-09-30T19:00:00Z")).toBe("1 Oct 2026");
  });

  it("crosses a year boundary too", () => {
    // 00:30 IST on 1 January 2027.
    expect(formatDate("2026-12-31T19:00:00Z")).toBe("1 Jan 2027");
  });

  /* Before 18:30 UTC the two zones agree on the day, so this case was always
     right. Kept so a future change cannot fix the evening and break the
     morning. */
  it("leaves a morning timestamp alone", () => {
    expect(formatDate("2026-09-04T06:00:00Z")).toBe("4 Sept 2026");
  });

  it("pins the long form's time to IST as well", () => {
    /* 19:00 UTC is 00:30 IST — the date AND the time have to move together, or
       the output reads "4 Sept 2026 · 12:30 am" for a moment that is neither. */
    const out = formatDate("2026-09-04T19:00:00Z", "long");
    expect(out).toContain("5 Sept 2026");
    expect(out).toMatch(/12:30\s*am/i);
  });

  it("still answers — for nothing, rather than a fake date", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
    expect(formatDate("")).toBe("—");
    expect(formatDate("not-a-date")).toBe("—");
  });

  /* The day must not gain a leading zero: the old implementation used
     `getDate()`, which never pads, and a change to "2-digit" would quietly
     reformat every date in 129 files. */
  it("does not pad the day", () => {
    expect(formatDate("2026-09-04T06:00:00Z")).toBe("4 Sept 2026");
    expect(formatDate("2026-09-04T06:00:00Z")).not.toContain("04");
  });
});
