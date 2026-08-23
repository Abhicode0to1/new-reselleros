import { describe, it, expect } from "vitest";
import { formatDocumentNumber, seriesGap, isBlocked, type SeriesState } from "./consequence";

const S: SeriesState = {
  prefix: "RV", docCode: "ADPL", fiscalYear: "FY2627",
  lastNumber: 39, documentCount: 0,
};

describe("formatDocumentNumber", () => {
  it("matches the shape of live rows", () => {
    /* INV-TEST-2026-27-0008 is a real id. A number the operator sees here must be the
       one that appears everywhere else. */
    expect(formatDocumentNumber({ ...S, prefix: "INV", docCode: "TEST" }, 8))
      .toBe("INV-TEST-2026-27-0008");
    expect(formatDocumentNumber(S, 40)).toBe("RV-ADPL-2026-27-0040");
  });

  it("omits a missing doc code instead of printing 'null'", () => {
    /* Excel Technologies' tenant row has doc_code null. */
    expect(formatDocumentNumber({ ...S, docCode: null }, 3)).toBe("RV-2026-27-0003");
    expect(formatDocumentNumber({ ...S, docCode: "  " }, 3)).toBe("RV-2026-27-0003");
  });

  it("pads to four digits without truncating past them", () => {
    expect(formatDocumentNumber(S, 7)).toContain("-0007");
    expect(formatDocumentNumber(S, 10_432)).toContain("-10432");
  });

  it("passes an unrecognised fiscal-year format through unmangled", () => {
    expect(formatDocumentNumber({ ...S, fiscalYear: "2026-27" }, 1))
      .toBe("RV-ADPL-2026-27-0001");
  });
});

describe("seriesGap", () => {
  it("reports a counter running ahead of empty books", () => {
    /* ANUTECH's real state for receipt vouchers: 39 used, none held. */
    const g = seriesGap(S, "receipt voucher");
    expect(g?.tone).toBe("warning");
    expect(g?.text).toMatch(/39 numbers/);
    expect(g?.text).toMatch(/auditor/);
  });

  it("reports a partial gap with the right count and noun", () => {
    const g = seriesGap({ ...S, lastNumber: 10, documentCount: 8 }, "invoice");
    expect(g?.text).toMatch(/^2 numbers/);
    expect(g?.text).toContain("invoice against them");
  });

  it("says nothing when the series and the books agree", () => {
    /* A warning that fires on the healthy case is one nobody reads. */
    expect(seriesGap({ ...S, lastNumber: 8, documentCount: 8 }, "invoice")).toBeNull();
  });

  it("says nothing for an untouched or absent series", () => {
    expect(seriesGap({ ...S, lastNumber: 0, documentCount: 0 }, "invoice")).toBeNull();
    expect(seriesGap(null, "invoice")).toBeNull();
  });

  it("does not report a NEGATIVE gap as a gap", () => {
    /* More documents than numbers should never happen; if it does, it is a different
       bug and inventing a "-3 numbers" sentence would hide it. */
    expect(seriesGap({ ...S, lastNumber: 5, documentCount: 9 }, "invoice")).toBeNull();
  });

  it("gets singular and plural right", () => {
    expect(seriesGap({ ...S, lastNumber: 1, documentCount: 0 }, "invoice")?.text)
      .toMatch(/1 number\b/);
    expect(seriesGap({ ...S, lastNumber: 9, documentCount: 8 }, "invoice")?.text)
      .toMatch(/^1 number\b/);
  });
});

describe("isBlocked", () => {
  it("spots a warning that makes the action impossible", () => {
    expect(isBlocked([{ tone: "warning", text: "This quote has no amount, so nothing can be issued." }])).toBe(true);
  });

  it("does not treat an ordinary caution as a block", () => {
    /* An overpayment is a decision, not an impossibility — blocking it would stop a
       real payment a customer actually made. */
    expect(isBlocked([{ tone: "warning", text: "That is ₹5,000 MORE than the quote's ₹10,000." }])).toBe(false);
  });

  it("is false for facts alone", () => {
    expect(isBlocked([{ tone: "fact", text: "Records ₹1,000." }])).toBe(false);
    expect(isBlocked([])).toBe(false);
  });
});
