import { describe, it, expect } from "vitest";
import { shouldRequoteOnReply } from "./requote-on-reply";

const STARTER = "Google Workspace Business Starter";
const STANDARD = "Google Workspace Business Standard";

describe("the live case this was written for", () => {
  it("re-quotes when a reply raises the seat count", () => {
    /* The actual self-test, 23 Aug 2026: a mail asking for 50 Business Starter arrived on a
       lead already carrying 20 Business Standard. The extractor rewrote the lead and no quote
       was drafted, because the auto-quote block was on the CREATE branch only. */
    const d = shouldRequoteOnReply({
      seats: 50,
      productName: STARTER,
      latestQuote: { id: "Q-1", status: "sent", seats: 20, plan: STANDARD },
    });
    expect(d.requote).toBe(true);
    expect(d.reason).toMatch(/both changed/);
  });
});

describe("when a new quote is right", () => {
  it("quotes a lead that has none", () => {
    const d = shouldRequoteOnReply({ seats: 50, productName: STARTER, latestQuote: null });
    expect(d.requote).toBe(true);
    expect(d.reason).toMatch(/no quote yet/);
  });

  it("re-quotes on a seat change alone, and names both numbers", () => {
    const d = shouldRequoteOnReply({
      seats: 50, productName: STARTER,
      latestQuote: { id: "Q-7", status: "sent", seats: 20, plan: STARTER },
    });
    expect(d.requote).toBe(true);
    expect(d.reason).toContain("20 → 50");
  });

  it("re-quotes on a plan change alone", () => {
    const d = shouldRequoteOnReply({
      seats: 50, productName: STANDARD,
      latestQuote: { id: "Q-7", status: "sent", seats: 50, plan: STARTER },
    });
    expect(d.requote).toBe(true);
    expect(d.reason).toMatch(/plan changed/);
  });

  it("re-quotes even when the old quote was already SENT", () => {
    /* Deliberate. A customer sent 20 seats who now says 50 needs a revised document, not a
       note on a lead. The old quote is not altered — a new one is drafted, and the issued
       figures on the old are frozen by the invoice/quote guards. */
    const d = shouldRequoteOnReply({
      seats: 100, productName: STARTER,
      latestQuote: { id: "Q-9", status: "accepted", seats: 50, plan: STARTER },
    });
    expect(d.requote).toBe(true);
  });
});

describe("when it must NOT quote — this is where the document numbers are saved", () => {
  it("does not re-quote when nothing changed", () => {
    /* THE ONE THAT MATTERS. A thread about the same 50 seats can run five messages long;
       without this, every one of them is a new GST document for a requirement that has not
       moved, and each takes an irreversible number from the gapless Rule 46 series. */
    const d = shouldRequoteOnReply({
      seats: 50, productName: STARTER,
      latestQuote: { id: "Q-4", status: "sent", seats: 50, plan: STARTER },
    });
    expect(d.requote).toBe(false);
    expect(d.reason).toContain("Q-4");
    expect(d.reason).toMatch(/does not change what they asked for/);
  });

  it("treats a slug and a catalogue name as the same plan when containment holds", () => {
    /* The lead's `plan` has held both forms — a buy-page slug and the catalogue's own name —
       and this uses the SAME samePlan as apply-correction.ts rather than a second copy. */
    const d = shouldRequoteOnReply({
      seats: 50, productName: STARTER,
      latestQuote: { id: "Q-4", status: "draft", seats: 50, plan: "business-starter" },
    });
    expect(d.requote).toBe(false);
  });

  it("DOES re-quote once when the dropped word is in the middle of the name", () => {
    /* Asserting the real limitation rather than an invented capability. My first version of
       this test expected "google-workspace-starter" to match "Google Workspace Business
       Starter"; it does not, because samePlan is containment and "business" sits in the
       middle. The function was right and the test was wrong.

       Cost: ONE extra quote on a lead still carrying a buy-page slug. The correction
       write-back then normalises the row onto the catalogue name and it settles. Widening
       samePlan to token-subset matching would fix it and is a SEPARATE change — its own
       comment warns that "Business Starter" and "Business Standard" must never collapse, and
       that warning is load-bearing. */
    const d = shouldRequoteOnReply({
      seats: 50, productName: STARTER,
      latestQuote: { id: "Q-4", status: "draft", seats: 50, plan: "google-workspace-starter" },
    });
    expect(d.requote).toBe(true);
  });

  it.each([
    [null, STARTER],
    [50, null],
    [null, null],
  ])("does not quote with seats=%s product=%s", (seats, productName) => {
    /* Not a refusal so much as nothing to price. Said here rather than one layer down, so
       the reason lands on the lead's timeline. */
    const d = shouldRequoteOnReply({ seats, productName, latestQuote: null });
    expect(d.requote).toBe(false);
    expect(d.reason).toMatch(/nothing to price/);
  });

  it("does not treat an unknown old seat count as a match", () => {
    /* A quote with null seats tells us nothing about whether the requirement moved, and
       "unknown equals 50" would skip a needed revision. */
    const d = shouldRequoteOnReply({
      seats: 50, productName: STARTER,
      latestQuote: { id: "Q-5", status: "draft", seats: null, plan: STARTER },
    });
    expect(d.requote).toBe(true);
  });
});
