/**
 * What a suspended account tells its owner.
 *
 * ─── THE DEAD END THESE PIN ─────────────────────────────────────────────────
 * Before 11 Sep 2026 the portal's suspended card was a red "Suspended" pill and
 * nothing else. Found in the browser on the new portal test fixture: no reason,
 * no date, no next step, and nothing at all about whether the site and mailboxes
 * still existed — which is the first thing somebody wants to know and the only
 * thing that makes the difference between an annoyance and a panic.
 *
 * ─── AND THE HARDER RULE ────────────────────────────────────────────────────
 * There is no `suspension_reason` column, so most of these tests are about NOT
 * claiming a cause. The dangerous version of this feature is the one that picks
 * the likeliest-sounding reason: a refund suspends an account mid-term and
 * leaves every date looking healthy, so "your payment failed" would be shown to
 * somebody whose payment did not fail, sending them to their bank while the real
 * reason is never mentioned.
 */
import { describe, it, expect } from "vitest";
import { describeSuspension } from "./suspension-notice";

const NOW = new Date("2026-09-11T12:00:00Z");

describe("a trial that ran out", () => {
  const facts = {
    isTrial: true,
    trialEndsAt: "2026-09-04T00:00:00Z",
    expiresAt: "2026-09-04T00:00:00Z",
    suspendedAt: "2026-09-04T01:00:00Z",
    now: NOW,
  };

  it("says the trial ended, and names the date", () => {
    const n = describeSuspension(facts);
    expect(n.cause).toBe("trial_ended");
    expect(n.headline).toMatch(/free trial ended/i);
    expect(n.headline).toContain("4 Sept 2026");
    expect(n.headline).toMatch(/offline/i);
  });

  /* Buying IS the remedy here — there is no term to renew and no money on the
     account. This is the one case where the shop is the honest destination. */
  it("sends them to the shop", () => {
    expect(describeSuspension(facts).actionRoute).toBe("shop");
  });

  /* ─── ORDER MATTERS, AND GETTING IT WRONG INVENTS A CHARGE ───────────────
     A trial row usually carries BOTH dates. If `expires_at` were checked first
     this would tell a trial user that "the period you paid for" ended — a
     charge they do not recognise, on a plan they never bought. */
  it("is not described as a paid period ending, even though expires_at also passed", () => {
    const n = describeSuspension(facts);
    expect(n.headline).not.toMatch(/paid for/i);
    expect(n.cause).not.toBe("term_ended");
  });
});

describe("a paid term that ran out", () => {
  const facts = {
    isTrial: false,
    trialEndsAt: null,
    expiresAt: "2026-08-31T00:00:00Z",
    suspendedAt: "2026-08-31T02:00:00Z",
    now: NOW,
  };

  it("says the paid period ended, with the date", () => {
    const n = describeSuspension(facts);
    expect(n.cause).toBe("term_ended");
    expect(n.headline).toMatch(/period you paid for ended/i);
    expect(n.headline).toContain("31 Aug 2026");
  });

  /* Support, not shop. Renewing an account is not the same purchase as buying a
     new one, and the reseller may already have raised an invoice — a shop link
     here risks a SECOND hosting account for a domain they already host. */
  it("asks to renew rather than offering a fresh purchase", () => {
    const n = describeSuspension(facts);
    expect(n.actionRoute).toBe("support");
    expect(n.action).toMatch(/renew/i);
  });
});

describe("suspended for a reason we cannot see", () => {
  /* The case a refund leaves behind (`refund_payment`, migration
     20260911130000) and the case an operator leaves behind. Every date looks
     healthy, and that is precisely why nothing may be inferred from them. */
  const midTerm = {
    isTrial: false,
    trialEndsAt: null,
    expiresAt: "2027-03-01T00:00:00Z",
    suspendedAt: "2026-09-08T09:30:00Z",
    now: NOW,
  };

  it("says a person paused it, and when", () => {
    const n = describeSuspension(midTerm);
    expect(n.cause).toBe("unknown");
    expect(n.headline).toMatch(/paused/i);
    expect(n.headline).toContain("8 Sept 2026");
  });

  it("names no cause it cannot see", () => {
    const n = describeSuspension(midTerm);
    const text = `${n.headline} ${n.reassurance} ${n.action}`;
    /* Every plausible-sounding guess, refused. Each of these would send the
       customer somewhere useless and hide the real reason. */
    for (const invented of [/payment failed/i, /unpaid/i, /overdue/i, /expired/i, /trial/i, /card/i, /bank/i]) {
      expect(text).not.toMatch(invented);
    }
  });

  it("points at a person, because only a person knows", () => {
    const n = describeSuspension(midTerm);
    expect(n.actionRoute).toBe("support");
    expect(n.action).toMatch(/why/i);
  });

  it("still works with no dates at all", () => {
    const n = describeSuspension({
      isTrial: null, trialEndsAt: null, expiresAt: null, suspendedAt: null, now: NOW,
    });
    expect(n.cause).toBe("unknown");
    expect(n.headline).toMatch(/paused/i);
    /* No "on undefined", no dangling "on ". */
    expect(n.headline).not.toMatch(/undefined|null|on \./i);
    expect(n.action.length).toBeGreaterThan(0);
  });

  /* A trial or a term still in the FUTURE is not a cause. The account was
     suspended while it had time left, which is the unknown case. */
  it("does not blame a date that has not passed", () => {
    const n = describeSuspension({
      isTrial: true,
      trialEndsAt: "2026-10-01T00:00:00Z",
      expiresAt: "2026-10-01T00:00:00Z",
      suspendedAt: "2026-09-09T00:00:00Z",
      now: NOW,
    });
    expect(n.cause).toBe("unknown");
  });
});

