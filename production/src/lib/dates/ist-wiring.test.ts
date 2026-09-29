/**
 * R-025 — "aaj" must be the IST day, in every place that writes a date.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC day. IST is UTC+5:30, so between
 * 00:00 and 05:30 IST it is YESTERDAY — and Cloud Run runs in UTC all day long, so the
 * server half is not a browser-timezone accident that only bites early risers.
 *
 * The most expensive instance was the TDS fiscal year on a recorded payment: a payment
 * entered at 01:00 IST on 1 April was stamped 31 March, the PREVIOUS financial year, and
 * the certificate for it then never matches the customer's 26AS.
 *
 * Two kinds of assertion here, because the defect had two halves:
 *   - a behavioural one on the arithmetic (the 02:00 IST case the request names), and
 *   - a SOURCE SCAN on the call sites, because every one of these was a single literal
 *     sitting next to code that already had the right answer (L75 / L98 / L85).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { istToday, toIstDate, utcDateISO } from "./ist";
import { fiscalYearFromDate } from "@/lib/queries/tds-receivable";

/** 01 Apr 2026, 02:00 IST — i.e. 31 Mar 2026, 20:30 UTC. The FY-boundary night. */
const TWO_AM_IST_ON_FY_START = new Date("2026-03-31T20:30:00Z");

describe("02:00 IST on 1 April", () => {
  it("is 1 April in IST and 31 March in UTC — that gap IS the bug", () => {
    expect(TWO_AM_IST_ON_FY_START.toISOString().slice(0, 10)).toBe("2026-03-31");
    expect(istToday(TWO_AM_IST_ON_FY_START)).toBe("2026-04-01");
  });

  it("puts the payment in the NEW financial year", () => {
    /* The old code fed the UTC slice straight into fiscalYearFromDate. FY2526 is the
       year that ended the previous midnight; the money belongs to FY2627. */
    expect(fiscalYearFromDate(TWO_AM_IST_ON_FY_START.toISOString().slice(0, 10))).toBe("FY2526");
    expect(fiscalYearFromDate(istToday(TWO_AM_IST_ON_FY_START))).toBe("FY2627");
  });
});

describe("the two helpers are not interchangeable", () => {
  it("toIstDate shifts an INSTANT; utcDateISO does not shift a UTC-BUILT date", () => {
    // An instant — what `new Date()` gives. Needs the shift.
    expect(toIstDate(new Date("2026-09-28T19:00:00Z"))).toBe("2026-09-29");
    /* A date built from UTC parts (`new Date("2026-09-29T00:00:00Z")` plus whole days,
       or Date.UTC) already IS the calendar date. Shifting it a second time would move
       every renewal validity window forward by a day. */
    expect(utcDateISO(new Date("2026-09-29T00:00:00Z"))).toBe("2026-09-29");
    expect(toIstDate(new Date("2026-09-29T00:00:00Z"))).toBe("2026-09-29");
    // …and the one that would break: 23:00 UTC is already tomorrow in IST.
    expect(utcDateISO(new Date("2026-09-29T23:00:00Z"))).toBe("2026-09-29");
    expect(toIstDate(new Date("2026-09-29T23:00:00Z"))).toBe("2026-09-30");
  });
});

/**
 * Call-site scan. `code` keeps comments STRIPPED, because several of these files now
 * explain the removed literal in prose and a blunt scan would punish that (L46).
 */
const NAIVE = /new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/;
const stripped = (f: string) =>
  readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const SITES = [
  "src/components/features/quotes/record-payment-dialog.tsx",
  "src/components/features/subscriptions/add-subscription-dialog.tsx",
  "src/components/features/subscriptions/edit-subscription-dialog.tsx",
  "src/lib/domains/renewal.ts",
  "src/lib/renewals/create-extension-quote.ts",
  "src/lib/renewals/create-renewal-quote.ts",
  "src/lib/subscriptions/add-seats.ts",
  "src/lib/quotes/auto-quote-for-lead.ts",
  "src/app/(app)/projects/page.tsx",
  "src/app/(app)/projects/[id]/page.tsx",
  "src/app/api/quotes/[id]/recreate-subscription/route.ts",
  "src/components/features/projects/create-project-quote-dialog.tsx",
  "src/components/features/projects/record-project-payment-dialog.tsx",
] as const;

describe("no naive UTC 'today' is left in the Billing & Subscriptions area", () => {
  it.each(SITES)("%s", (file) => {
    expect(stripped(file)).not.toMatch(NAIVE);
  });

  it("add-subscription's start date no longer uses the split('T') spelling either", () => {
    /* Same bug, different syntax — and a regex aimed only at `.slice(0, 10)` would have
       passed it. The seeded start date is what every renewal date is counted from. */
    expect(stripped("src/components/features/subscriptions/add-subscription-dialog.tsx"))
      .not.toMatch(/new Date\(\)\.toISOString\(\)\.split\("T"\)\[0\]/);
  });
});

describe("the payment's fiscal year follows the PAYMENT date, not the wall clock", () => {
  it("record-payment-dialog passes the chosen received date", () => {
    /* Two things were wrong and only one was the timezone. A payment received on
       28 March and entered on 2 April belongs to FY2526 whatever today is. */
    const src = stripped("src/components/features/quotes/record-payment-dialog.tsx");
    expect(src).toContain("fiscalYearFromDate(data.receivedDate || istToday())");
  });
});
