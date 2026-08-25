import { describe, it, expect } from "vitest";
import {
  CADENCE,
  WHATSAPP_WINDOW_HOURS,
  decideStep,
  expiryFact,
  insideWhatsAppWindow,
  nextStep,
  nextStepAt,
  resolveChannel,
  stepAt,
} from "./cadence";

const QUOTED = new Date("2026-08-25T09:00:00Z");
const hoursAfter = (h: number) => new Date(QUOTED.getTime() + h * 3_600_000);

describe("the sequence", () => {
  it("is four touches over a week", () => {
    expect(CADENCE.map((s) => s.dayOffset)).toEqual([0, 2, 4, 7]);
    expect(CADENCE.map((s) => s.step)).toEqual([1, 2, 3, 4]);
  });

  it("has no gap in its step numbers", () => {
    /* A gap means `nextStep` returns null mid-cadence and the sequence stops without saying so. */
    for (let i = 1; i < CADENCE.length; i++) {
      expect(CADENCE[i].step).toBe(CADENCE[i - 1].step + 1);
    }
  });

  it("ends after step 4", () => {
    expect(nextStep(4)).toBeNull();
    expect(stepAt(5)).toBeNull();
  });

  it("measures every step from the QUOTE, not from the previous send", () => {
    /* Chaining "+2 days from the last one" lets a missed Saturday run push the whole tail
       later and later. Anchoring to the quote keeps day 7 on day 7. */
    expect(nextStepAt(QUOTED, 1)?.toISOString()).toBe("2026-08-27T09:00:00.000Z");
    expect(nextStepAt(QUOTED, 2)?.toISOString()).toBe("2026-08-29T09:00:00.000Z");
    expect(nextStepAt(QUOTED, 3)?.toISOString()).toBe("2026-09-01T09:00:00.000Z");
    expect(nextStepAt(QUOTED, 4)).toBeNull();
  });
});

describe("the WhatsApp 24-hour window", () => {
  it("is inside while the customer wrote recently", () => {
    expect(insideWhatsAppWindow(QUOTED, hoursAfter(1))).toBe(true);
    expect(insideWhatsAppWindow(QUOTED, hoursAfter(WHATSAPP_WINDOW_HOURS - 0.1))).toBe(true);
  });

  it("is outside at exactly the boundary and beyond", () => {
    expect(insideWhatsAppWindow(QUOTED, hoursAfter(WHATSAPP_WINDOW_HOURS))).toBe(false);
    expect(insideWhatsAppWindow(QUOTED, hoursAfter(48))).toBe(false);
  });

  it("is outside when they have never written", () => {
    expect(insideWhatsAppWindow(null, QUOTED)).toBe(false);
  });
});

describe("resolveChannel — the day-2 step as specified would have bounced", () => {
  const base = { lastCustomerMessageAt: QUOTED, templateApproved: false, hasEmail: true, hasPhone: true };

  it("falls back to email when WhatsApp is outside the window", () => {
    /* THE OPERATIONAL FACT THAT CHANGED THE DESIGN. A free-form WhatsApp message more than 24
       hours after the customer's last one is refused by Meta (131047) unless it is a
       pre-approved template. The day-2 check-in is ~48 hours after the enquiry by
       construction, so as written it would simply bounce and the customer would get nothing. */
    const d = resolveChannel({ ...base, wanted: "whatsapp", now: hoursAfter(48) });
    expect(d?.channel).toBe("email");
    expect(d?.note).toContain("outside Meta's 24-hour");
  });

  it("uses WhatsApp when the customer wrote in the last day", () => {
    const d = resolveChannel({ ...base, wanted: "whatsapp", now: hoursAfter(3) });
    expect(d?.channel).toBe("whatsapp");
    expect(d?.note).toBeNull();
  });

  it("uses WhatsApp outside the window once a template is approved", () => {
    /* The path back. Approving a template flips this without touching the cadence. */
    const d = resolveChannel({ ...base, wanted: "whatsapp", now: hoursAfter(72), templateApproved: true });
    expect(d?.channel).toBe("whatsapp");
  });

  it("records the fallback rather than swapping channel silently", () => {
    /* `sent_channel` and this note are what stop somebody wondering why no WhatsApp arrived. */
    const d = resolveChannel({ ...base, wanted: "whatsapp", now: hoursAfter(48) });
    expect(d?.note).toBeTruthy();
  });

  it("uses WhatsApp for an email step when there is no email address", () => {
    const d = resolveChannel({ ...base, wanted: "email", hasEmail: false, now: hoursAfter(2) });
    expect(d?.channel).toBe("whatsapp");
    expect(d?.note).toContain("no email address");
  });

  it("gives up when the lead is unreachable either way", () => {
    expect(resolveChannel({ ...base, wanted: "email", hasEmail: false, hasPhone: false, now: hoursAfter(2) })).toBeNull();
    expect(resolveChannel({ ...base, wanted: "whatsapp", hasEmail: false, hasPhone: false, now: hoursAfter(2) })).toBeNull();
  });
});

