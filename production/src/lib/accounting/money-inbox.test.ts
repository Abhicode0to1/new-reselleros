import { describe, it, expect } from "vitest";
import {
  MONEY_FOLDERS, moneyInboxState, gstFolderState, totalOpenItems, urgentFolders,
  type MoneyInboxInput,
} from "./money-inbox";

const empty: MoneyInboxInput = {
  receivables: [], unmatchedCredits: [], billsDue: [], gstNet: 0,
};

const live: MoneyInboxInput = {
  receivables: [
    { amountDue: 40_000, daysOverdue: 9 },
    { amountDue: 16_000, daysOverdue: -2 },   // not due yet
  ],
  unmatchedCredits: [{ amount: 2_700, daysOld: 12 }],
  billsDue: [{ amountDue: 12_000, daysOverdue: 0 }],
  gstNet: 8_100,
};

describe("the four folders are four different KINDS of thing", () => {
  it("gives each one its own noun, never 'items'", () => {
    /* "3 items" tells a reseller nothing. "3 bills" tells them who to pay. */
    for (const f of MONEY_FOLDERS) {
      expect(f.noun.length).toBeGreaterThan(3);
      expect(f.noun).not.toBe("items");
    }
  });

  it("marks which way the money moves, so the UI cannot colour them alike", () => {
    const dir = Object.fromEntries(MONEY_FOLDERS.map((f) => [f.id, f.direction]));
    expect(dir.receivables).toBe("in");
    expect(dir.unmatched_credits).toBe("in");
    expect(dir.bills_due).toBe("out");
    expect(dir.gst).toBe("government");
  });

  it("orders them by what moves cash soonest — receivables first", () => {
    /* Chasing receivables is the only one of the four that BRINGS money in, and the one
       a reseller postpones because it is socially awkward. */
    expect(MONEY_FOLDERS.map((f) => f.id)).toEqual(
      ["receivables", "unmatched_credits", "bills_due", "gst"]);
  });

  it("says what an EMPTY folder means, not just that it is empty", () => {
    for (const f of MONEY_FOLDERS) {
      expect(f.emptyHint.length).toBeGreaterThan(25);
      expect(f.emptyHint.toLowerCase()).not.toBe("nothing here");
    }
  });

  it("does not let the receivables folder claim more than it counts", () => {
    /* Browser-caught. The hint read "Nobody owes you money" — correct for invoices
       (all 8 of ANUTECH's are paid) and printed directly under a KPI reading
       "OWED TO YOU ₹1,33,576", which also carries project receivables, TDS credits and
       staff advances. Two right numbers reading as a contradiction is the same failure
       as the leads chips, on a money screen. */
    const recv = MONEY_FOLDERS.find((f) => f.id === "receivables")!;
    expect(recv.emptyHint).not.toMatch(/nobody owes you money/i);
    expect(recv.emptyHint).toMatch(/invoices/i);
  });

  it("points every folder at the page that does the actual work", () => {
    /* The inbox triages. It does not replace 28 working accounting pages. */
    for (const f of MONEY_FOLDERS) expect(f.href).toMatch(/^\//);
  });
});

/**
 * ─── THE RULE THAT SEPARATES THIS FROM THE LEADS CHIPS ──────────────────────
 * Leads folders partition one list, so their counts must sum. These four count
 * different tables in different directions, so a grand rupee total would be
 * meaningless — and on a money screen a meaningless total is one somebody reports
 * upward.
 */
describe("there is no grand total, and that is deliberate", () => {
  it("exposes a count of ROWS but no summed rupee figure", () => {
    const s = moneyInboxState(live);
    expect(totalOpenItems(s)).toBe(2 + 1 + 1 + 1);
    /* If a totalAmount() ever appears in this module, this test should be the argument
       against it: ₹56,000 owed to you plus ₹12,000 you owe is not ₹68,000, it is two
       numbers pointing opposite ways. */
    expect(Object.keys({ moneyInboxState, gstFolderState, totalOpenItems, urgentFolders }))
      .not.toContain("totalAmount");
  });

  it("keeps every folder amount POSITIVE — direction carries the sign", () => {
    const s = moneyInboxState({ ...live, gstNet: -5_000 });
    for (const f of MONEY_FOLDERS) expect(s[f.id].amount).toBeGreaterThanOrEqual(0);
  });
});

describe("receivables — the folder that brings money in", () => {
  it("counts every unpaid invoice but flags only the late ones", () => {
    const s = moneyInboxState(live);
    expect(s.receivables.count).toBe(2);
    expect(s.receivables.amount).toBe(56_000);
    expect(s.receivables.urgent).toBe(true);
  });

  it("names the OVERDUE amount, not the total, in the reason", () => {
    /* ₹40,000 of it being late is what decides whether the phone gets picked up this
       morning. "₹56,000 outstanding" does not. */
    expect(moneyInboxState(live).receivables.urgentReason).toContain("40000");
  });

  it("is not urgent when nothing has passed its due date", () => {
    const s = moneyInboxState({ ...empty, receivables: [{ amountDue: 90_000, daysOverdue: -3 }] });
    expect(s.receivables.count).toBe(1);
    expect(s.receivables.urgent).toBe(false);
    expect(s.receivables.urgentReason).toBeNull();
  });

  it("treats due-today as late — there is no grace worth inventing", () => {
    const onTime = moneyInboxState({ ...empty, receivables: [{ amountDue: 100, daysOverdue: 0 }] });
    expect(onTime.receivables.urgent).toBe(false);
    const late = moneyInboxState({ ...empty, receivables: [{ amountDue: 100, daysOverdue: 1 }] });
    expect(late.receivables.urgent).toBe(true);
  });
});

describe("unmatched credits — money in the bank the books cannot see", () => {
  it("goes urgent once a deposit has sat unexplained for a week", () => {
    const s = moneyInboxState(live);
    expect(s.unmatched_credits.count).toBe(1);
    expect(s.unmatched_credits.amount).toBe(2_700);
    expect(s.unmatched_credits.urgent).toBe(true);
  });

  it("says the thing that is actually wrong — the cash is right, the books are not", () => {
    /* This is the sentence that makes a reseller act. "1 unreconciled transaction"
       sounds like tidying; "your books are wrong" is a different priority. */
    expect(moneyInboxState(live).unmatched_credits.urgentReason)
      .toMatch(/cash balance is right and your books are not/);
  });

  it("stays calm about a deposit that landed yesterday", () => {
    const s = moneyInboxState({ ...empty, unmatchedCredits: [{ amount: 50_000, daysOld: 1 }] });
    expect(s.unmatched_credits.count).toBe(1);
    expect(s.unmatched_credits.urgent).toBe(false);
  });
});

describe("bills due — money going out", () => {
  it("explains the real cost of a late vendor bill", () => {
    /* A suspended wholesale licence takes the CUSTOMER down, not just the licence. */
    const s = moneyInboxState({ ...empty, billsDue: [{ amountDue: 12_000, daysOverdue: 4 }] });
    expect(s.bills_due.urgent).toBe(true);
    expect(s.bills_due.urgentReason).toMatch(/costs you the customer/);
  });
});

describe("GST — the one number that can legitimately be negative", () => {
  it("is payable and urgent when output tax exceeds input credit", () => {
    const s = gstFolderState(8_100);
    expect(s.count).toBe(1);
    expect(s.amount).toBe(8_100);
    expect(s.urgent).toBe(true);
    expect(s.urgentReason).toMatch(/20th/);
  });

  it("reports a CREDIT as a credit, not as a debt of the same size", () => {
    /* Input credit exceeding output tax is a normal month for a reseller who bought
       wholesale licences and has not billed them all on yet. Showing "₹8,000 payable"
       would invert the fact; showing "-₹8,000 payable" would just confuse. */
    const s = gstFolderState(-8_000);
    expect(s.amount).toBe(8_000);
    expect(s.urgent).toBe(false);
    expect(s.urgentReason).toMatch(/carries forward/);
    expect(s.count).toBe(0);
  });

  it("says nothing at all when the year nets to exactly zero", () => {
    const s = gstFolderState(0);
    expect(s.urgent).toBe(false);
    expect(s.urgentReason).toBeNull();
  });
});

describe("urgentFolders", () => {
  it("returns them in the module's own cash-first order", () => {
    expect(urgentFolders(moneyInboxState(live)).map((f) => f.id))
      .toEqual(["receivables", "unmatched_credits", "gst"]);
  });

  it("is empty on a clean set of books", () => {
    expect(urgentFolders(moneyInboxState(empty))).toEqual([]);
    expect(totalOpenItems(moneyInboxState(empty))).toBe(0);
  });
});
