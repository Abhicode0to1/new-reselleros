import { describe, it, expect } from "vitest";
import {
  PORTABLE_SUBSCRIPTION_HEADERS, portableSubscriptionRow,
  mapHeader, monthlyRateFrom, periodMonths,
} from "./subscription-portable";

const sub = {
  customer_number: "CUST-001", customer_name: "Doodh Sang", domain: "doodhsangh.com",
  gstin: "07ABDCA0298H1ZP", state: "Delhi",
  contact_name: "Anjali Tomar", contact_email: "anjali@doodhsangh.com", contact_phone: "9876543210",
  plan: "Google Workspace Starter", vendor: "google", seats: 4, status: "active",
  mrr: 1056, outstanding_amount: 0,
  start_date: "2026-09-11", renewal_date: "2027-09-10", vendor_seats: 2,
};

const asObject = (row: readonly unknown[]) =>
  Object.fromEntries(PORTABLE_SUBSCRIPTION_HEADERS.map((h, i) => [h, row[i]]));

describe("portableSubscriptionRow — what leaves the app", () => {
  it("writes one cell per header, in order", () => {
    expect(portableSubscriptionRow(sub)).toHaveLength(PORTABLE_SUBSCRIPTION_HEADERS.length);
  });

  it("carries the customer AND the contact, so an import can rebuild both", () => {
    /* The contact is not decoration: this app refuses to create a customer without a
       contact person, so a file without one cannot restore a missing customer. */
    expect(asObject(portableSubscriptionRow(sub))).toMatchObject({
      "Customer Number": "CUST-001",
      "Customer": "Doodh Sang",
      "Domain": "doodhsangh.com",
      "GSTIN": "07ABDCA0298H1ZP",
      "Contact Name": "Anjali Tomar",
      "Contact Email": "anjali@doodhsangh.com",
      "Contact Phone": "9876543210",
    });
  });

  it("writes the monthly rate as the authoritative money column", () => {
    expect(asObject(portableSubscriptionRow(sub))["MRR (₹/month)"]).toBe("1056");
  });

  it("writes Item Price PER SEAT PER MONTH, matching what MRR means", () => {
    // ₹1,056/mo across 4 seats = ₹264. A yearly figure here would come back 12× too big
    // for any reader that falls through to this column.
    expect(asObject(portableSubscriptionRow(sub))["Item Price"]).toBe("264");
  });

  it("leaves Vendor Seats BLANK when the vendor was never asked", () => {
    /* 0 would restore as "Google bills us for nothing", which reads as a matched
       subscription rather than an unchecked one. */
    const row = asObject(portableSubscriptionRow({ ...sub, vendor_seats: null }));
    expect(row["Vendor Seats"]).toBe("");
  });

  it("survives a subscription with nothing filled in", () => {
    expect(() => portableSubscriptionRow({})).not.toThrow();
  });
});

describe("mapHeader — reading files this app did not write", () => {
  const lower = (h: readonly string[]) => h.map((x) => x.toLowerCase());

  it("reads its own export", () => {
    const m = mapHeader(lower(PORTABLE_SUBSCRIPTION_HEADERS));
    expect(m.customerNumber).toBe(0);
    expect(m.monthly).toBeGreaterThan(-1);
    expect(m.contactEmail).toBeGreaterThan(-1);
  });

  it("still reads a Zoho Billing file", () => {
    // The format this importer was originally built for must not stop working.
    const m = mapHeader(["customer number", "item name", "quantity", "item price", "start date", "end date"]);
    expect(m.customerNumber).toBe(0);
    expect(m.plan).toBe(1);
    expect(m.seats).toBe(2);
    expect(m.itemPrice).toBe(3);
    expect(m.monthly).toBe(-1);      // no monthly column → the reader derives
  });

  it("still reads the OLD export's names", () => {
    const m = mapHeader(["customer", "plan", "vendor", "domain", "seats", "used", "mrr (₹)", "status"]);
    expect(m.customerName).toBe(0);
    expect(m.plan).toBe(1);
    expect(m.seats).toBe(4);
    expect(m.monthly).toBe(6);
  });

  it("reports -1 for a field the file does not have", () => {
    expect(mapHeader(["customer number"]).gstin).toBe(-1);
  });
});