describe("decideStep — the value drop nobody has written", () => {
  const base = {
    lastCustomerMessageAt: QUOTED,
    now: hoursAfter(96),
    templateApproved: false,
    hasEmail: true,
    hasPhone: true,
  };

  it("SKIPS the value step when no write-up is saved, and advances anyway", () => {
    /* THE TEST THIS MODULE EXISTS FOR. The brief's day-4 step was "Case Study: humne 50-user
       migration 0 downtime mein complete kiya" — a factual claim about work this company did,
       with no case study anywhere in the app to draw it from. An agent writing it would be
       inventing a customer reference. So the step needs the reseller's own words, and costs
       the lead one touch rather than the rest of its cadence when there are none. */
    const out = decideStep({ ...base, step: 3, valueDropContent: null });
    expect(out.fire).toBe(false);
    if (!out.fire) {
      expect(out.skip, "an empty slot must not end the cadence").toBe(true);
      expect(out.reason).toContain("skipped rather than written by the AI");
    }
  });

  it.each([null, undefined, "", "   "])("treats %s as no content", (content) => {
    const out = decideStep({ ...base, step: 3, valueDropContent: content });
    expect(out.fire).toBe(false);
  });

  it("fires the value step once somebody has written one", () => {
    const out = decideStep({ ...base, step: 3, valueDropContent: "We moved 40 mailboxes over a weekend." });
    expect(out.fire).toBe(true);
    if (out.fire) expect(out.channel).toBe("email");
  });

  it("STOPS rather than advancing when the lead cannot be reached", () => {
    /* Skipping forever would leave a row cycling through a cadence towards nobody. */
    const out = decideStep({ ...base, step: 2, valueDropContent: null, hasEmail: false, hasPhone: false });
    expect(out.fire).toBe(false);
    if (!out.fire) expect(out.skip).toBe(false);
  });

  it("refuses a step number outside the cadence", () => {
    const out = decideStep({ ...base, step: 9, valueDropContent: "x" });
    expect(out.fire).toBe(false);
    if (!out.fire) expect(out.skip).toBe(false);
  });
});

describe("expiryFact — read the date, never assert it", () => {
  const now = new Date("2026-08-25T09:00:00Z");

  it("states the date and the days remaining", () => {
    const text = expiryFact("2026-09-01", now);
    expect(text).toContain("1 September 2026");
    expect(text).toContain("7 days");
  });

  it("says the RATE does not expire, only the quote", () => {
    /* The brief said "Special Rs 262/seat promotional price quote kal expire ho raha hai". A
       volume slab is a published rate card, not a promotion — a customer coming back on day 10
       with 30 seats still gets 3%. Implying otherwise is manufacturing a deadline. */
    expect(expiryFact("2026-09-01", now)).toContain("does not expire");
  });

  it("never says 'tomorrow'", () => {
    /* The window is seven days today. An asserted "tomorrow" becomes a lie the moment somebody
       changes that, and nobody would think to look for it. */
    for (const d of ["2026-08-26", "2026-09-01", "2026-08-25"]) {
      expect(expiryFact(d, now)?.toLowerCase()).not.toContain("tomorrow");
    }
  });

  it("handles today and the past without pretending", () => {
    expect(expiryFact("2026-08-25", now)).toContain("expires today");
    expect(expiryFact("2026-08-20", now)).toContain("expired on");
    expect(expiryFact("2026-08-20", now)).toContain("reissue");
  });

  it("says nothing at all when there is no date", () => {
    expect(expiryFact(null, now)).toBeNull();
    expect(expiryFact("not-a-date", now)).toBeNull();
  });

  it("never states a price", () => {
    /* Prices come from the quote. "Rs 262/seat" was the hardcoded per-month Starter figure
       again (L106), and it is not this function's to know.

       Asserted on a rupee MARKER rather than on "no 3-digit number", which was the first
       version of this test and failed on the year in "1 September 2026". A test that forbids
       digits in a sentence containing a date is testing the wrong thing. */
    const text = expiryFact("2026-09-01", now) ?? "";
    expect(text).not.toMatch(/(₹|\bRs\b|\bINR\b)/);
    expect(text.toLowerCase()).not.toContain("seat");
    expect(text.toLowerCase()).not.toContain("price");
  });
});

describe("what the steps tell the agent", () => {
  it("tells the day-2 step not to add urgency", () => {
    expect(stepAt(2)?.intent).toContain("do not add urgency");
  });

  it("tells the value step to add nothing to the write-up", () => {
    /* It describes work the company did and the model was not there. */
    expect(stepAt(3)?.intent).toContain("Add nothing to the write-up");
  });

  it("tells the expiry step the rate card does not expire", () => {
    const intent = stepAt(4)?.intent ?? "";
    expect(intent).toContain("does not expire");
    expect(intent).toContain("do not invent a discount deadline");
  });
});