describe("the sentence that must always be there", () => {
  const cases = [
    { label: "trial", facts: { isTrial: true, trialEndsAt: "2026-09-01T00:00:00Z", expiresAt: null, suspendedAt: null, now: NOW } },
    { label: "term",  facts: { isTrial: false, trialEndsAt: null, expiresAt: "2026-09-01T00:00:00Z", suspendedAt: null, now: NOW } },
    { label: "unknown", facts: { isTrial: false, trialEndsAt: null, expiresAt: null, suspendedAt: "2026-09-09T00:00:00Z", now: NOW } },
  ];

  /* The one thing the old card never said. It is true by construction:
     `refund_payment` may suspend but is forbidden from terminating, and a
     deleted account carries status `terminated`, not `suspended`. */
  it("tells them nothing has been deleted, in every case", () => {
    for (const c of cases) {
      const n = describeSuspension(c.facts);
      expect(n.reassurance, c.label).toMatch(/nothing has been deleted/i);
      expect(n.reassurance, c.label).toMatch(/switched back on/i);
    }
  });

  /* ─── AND IT MUST NOT PROMISE PERMANENCE ─────────────────────────────────
     Deletion is the admin's decision — Pardeep, 11 Sep: "Suspend the hosting
     but don't delete it. Admin will decide to delete it." So this says nothing
     HAS been deleted, never that nothing WILL be. A promise we have no standing
     to make is the kind a customer quotes back later. */
  it("does not promise the data is safe forever", () => {
    for (const c of cases) {
      const n = describeSuspension(c.facts);
      expect(n.reassurance, c.label).not.toMatch(/never be deleted|will not be deleted|always be|permanent/i);
    }
  });

  it("always gives exactly one action, with a route", () => {
    for (const c of cases) {
      const n = describeSuspension(c.facts);
      expect(n.action.trim().length, c.label).toBeGreaterThan(0);
      expect(["shop", "support"], c.label).toContain(n.actionRoute);
    }
  });
});

describe("the dates in these sentences", () => {
  /* ─── IST, NOT THE SERVER'S CLOCK ────────────────────────────────────────
     The first version formatted with `toLocaleDateString` in this module,
     which uses the RUNNING PROCESS's timezone. On Cloud Run that is UTC, so a
     late-evening IST timestamp would tell an Indian customer their trial ended
     a day before it did. `formatDate` pins Asia/Kolkata.

     19:00Z on the 4th is 00:30 IST on the 5th — the case that separates the
     two implementations. */
  it("uses Indian time, so a late-evening timestamp is not a day early", () => {
    /* ─── THE PROCESS IS FORCED TO UTC, AND THAT IS THE WHOLE TEST ──────────
       This assertion passed against a WRONG implementation until 11 Sep 2026,
       because this machine's own timezone is Asia/Calcutta: a formatter that
       silently used the system zone gave the same answer as one pinned to IST,
       so the mutation that swapped them survived.

       Cloud Run runs UTC. So the test sets TZ=UTC for the duration, which is
       the only configuration where the two implementations disagree — and
       therefore the only one that proves which is in use. Node re-reads
       `process.env.TZ` for subsequent Date operations, verified on this
       machine. */
    const savedTz = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const n = describeSuspension({
        isTrial: true,
        trialEndsAt: "2026-09-04T19:00:00Z",   // 00:30 IST on the 5th
        expiresAt: null,
        suspendedAt: null,
        now: NOW,
      });
      expect(n.headline).toContain("5 Sept 2026");
      expect(n.headline).not.toContain("4 Sept 2026");
    } finally {
      if (savedTz === undefined) delete process.env.TZ;
      else process.env.TZ = savedTz;
    }
  });

  /* Month NAMED, because 09/12 is two different days depending on where the
     reader learned to write dates, and this one goes to customers. */
  it("names the month rather than numbering it", () => {
    /* December 2025, not 2026: a date in the FUTURE is correctly the unknown
       case (asserted above), so a future December proved nothing about
       formatting. My fixture, not the function. */
    const n = describeSuspension({
      isTrial: false, trialEndsAt: null, expiresAt: "2025-12-09T06:00:00Z",
      suspendedAt: null, now: NOW,
    });
    expect(n.cause).toBe("term_ended");
    expect(n.headline).toMatch(/9 Dec 2025/);
    expect(n.headline).not.toMatch(/09\/12|12\/09/);
  });

  /* An unparseable date must drop the clause, not print the formatter's
     placeholder — "paused on —" is worse than saying nothing. */
  it("drops the clause instead of printing a dash", () => {
    const n = describeSuspension({
      isTrial: false, trialEndsAt: null, expiresAt: null,
      suspendedAt: "not-a-date", now: NOW,
    });
    expect(n.headline).not.toContain("—");
    expect(n.headline).toMatch(/paused, so the site is offline/i);
  });
});
