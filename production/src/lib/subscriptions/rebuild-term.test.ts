import { describe, it, expect } from "vitest";
import { rebuildTerm } from "./rebuild-term";

/* The numbers here are Q-TEST-2026-27-0009, the quote that exposed the bug: a monthly
   Google Workspace line, 10 seats at Rs 3,240, starting 27 July 2026. */
const REAL = { commitment: "monthly", rate: 3240, qty: 10, startDate: "2026-07-27" };

describe("rebuildTerm", () => {
  it("does NOT divide a monthly rate by twelve", () => {
    /* The bug this module exists for. The old route returned 2,700 — a tenth of the money
       — and that number would have gone straight into MRR and into every revenue report. */
    expect(rebuildTerm(REAL).mrr).toBe(32400);
  });

  it("renews a monthly line one MONTH out, not one year", () => {
    expect(rebuildTerm(REAL).renewalDate).toBe("2026-08-27");
  });

  it("gives a monthly line a one-month term, which is what picks the reminder ladder", () => {
    expect(rebuildTerm(REAL).termMonths).toBe(1);
  });

  it("still takes a twelfth of an annual line, where the rate IS the year", () => {
    const t = rebuildTerm({ commitment: "annual_yearly", rate: 3240, qty: 10, startDate: "2026-07-27" });
    expect(t).toEqual({ termMonths: 12, mrr: 2700, renewalDate: "2027-07-27" });
  });

  it("treats a missing commitment as annual — the old behaviour, unchanged", () => {
    /* Every line written before commitments existed has no commitment. Reading those as
       monthly would multiply their MRR by twelve overnight. */
    const t = rebuildTerm({ rate: 1200, qty: 5, startDate: "2026-04-01" });
    expect(t.termMonths).toBe(12);
    expect(t.mrr).toBe(500);
  });

  it("matches 'Monthly' whatever the case and spacing", () => {
    expect(rebuildTerm({ ...REAL, commitment: " Monthly " }).termMonths).toBe(1);
  });

  it("clamps a month-end start the way Postgres does", () => {
    /* 31 Jan + 1 month is 28 Feb. Plain JS Date says 3 March, three days after the service
       lapses — and record_payment, which uses interval '1 month', says 28 Feb. Two builders
       of one row disagreeing about the date is the whole reason this module exists. */
    expect(rebuildTerm({ ...REAL, startDate: "2026-01-31" }).renewalDate).toBe("2026-02-28");
  });

  it("clamps a leap-day annual start too", () => {
    /* The old setFullYear(+1) returned 1 March here. */
    expect(rebuildTerm({ commitment: "annual_yearly", rate: 12, qty: 1, startDate: "2028-02-29" })
      .renewalDate).toBe("2029-02-28");
  });

  it("rounds MRR to whole rupees, because the column is an integer", () => {
    expect(rebuildTerm({ commitment: "annual_yearly", rate: 1000, qty: 1, startDate: "2026-07-27" }).mrr)
      .toBe(83);
  });

  it("survives a line with no rate or quantity rather than producing NaN", () => {
    expect(rebuildTerm({ commitment: "monthly", startDate: "2026-07-27" }).mrr).toBe(0);
  });
});
