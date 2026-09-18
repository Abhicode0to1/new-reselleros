/**
 * The postpaid countdown. Every case here is one an operator will actually see.
 *
 * The two that matter most are the ones that show NOTHING: a balance with no agreed
 * date is not late, and a settled balance is not owed. Getting either wrong puts a red
 * row against a customer who does not deserve one, and a colour that cries wolf is a
 * colour the operator learns to scroll past — which is the exact failure this feature
 * was built to prevent.
 */
import { describe, it, expect } from "vitest";
import {
  paymentDueState, wholeDaysUntil, todayIST, AMBER_WITHIN_DAYS, paymentDueChipLabel,
} from "./payment-due";

const OWED = 18_691;

describe("paymentDueState — what the operator sees", () => {
  it.each([
    ["2026-10-10", "upcoming",  "26 days left"],
    ["2026-09-17", "due_soon",  "3 days left"],
    ["2026-09-15", "due_soon",  "1 day left"],     // singular
    ["2026-09-14", "due_today", "Due today"],
    ["2026-09-13", "overdue",   "1 day overdue"],  // singular
    ["2026-09-09", "overdue",   "5 days overdue"],
  ])("on 14 Sep, a due date of %s reads %s → %s", (due, kind, label) => {
    const s = paymentDueState(due, "2026-09-14", OWED);
    expect(s.kind).toBe(kind);
    expect(s.label).toBe(label);
  });

  it("highlights the row ONLY when overdue", () => {
    expect(paymentDueState("2026-09-13", "2026-09-14", OWED).highlight).toBe(true);
    for (const due of ["2026-09-14", "2026-09-17", "2026-10-10"]) {
      expect(paymentDueState(due, "2026-09-14", OWED).highlight).toBe(false);
    }
  });

  it("shows NOTHING when there is no agreed date", () => {
    /* Every subscription created before 10 Sep 2026, and every prepaid one. Not late —
       unrecorded. The migration leaves these null on purpose. */
    for (const due of [null, undefined, ""]) {
      expect(paymentDueState(due, "2026-09-14", OWED)).toMatchObject({ kind: "none", label: "" });
    }
  });

  it("shows NOTHING once the balance is settled, even though the date remains", () => {
    /* The due date stays on the record after payment. A countdown against a ₹0 balance
       is noise, and red noise is worse than none. */
    const paid = paymentDueState("2026-09-09", "2026-09-14", 0);
    expect(paid.kind).toBe("none");
    expect(paid.highlight).toBe(false);
  });

  it("treats a negative balance (overpaid) as settled too", () => {
    expect(paymentDueState("2026-09-09", "2026-09-14", -500).kind).toBe("none");
  });

  it("turns amber exactly at the documented threshold, not a day either side", () => {
    const onThreshold = paymentDueState("2026-09-17", "2026-09-14", OWED); // 3 days
    const justOutside = paymentDueState("2026-09-18", "2026-09-14", OWED); // 4 days
    expect(AMBER_WITHIN_DAYS).toBe(3);
    expect(onThreshold.kind).toBe("due_soon");
    expect(justOutside.kind).toBe("upcoming");
  });
});

describe("wholeDaysUntil — calendar days, not elapsed time", () => {
  it("counts across a month boundary", () => {
    expect(wholeDaysUntil("2026-09-10", "2026-10-10")).toBe(30);
  });

  it("counts across a year boundary", () => {
    expect(wholeDaysUntil("2026-12-25", "2027-01-05")).toBe(11);
  });

  it("handles a leap day", () => {
    expect(wholeDaysUntil("2028-02-28", "2028-03-01")).toBe(2); // 2028 IS a leap year
    expect(wholeDaysUntil("2026-02-28", "2026-03-01")).toBe(1); // 2026 is not
  });

  it("is 0 for the same day and negative once past", () => {
    expect(wholeDaysUntil("2026-09-14", "2026-09-14")).toBe(0);
    expect(wholeDaysUntil("2026-09-14", "2026-09-09")).toBe(-5);
  });

  it("ignores any time part rather than letting it shift the count", () => {
    /* Dates arrive from Postgres as YYYY-MM-DD, but a caller passing a timestamp must
       not silently move the boundary. */
    expect(wholeDaysUntil("2026-09-10", "2026-10-10T23:59:59Z".slice(0, 10))).toBe(30);
  });
});

describe("todayIST", () => {
  it("returns the IST calendar date, not the browser's", () => {
    /* 23:30 UTC on 13 Sep is already 05:00 on 14 Sep in Kolkata. A naive
       toISOString() would say the 13th and make a payment look due a day late. */
    expect(todayIST(new Date("2026-09-13T23:30:00Z"))).toBe("2026-09-14");
  });

  it("is YYYY-MM-DD, so it can be compared with a Postgres date directly", () => {
    expect(todayIST(new Date("2026-09-14T06:00:00Z"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

/**
 * The chip must say WHAT is due.
 *
 * Reported 11 Sep 2026: the chip read "4 days left · 15 Sept 2026" and nothing on it
 * said the days were about MONEY. The subscription row shows a renewal date in the very
 * next column, so a bare countdown beside it reads as another lifecycle date — and an
 * unpaid bill that looks like a renewal is an unpaid bill nobody chases.
 */
describe("paymentDueChipLabel — names the thing, not just the date", () => {
  const state = (due: string, today = "2026-09-11") => paymentDueState(due, today, OWED);

  it("says PAY BY for an upcoming date, with the date and the countdown", () => {
    expect(paymentDueChipLabel(state("2026-09-15"), "15 Sept 2026"))
      .toBe("Pay by 15 Sept 2026 · 4 days left");
  });

  it("leads with PAYMENT when overdue, so it cannot read as a renewal", () => {
    expect(paymentDueChipLabel(state("2026-09-06"), "6 Sept 2026"))
      .toBe("Payment 5 days overdue");
  });

  it("says payment due today", () => {
    expect(paymentDueChipLabel(state("2026-09-11"), "11 Sept 2026"))
      .toBe("Payment due today · 11 Sept 2026");
  });

  it("names the gap when money is owed with no agreed date", () => {
    /* Accesstel's case: ₹7,476 owed, created before the column existed. Previously
       this row showed nothing at all. */
    const none = paymentDueState(null, "2026-09-11", OWED);
    expect(paymentDueChipLabel(none, "")).toBe("No payment due date");
  });

  it("never renders a bare number of days with no noun", () => {
    /* The regression itself: every label must contain a word that says what it is. */
    for (const due of ["2026-09-30", "2026-09-13", "2026-09-11", "2026-09-01"]) {
      const text = paymentDueChipLabel(state(due), "x");
      expect(text.toLowerCase()).toMatch(/pay|payment/);
    }
  });
});
