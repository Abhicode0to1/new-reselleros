import { describe, it, expect } from "vitest";
import {
  LOSS_ANALYSIS_NEEDS,
  MIN_PRICE_LOSSES_FOR_EMPHASIS,
  SLOW_REPLY_HOURS,
  diagnoseLoss,
  suggestEmphasis,
  type LossDiagnosis,
  type LossInput,
} from "./loss-analysis";
import { AUTHORISED_CLAIMS } from "./tone";

const loss = (over: Partial<LossInput> = {}): LossInput => ({
  customerMessages: ["Thanks for the quotation, we will review it."],
  hoursToOurReply: 2,
  draftWasHeld: false,
  statedReason: null,
  ...over,
});

const diag = (over: Partial<LossDiagnosis> = {}): LossDiagnosis => ({
  cause: "price",
  fix: "pitch",
  reason: "x",
  ...over,
});

/* ══ THE BRIEF PRESCRIBES ONE FIX FOR TWO OPPOSITE DIAGNOSES ═════════════════ */

describe("price and delay have opposite fixes", () => {
  it("routes a PRICE loss to a pitch change", () => {
    /* The one diagnosis a pitch change answers: the input tax credit is real money coming back
       on our own invoice, and a buyer who has not counted it is comparing the wrong number. */
    const d = diagnoseLoss(loss({ customerMessages: ["too expensive for our budget"] }));
    expect(d.cause).toBe("price");
    expect(d.fix).toBe("pitch");
    expect(d.reason).toContain("money that");
    expect(d.reason).toContain("comes back");
  });

  it("routes a SILENCE loss to an OPERATIONAL fix, and refuses a pitch change", () => {
    /* ─── THE NON-SEQUITUR IN THE BRIEF ───────────────────────────────────────
       It asks "kya price zyada laga? kya response delay hua?" and then prescribes one answer to
       both: emphasise the GST ITC more. Lost on delay, that does nothing whatsoever — nobody
       declined because the pitch was under-argued, they declined because nothing arrived.

       And it does something worse than nothing: it makes the numbers look like the pitch was the
       problem, so the next person to read them rewrites a prompt instead of turning on a
       setting. */
    const d = diagnoseLoss(loss({ hoursToOurReply: null, draftWasHeld: true }));
    expect(d.cause).toBe("silence");
    expect(d.fix).toBe("operational");
    expect(d.reason).toContain("not lost on the pitch");
    expect(d.reason).toContain("open the dial");
    expect(d.reason).toContain("look like the argument was the problem");
  });

  it("routes a DELAY loss to an operational fix too", () => {
    const d = diagnoseLoss(loss({ hoursToOurReply: 72 }));
    expect(d.cause).toBe("delay");
    expect(d.fix).toBe("operational");
    expect(d.reason).toContain("does not arrive any");
    expect(d.reason).toContain("sooner");
  });

  it("checks SILENCE before PRICE, and the order is the point", () => {
    /* A customer who said "too expensive" AND never got an answer did not decline the argument —
       they declined the silence. Diagnosing that as a price objection would send somebody to
       rewrite a pitch that was never delivered, and the price complaint would look like the
       cause because it is the only thing in the transcript. */
    const d = diagnoseLoss(
      loss({ customerMessages: ["way too expensive", "Zoho is cheaper"], hoursToOurReply: null, draftWasHeld: true }),
    );
    expect(d.cause).toBe("silence");
    expect(d.fix).toBe("operational");
  });

  it("uses a generous line for slow, so timing is not over-blamed", () => {
    /* Calling a two-hour reply slow would attribute losses to timing that were about something
       else, and a diagnosis that over-reports one cause is worse than one that says unknown. */
    expect(SLOW_REPLY_HOURS).toBeGreaterThanOrEqual(12);
    expect(diagnoseLoss(loss({ hoursToOurReply: SLOW_REPLY_HOURS })).cause).not.toBe("delay");
    expect(diagnoseLoss(loss({ hoursToOurReply: SLOW_REPLY_HOURS + 1 })).cause).toBe("delay");
  });
});