describe("monthlyRateFrom — the column that must not be wrong", () => {
  it("uses the monthly rate untouched when the file states it", () => {
    // No arithmetic at all — the whole reason the portable format has this column.
    expect(monthlyRateFrom(1056, 264, 4, 12)).toEqual({ ok: true, mrr: 1056, from: "monthly" });
  });

  it("prefers the monthly rate even when a period price is present and disagrees", () => {
    const r = monthlyRateFrom(1056, 99999, 4, 12);
    expect(r).toEqual({ ok: true, mrr: 1056, from: "monthly" });
  });

  it("accepts a genuine zero — free and bundled subscriptions exist", () => {
    expect(monthlyRateFrom(0, null, 4, 12)).toEqual({ ok: true, mrr: 0, from: "monthly" });
  });

  it("derives from the period when there is no monthly column", () => {
    // Zoho-style: ₹3,240/seat for a 12-month term × 10 seats ÷ 12 = ₹2,700/mo.
    expect(monthlyRateFrom(null, 3240, 10, 12)).toEqual({ ok: true, mrr: 2700, from: "period" });
  });

  it("gives the SAME answer whether the file is monthly or annual", () => {
    // ₹270/seat for one month × 10 ÷ 1, and ₹3,240/seat for twelve × 10 ÷ 12.
    expect(monthlyRateFrom(null, 270, 10, 1)).toMatchObject({ mrr: 2700 });
    expect(monthlyRateFrom(null, 3240, 10, 12)).toMatchObject({ mrr: 2700 });
  });

  it("REFUSES rather than assuming a year when the period is unknown", () => {
    /* The old importer defaulted to 12 months here. A monthly subscription with no dates
       silently became a twelfth of itself, and the number looked entirely normal. */
    const r = monthlyRateFrom(null, 270, 10, null);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: expect.stringContaining("Start Date") });
  });

  it("refuses when there is no money in the file at all", () => {
    expect(monthlyRateFrom(null, null, 10, 12).ok).toBe(false);
  });

  it("refuses a per-seat price with no seat count", () => {
    expect(monthlyRateFrom(null, 270, 0, 1).ok).toBe(false);
  });
});

describe("periodMonths", () => {
  it.each([
    ["2026-09-11", "2027-09-10", 12, "a year"],
    ["2026-09-11", "2026-10-10", 1,  "a month"],
    ["2026-01-01", "2027-12-31", 24, "two years"],
    ["2026-01-01", "2026-04-01", 3,  "a quarter"],
  ])("%s → %s is %i months (%s)", (a, b, months) => {
    expect(periodMonths(a, b)).toBe(months);
  });

  it("returns null when a date is missing or unusable", () => {
    expect(periodMonths(null, "2027-09-10")).toBeNull();
    expect(periodMonths("2026-09-11", null)).toBeNull();
    expect(periodMonths("", "")).toBeNull();
    expect(periodMonths("not-a-date", "2027-09-10")).toBeNull();
  });

  it("returns null when the end is not after the start", () => {
    // Reversed or identical dates are a broken row, not a zero-month subscription.
    expect(periodMonths("2027-09-10", "2026-09-11")).toBeNull();
    expect(periodMonths("2026-09-11", "2026-09-11")).toBeNull();
  });
});

describe("the round trip", () => {
  it("returns the exact MRR that was exported, with no arithmetic", () => {
    /* The property the whole format exists for. Export ₹1,056, read it back, get ₹1,056
       — not ₹88, not ₹12,672. */
    const row = asObject(portableSubscriptionRow(sub));
    const back = monthlyRateFrom(
      Number(row["MRR (₹/month)"]),
      Number(row["Item Price"]),
      Number(row["Seats"]),
      periodMonths(String(row["Start Date"]), String(row["End Date"])),
    );
    expect(back).toEqual({ ok: true, mrr: 1056, from: "monthly" });
  });

  it("still lands on the right figure if somebody deletes the MRR column in Excel", () => {
    // Item Price is per-seat-per-month, so × seats ÷ 12 months must NOT be used —
    // the period here is 12, and 264 × 4 / 12 would be ₹88. Proving the fallback is
    // only safe because Item Price is monthly: the reader needs months = 1.
    const row = asObject(portableSubscriptionRow(sub));
    const perSeatMonthly = Number(row["Item Price"]);
    expect(monthlyRateFrom(null, perSeatMonthly, 4, 1)).toEqual({ ok: true, mrr: 1056, from: "period" });
  });
});
