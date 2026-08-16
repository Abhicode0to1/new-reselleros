import { describe, it, expect } from "vitest";
import { decideDunning, dunningMessage, daysBetweenIST, DUNNING_STEPS, type DunningInput } from "./dunning";

/** Today, fixed. Due dates are expressed relative to it. */
const NOW = new Date("2026-08-16T12:00:00+05:30");
const dueDaysAgo = (n: number) => {
  const d = new Date(NOW.getTime() - n * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const inv = (over: Partial<DunningInput> = {}): DunningInput => ({
  dueDate: dueDaysAgo(1), status: "pending", amountDue: 24_000, ...over,
});

describe("the schedule the brief asked for", () => {
  it.each([
    [1,  "reminder"],
    [2,  "reminder"],
    [3,  "retry"],
    [6,  "retry"],
    [7,  "grace_warning"],
    [13, "grace_warning"],
    [14, "final"],
    [60, "final"],
  ])("%s days past due → %s", (days, step) => {
    expect(decideDunning(inv({ dueDate: dueDaysAgo(days) }), NOW).step).toBe(step);
  });

  it("is quiet before the due date and on the day itself", () => {
    expect(decideDunning(inv({ dueDate: dueDaysAgo(-5) }), NOW).step).toBe("none");
    expect(decideDunning(inv({ dueDate: dueDaysAgo(0) }), NOW).step).toBe("none");
  });

  it("keeps its steps in ascending order — decideDunning walks them backwards", () => {
    const days = DUNNING_STEPS.map((s) => s.daysOverdue);
    expect(days).toEqual([...days].sort((a, b) => a - b));
  });
});

describe("catch-up — a cron that missed a day must not skip a chase", () => {
  it("fires the most urgent step already reached, not only an exact-day match", () => {
    /* Cron was down on day 3. On day 5 the customer still gets the retry, not
       silence until day 7. */
    const d = decideDunning(inv({ dueDate: dueDaysAgo(5), lastStepSent: "reminder" }), NOW);
    expect(d.step).toBe("retry");
    expect(d.shouldSend).toBe(true);
  });

  it("does not re-send a step already sent", () => {
    expect(decideDunning(inv({ dueDate: dueDaysAgo(4), lastStepSent: "retry" }), NOW).shouldSend).toBe(false);
  });

  it("never walks BACKWARDS to a gentler step already passed", () => {
    const d = decideDunning(inv({ dueDate: dueDaysAgo(20), lastStepSent: "final" }), NOW);
    expect(d.step).toBe("final");
    expect(d.shouldSend).toBe(false);
  });
});

describe("what is never chased", () => {
  it.each(["paid", "void", "draft"] as const)("a %s invoice", (status) => {
    expect(decideDunning(inv({ status, dueDate: dueDaysAgo(30) }), NOW).step).toBe("none");
  });

  it("an invoice with nothing outstanding", () => {
    expect(decideDunning(inv({ amountDue: 0, dueDate: dueDaysAgo(30) }), NOW).step).toBe("none");
  });

  it("an invoice with NO DUE DATE — that is not 'overdue since forever'", () => {
    /* Inventing a deadline would start chasing customers on terms nobody told them. */
    const d = decideDunning(inv({ dueDate: null }), NOW);
    expect(d.step).toBe("none");
    expect(d.reason).toMatch(/no deadline to chase against/);
  });
});

describe("day 14 — suspension is NOT automatic by default", () => {
  const late = { dueDate: dueDaysAgo(14) };

  it("escalates to the reseller rather than suspending, by default", () => {
    /* Suspending means a customer's staff cannot read email. Firing that from an
       unpaid-invoice clock would cut off a live subscription because an unrelated
       one-off invoice went unpaid. */
    const d = decideDunning(inv({ ...late, subscriptionId: "sub-1" }), NOW);
    expect(d.step).toBe("final");
    expect(d.action).toBe("escalate");
    expect(d.reason).toMatch(/Automatic suspension is off/);
  });

  it("suspends only when the tenant opted in AND the invoice bills a subscription", () => {
    const d = decideDunning(inv({ ...late, subscriptionId: "sub-1", autoSuspend: true }), NOW);
    expect(d.action).toBe("suspend");
  });

  it("refuses to suspend an invoice with no subscription, even when opted in", () => {
    /* There is nothing to suspend — a hosting bill is not a mailbox. */
    const d = decideDunning(inv({ ...late, subscriptionId: null, autoSuspend: true }), NOW);
    expect(d.action).toBe("escalate");
    expect(d.reason).toMatch(/not linked to a subscription/);
  });

  it("says WHY in every case, so the reseller can act on the log alone", () => {
    for (const over of [
      { ...late, subscriptionId: "s" },
      { ...late, subscriptionId: null, autoSuspend: true },
      { ...late, subscriptionId: "s", autoSuspend: true },
    ]) {
      expect(decideDunning(inv(over), NOW).reason.length).toBeGreaterThan(20);
    }
  });
});

describe("daysBetweenIST", () => {
  it("counts calendar days at IST midnight, not 24-hour blocks", () => {
    /* The bug this prevents: 23:00 IST on the due date and 01:00 IST the next day are
       19 hours apart but ONE calendar day, and a customer must not be chased for an
       invoice that was due today. */
    const due  = new Date("2026-08-15T23:00:00+05:30");
    const next = new Date("2026-08-16T01:00:00+05:30");
    expect(daysBetweenIST(due, next)).toBe(1);
  });

  it("is negative before the date", () => {
    expect(daysBetweenIST(new Date("2026-08-20T12:00:00+05:30"), NOW)).toBe(-4);
  });
});

describe("dunningMessage", () => {
  const base = {
    invoiceId: "INV-ADPL-2026-27-0001", customerName: "Rakesh Kumar",
    amountDue: "₹24,000", dueDate: "10 Aug 2026", sellerName: "ANUTECH DIGITAL PVT LTD",
    payLink: "https://pay.example/x",
  };

  it("writes a message for every step that emails", () => {
    for (const step of ["reminder", "retry", "grace_warning", "final"] as const) {
      const m = dunningMessage({ ...base, step })!;
      expect(m.subject).toContain("INV-ADPL-2026-27-0001");
      expect(m.text).toContain("₹24,000");
      expect(m.text).toContain("https://pay.example/x");
    }
  });

  it("has none for 'none'", () => {
    expect(dunningMessage({ ...base, step: "none" })).toBeNull();
  });

  it("never threatens suspension in the customer-facing copy", () => {
    /* The Day-14 step escalates to the reseller by default, so a message promising
       suspension would be a threat the system does not carry out — which teaches
       customers that these emails are noise. */
    for (const step of ["reminder", "retry", "grace_warning", "final"] as const) {
      expect(dunningMessage({ ...base, step })!.text.toLowerCase()).not.toMatch(/suspend|cut off|terminate/);
    }
  });

  it("gets softer-to-firmer without becoming rude", () => {
    expect(dunningMessage({ ...base, step: "reminder" })!.text).toMatch(/please ignore this/i);
    expect(dunningMessage({ ...base, step: "grace_warning" })!.text).toMatch(/tell us what's holding it up/i);
  });

  it("omits the pay link cleanly when there is none", () => {
    const m = dunningMessage({ ...base, step: "reminder", payLink: null })!;
    expect(m.text).not.toContain("Pay here");
    expect(m.text).not.toContain("undefined");
  });
});