/* ══ A colleague's reason outranks a transcript ══════════════════════════════ */

describe("diagnoseLoss", () => {
  it.each([
    ["price was too high", "price"],
    ["Budget nahi tha", "price"],
    ["mehnga laga unko", "price"],
    ["went with an incumbent reseller they already knew", "other_stated"],
    ["company shut down", "other_stated"],
  ])("takes a colleague's typed reason %s as %s", (statedReason, cause) => {
    /* They spoke to the customer; the app is reading text. */
    const d = diagnoseLoss(loss({ statedReason, customerMessages: ["Zoho is cheaper"] }));
    expect(d.cause).toBe(cause);
  });

  it("suggests nothing for a stated reason that is neither price nor timing", () => {
    const d = diagnoseLoss(loss({ statedReason: "they were acquired" }));
    expect(d.fix).toBe("none");
    expect(d.reason).toContain("inventing one from a single loss is how a habit forms");
  });

  it("says 'went quiet' rather than guessing, when nobody said why", () => {
    const d = diagnoseLoss(loss({ customerMessages: ["Please send the quotation."] }));
    expect(d.cause).toBe("went_quiet");
    expect(d.fix).toBe("none");
    expect(d.reason).toContain("ask the next one why, and record it");
  });

  it("says 'unknown' when there is nothing at all on record", () => {
    const d = diagnoseLoss(loss({ customerMessages: [] }));
    expect(d.cause).toBe("unknown");
    expect(d.fix).toBe("none");
  });

  it("distinguishes a held draft from nobody replying", () => {
    /* Different fixes: one is a dial, the other is a rota. */
    const held = diagnoseLoss(loss({ hoursToOurReply: null, draftWasHeld: true }));
    const nobody = diagnoseLoss(loss({ hoursToOurReply: null, draftWasHeld: false }));
    expect(held.reason).toContain("drafted and never sent");
    expect(nobody.reason).toContain("Nobody replied to this customer at all");
    expect(nobody.reason).toContain("a rota or a dial");
  });

  it("never returns a fix kind other than the three", () => {
    const inputs = [
      loss(),
      loss({ hoursToOurReply: null }),
      loss({ hoursToOurReply: 100 }),
      loss({ statedReason: "price" }),
      loss({ statedReason: "other" }),
      loss({ customerMessages: [] }),
      loss({ customerMessages: ["too expensive"] }),
    ];
    for (const i of inputs) {
      expect(["pitch", "operational", "none"]).toContain(diagnoseLoss(i).fix);
    }
  });

  it("only ever returns `pitch` for a price loss", () => {
    /* The routing IS the feature. If any other cause could produce a pitch change, the brief's
       collapse would be back. */
    const inputs = [
      loss({ hoursToOurReply: null }),
      loss({ hoursToOurReply: 100 }),
      loss({ statedReason: "they were acquired" }),
      loss({ customerMessages: [] }),
      loss({ customerMessages: ["Please send the quotation."] }),
    ];
    for (const i of inputs) {
      const d = diagnoseLoss(i);
      if (d.fix === "pitch") expect(d.cause).toBe("price");
    }
  });
});

/* ══ A silence problem cannot hide inside a pitch recommendation ═════════════ */

