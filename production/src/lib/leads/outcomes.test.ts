import { describe, it, expect } from "vitest";
import { applyOutcome, tomorrowISO, localDateISO, OUTCOME_CHIPS } from "./outcomes";
import type { Lead } from "@/lib/supabase/database.types";

const lead = (over: Partial<Lead> = {}) =>
  ({ company: "Bright Systems", contact_phone: "+91 98111 22233", follow_up_date: null, ...over }) as Lead;

describe("localDateISO / tomorrowISO — the IST off-by-one-day trap", () => {
  it("formats from LOCAL parts, so an early-morning tap books the right day", () => {
    /* The bug this avoids: at 02:00 IST, new Date().toISOString().slice(0,10) is
       YESTERDAY, because IST is UTC+5:30. A rep tapping "Call tomorrow" at 7am would
       book the call for today. */
    const earlyMorning = new Date(2026, 7, 14, 2, 0, 0);       // 14 Aug 2026, 02:00 local
    expect(localDateISO(earlyMorning)).toBe("2026-08-14");
    expect(tomorrowISO(earlyMorning)).toBe("2026-08-15");
  });

  it("rolls over a month end", () => {
    expect(tomorrowISO(new Date(2026, 7, 31, 23, 30))).toBe("2026-09-01");
  });

  it("rolls over a year end", () => {
    expect(tomorrowISO(new Date(2026, 11, 31, 9, 0))).toBe("2027-01-01");
  });

  it("handles a leap day", () => {
    expect(tomorrowISO(new Date(2028, 1, 28, 9, 0))).toBe("2028-02-29");
    expect(tomorrowISO(new Date(2028, 1, 29, 9, 0))).toBe("2028-03-01");
  });

  it("zero-pads single-digit months and days", () => {
    expect(localDateISO(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

const NOW = new Date(2026, 7, 14, 11, 0);      // 14 Aug 2026, 11:00 local
const TOMORROW = "2026-08-15";

describe("applyOutcome — no chip ever moves the stage", () => {
  it("is true for every chip, by construction", () => {
    /* The rule the whole module exists for. `stage = "quote"` is load-bearing in
       heat.ts (advanced stage), heat-score.ts (funnel progress 1.00) and the Deals
       pipeline — a chip that set it would let a rep manufacture a screen of hot
       quote-stage leads with no quotes behind them. */
    for (const chip of OUTCOME_CHIPS) {
      const eff = applyOutcome(chip.id, lead(), NOW);
      expect(eff.stageChange).toBeNull();
      expect(eff.patch ?? {}).not.toHaveProperty("stage");
    }
  });
});

describe("applyOutcome — No answer", () => {
  const eff = applyOutcome("no_answer", lead(), NOW);

  it("brings the lead back tomorrow", () => {
    expect(eff.patch).toEqual({ follow_up_date: TOMORROW });
  });

  it("logs it as an ATTEMPT, not as contact", () => {
    // "We contacted 40 leads this week" must not count phones that rang out.
    expect(eff.activity?.kind).toBe("call");
    expect(eff.activity?.detail).toMatch(/No answer/);
    expect(eff.activity?.detail).not.toMatch(/contacted/i);
  });

  it("records the number dialled, so the log survives a later edit", () => {
    expect(eff.activity?.detail).toContain("+91 98111 22233");
  });

  it("still works with no phone on record", () => {
    const e = applyOutcome("no_answer", lead({ contact_phone: null }), NOW);
    expect(e.activity?.detail).toBe("No answer — retrying tomorrow");
    expect(e.patch).toEqual({ follow_up_date: TOMORROW });
  });

  it("names the company in the confirmation", () => {
    expect(eff.toast).toContain("Bright Systems");
    expect(eff.undoable).toBe(true);
  });
});

describe("applyOutcome — Call tomorrow", () => {
  it("sets tomorrow", () => {
    expect(applyOutcome("call_tomorrow", lead(), NOW).patch).toEqual({ follow_up_date: TOMORROW });
  });

  it("overrides a follow-up already set FURTHER OUT", () => {
    /* The rep just said "tomorrow". Keeping next Friday because it is further away
       would silently override the person holding the phone. */
    const e = applyOutcome("call_tomorrow", lead({ follow_up_date: "2026-09-30" }), NOW);
    expect(e.patch).toEqual({ follow_up_date: TOMORROW });
  });

  it("overrides an overdue follow-up too", () => {
    const e = applyOutcome("call_tomorrow", lead({ follow_up_date: "2026-01-01" }), NOW);
    expect(e.patch).toEqual({ follow_up_date: TOMORROW });
  });
});

describe("applyOutcome — Send quote", () => {
  const eff = applyOutcome("send_quote", lead(), NOW);

  it("navigates and writes NOTHING", () => {
    expect(eff.navigate).toBe("quote");
    expect(eff.patch).toBeNull();
  });

  it("does not set stage to 'quote' — the quote does not exist yet", () => {
    // The single most important assertion in this file.
    expect(eff.stageChange).toBeNull();
    expect(JSON.stringify(eff)).not.toMatch(/"stage"\s*:\s*"quote"/);
  });

  it("logs no activity — opening a builder is not an event worth a row", () => {
    expect(eff.activity).toBeNull();
    expect(eff.toast).toBe("");
  });
});

describe("applyOutcome — Mark junk", () => {
  const eff = applyOutcome("mark_junk", lead(), NOW);

  it("sets is_junk and nothing else", () => {
    expect(eff.patch).toEqual({ is_junk: true });
  });

  it("is undoable, because a mis-tap on a real lead must be recoverable", () => {
    expect(eff.undoable).toBe(true);
  });

  it("leaves the follow-up date alone — the lead is hidden, not rescheduled", () => {
    expect(eff.patch).not.toHaveProperty("follow_up_date");
  });
});

describe("OUTCOME_CHIPS — the shared vocabulary", () => {
  it("has exactly the four chips the brief asked for", () => {
    expect(OUTCOME_CHIPS.map((c) => c.id))
      .toEqual(["no_answer", "call_tomorrow", "send_quote", "mark_junk"]);
  });

  it("every chip explains itself — no mystery buttons (§24)", () => {
    for (const c of OUTCOME_CHIPS) {
      expect(c.hint.length).toBeGreaterThan(20);
      expect(c.label.length).toBeGreaterThan(0);
    }
  });

  it("the two chips whose stage behaviour surprises people SAY so in the hint", () => {
    const byId = Object.fromEntries(OUTCOME_CHIPS.map((c) => [c.id, c]));
    expect(byId.no_answer.hint).toMatch(/not changed|not contact/i);
    expect(byId.send_quote.hint).toMatch(/stage moves when/i);
  });

  it("marks which chip needs a phone number", () => {
    const byId = Object.fromEntries(OUTCOME_CHIPS.map((c) => [c.id, c]));
    expect(byId.no_answer.needsPhone).toBe(true);
    expect(byId.mark_junk.needsPhone).toBe(false);
  });
});
