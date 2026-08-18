import { describe, it, expect } from "vitest";
import {
  SUB_FOLDERS, folderOf, folderCounts, folderMrr, daysToRenewal, suspensionKind,
  type FolderRow,
} from "./folders";

const TODAY = "2026-08-18";

const row = (over: Partial<FolderRow> = {}): FolderRow => ({
  status: "active", renewal_date: "2027-08-18", ...over,
});

/**
 * ─── THE RULE THIS FILE EXISTS FOR ──────────────────────────────────────────
 * The old tabs overlapped: an active subscription renewing in twenty days was counted in
 * Active AND in Expiring 30d. Numbers side by side get added — Pardeep did exactly that
 * with the leads chips. These four are a partition.
 */
describe("the folders add up", () => {
  const rows: FolderRow[] = [
    row(),                                                    // active, a year out
    row({ renewal_date: "2026-09-01" }),                      // expiring, 14 days
    row({ renewal_date: "2026-08-18" }),                      // expiring, today
    row({ renewal_date: "2026-08-01" }),                      // lapsed but still 'active'
    row({ status: "paused" }),                                // suspended
    row({ status: "expired" }),                               // ended
    row({ status: "cancelled" }),                             // ended
  ];

  it("sums to the total, exactly once each", () => {
    const c = folderCounts(rows, TODAY);
    expect(c).toEqual({ active: 1, expiring: 3, suspended: 1, ended: 2 });
    expect(c.active + c.expiring + c.suspended + c.ended).toBe(rows.length);
  });

  it("puts every row in exactly one folder", () => {
    for (const r of rows) {
      const hits = SUB_FOLDERS.filter((f) => folderOf(r, TODAY) === f.id);
      expect(hits).toHaveLength(1);
    }
  });
});

describe("which folder", () => {
  it("counts a renewal inside 30 days as expiring, not active", () => {
    expect(folderOf(row({ renewal_date: "2026-09-17" }), TODAY)).toBe("expiring"); // 30 days
    expect(folderOf(row({ renewal_date: "2026-09-18" }), TODAY)).toBe("active");   // 31
  });

  /**
   * A renewal date already past on a row still marked active is a lapse nobody processed.
   * It is the most urgent thing on the page, and filing it under Active would hide it
   * behind a green dot.
   */
  it("files an already-lapsed active row under Expiring, never Active", () => {
    expect(folderOf(row({ renewal_date: "2025-01-01" }), TODAY)).toBe("expiring");
  });

  it("treats a missing renewal date as active rather than urgent", () => {
    /* No date is not the same as a date that has passed. Guessing urgency from an absent
       value would put every legacy row into the chase list. */
    expect(folderOf(row({ renewal_date: null }), TODAY)).toBe("active");
  });

  /**
   * A suspension outranks a near renewal: the customer has NO service, and telling them
   * about a renewal would be absurd.
   */
  it("suspension outranks an imminent renewal", () => {
    expect(folderOf({ status: "paused", renewal_date: "2026-08-20" }, TODAY)).toBe("suspended");
  });

  it("expired and cancelled both land in Ended", () => {
    expect(folderOf(row({ status: "expired" }), TODAY)).toBe("ended");
    expect(folderOf(row({ status: "cancelled" }), TODAY)).toBe("ended");
  });
});

describe("days to renewal", () => {
  it("counts whole days by DATE, not by elapsed hours", () => {
    /* Otherwise a subscription changes folder depending on the time of day the page is
       opened. */
    expect(daysToRenewal("2026-08-19", TODAY)).toBe(1);
    expect(daysToRenewal("2026-08-18", TODAY)).toBe(0);
    expect(daysToRenewal("2026-08-17", TODAY)).toBe(-1);
  });

  it("is null with no date, and does not throw on rubbish", () => {
    expect(daysToRenewal(null, TODAY)).toBeNull();
    expect(daysToRenewal("not-a-date", TODAY)).toBeNull();
  });
});

describe("money at risk", () => {
  const rows = [
    { status: "active",   renewal_date: "2026-09-01", mrr: 5000 },
    { status: "active",   renewal_date: "2026-09-02", mrr: 3000 },
    { status: "active",   renewal_date: "2027-08-18", mrr: 9000 },
    { status: "expired",  renewal_date: "2025-01-01", mrr: 7000 },
  ];

  it("adds up the MRR of one folder", () => {
    expect(folderMrr(rows, "expiring", TODAY)).toBe(8000);
    expect(folderMrr(rows, "active", TODAY)).toBe(9000);
  });

  it("an ended subscription's MRR is gone, not 'at risk'", () => {
    /* Rolling it into a risk figure would make the number mean nothing. */
    expect(folderMrr(rows, "suspended", TODAY)).toBe(0);
    expect(folderMrr(rows, "ended", TODAY)).toBe(7000);
  });
});

/**
 * A cut-off for non-payment is a debt to collect; a manual pause is usually a favour
 * between projects. Showing them the same way would have a rep chasing money from somebody
 * who was told not to pay.
 */
describe("why it is suspended", () => {
  it("a suspended_at stamp means the dunning cron cut it off", () => {
    expect(suspensionKind({ suspended_at: "2026-08-01T00:00:00Z" })).toBe("auto-unpaid");
  });

  it("no stamp means a human paused it", () => {
    expect(suspensionKind({ suspended_at: null })).toBe("manual");
    expect(suspensionKind({})).toBe("manual");
  });
});