describe("suggestEmphasis", () => {
  const many = (n: number, over: Partial<LossDiagnosis> = {}) => Array.from({ length: n }, () => diag(over));

  it("refuses a pitch change when more deals were lost to silence than to price", () => {
    /* ─── THE FINDING THIS PROTECTS AGAINST, AND IT IS TODAY'S ACTUAL STATE ───
       Measured: 31 quotes, 27 accepted, ZERO lost, `lost_at` null on every lead, and 12 held
       drafts with 0 agent turns ever. So if anything is costing deals right now it is silence —
       and a loop that answered by emphasising the tax credit harder would be treating a delivery
       failure with rhetoric. */
    const s = suggestEmphasis([
      ...many(20, { cause: "price", fix: "pitch" }),
      ...many(30, { cause: "silence", fix: "operational" }),
    ]);
    expect(s.leadWith).toBeNull();
    expect(s.safeToApplyAutomatically).toBe(false);
    expect(s.unavailable).toContain("More deals were lost to silence or delay");
    expect(s.unavailable).toContain("a better argument does not");
    expect(s.unavailable).toContain("arrive any sooner");
  });

  it("reports the operational count even when it suggests a pitch change", () => {
    /* So a silence problem is visible next to the recommendation rather than buried under it. */
    const s = suggestEmphasis([
      ...many(20, { cause: "price", fix: "pitch" }),
      ...many(3, { cause: "delay", fix: "operational" }),
    ]);
    expect(s.leadWith).toBe("gst_invoice");
    expect(s.operationalLosses).toBe(3);
    expect(s.priceLosses).toBe(20);
  });

  it("refuses below the sample floor, and names it", () => {
    const s = suggestEmphasis(many(4, { cause: "price", fix: "pitch" }));
    expect(s.leadWith).toBeNull();
    expect(s.unavailable).toContain("Only 4 deals were lost on price");
    expect(s.unavailable).toContain(String(MIN_PRICE_LOSSES_FOR_EMPHASIS));
    expect(s.unavailable).toContain("a handful of customers deciding what everybody hears first");
  });

  it("suggests a claim IDENTIFIER from the authorised list, never a phrase", () => {
    const s = suggestEmphasis(many(MIN_PRICE_LOSSES_FOR_EMPHASIS, { cause: "price", fix: "pitch" }));
    expect(AUTHORISED_CLAIMS).toContain(s.leadWith!);
  });

  it("says automation WOULD be safe once the sample is there — not never", () => {
    /* ─── THE DISTINCTION FROM THE OTHER THREE LOOPS, STATED DELIBERATELY ─────
       playbook.ts, reflection.ts and gold-standard.ts refuse automation on principle: they would
       put wording, or a customer's text, or somebody else's authority into the agent's mouth.
       Reordering AUTHORISED claims cannot introduce a claim, so its worst case is leading with
       the wrong TRUE thing — a suboptimal email. What blocks it today is the sample, and saying
       "never" on grounds that would not survive scale would be the wrong answer. */
    const enough = suggestEmphasis(many(MIN_PRICE_LOSSES_FOR_EMPHASIS + 5, { cause: "price", fix: "pitch" }));
    expect(enough.safeToApplyAutomatically).toBe(true);

    const notEnough = suggestEmphasis(many(2, { cause: "price", fix: "pitch" }));
    expect(notEnough.safeToApplyAutomatically).toBe(false);
  });

  it("uses a LOWER floor than the other loops, because the consequence is smaller", () => {
    /* 15 rather than 25. The bar should sit where the consequence does: a wrong reordering costs
       a suboptimal email, not a false statement. */
    expect(MIN_PRICE_LOSSES_FOR_EMPHASIS).toBeLessThan(25);
    expect(MIN_PRICE_LOSSES_FOR_EMPHASIS).toBeGreaterThan(5);
  });

  it("survives an empty loss list", () => {
    const s = suggestEmphasis([]);
    expect(s.leadWith).toBeNull();
    expect(s.priceLosses).toBe(0);
    expect(s.safeToApplyAutomatically).toBe(false);
    expect(s.unavailable.length).toBeGreaterThan(20);
  });
});

/* ══ What is actually missing ════════════════════════════════════════════════ */

describe("LOSS_ANALYSIS_NEEDS", () => {
  const all = LOSS_ANALYSIS_NEEDS.join(" | ");

  it("names lost_reason as never written", () => {
    /* Not a prohibition list like the other loops carry — this feature is blocked by ABSENT
       DATA rather than by anything unsafe, and that is a different sentence to write. */
    expect(all).toContain("`leads.lost_reason` has never been written");
    expect(all).toContain("most losses diagnose as 'went");
  });

  it("names the zero lost deals", () => {
    expect(all).toContain("31 quotes exist, 27 accepted and none lost");
  });

  it("says the only measurable latency is infinite, and that this IS the finding", () => {
    expect(all).toContain("twelve drafts");
    expect(all).toContain("which is the finding, not");
  });
});
