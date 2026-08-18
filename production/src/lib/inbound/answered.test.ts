import { describe, it, expect } from "vitest";
import {
  answeredState, answeredNote, quoteButtonLabel, blocksSending, type QuoteRef,
} from "./answered";
import { rupee } from "@/lib/utils";

/** The live enquiry: Pardeep's "mujhe 20 email google workspace standard chahiye". */
const EMAIL_AT = "2026-08-18T02:58:57Z";

const q = (over: Partial<QuoteRef> = {}): QuoteRef => ({
  id: "Q-ADPL-2026-27-0003", createdAt: "2026-08-18T04:10:00Z", amount: 45_878, ...over,
});

/**
 * ─── THE FAILURE ────────────────────────────────────────────────────────────
 * Pardeep sent a quote from an enquiry, came back later, and the screen was identical —
 * nothing said the work was done. "Mujhe yaad nahi raha to me dobara quote bhej dunga."
 * The cost lands on the customer: two quotes for one request, and a conversation that
 * starts with "which one is correct?".
 */
describe("an enquiry that has already been answered", () => {
  it("is recognised from a quote raised after the email", () => {
    const s = answeredState(EMAIL_AT, [q()]);
    expect(s.kind).toBe("answered");
  });

  it("names the quote and the amount, not just 'already quoted'", () => {
    /* The operator's next question is always "which one, and for how much" — making them
       go and look is how they raise a second one anyway. */
    const note = answeredNote(answeredState(EMAIL_AT, [q()]), rupee)!;
    expect(note).toContain("Q-ADPL-2026-27-0003");
    expect(note).toContain("₹45,878");
  });

  it("picks the NEWEST answer when several were sent", () => {
    const s = answeredState(EMAIL_AT, [
      q({ id: "Q-OLD", createdAt: "2026-08-18T03:00:00Z" }),
      q({ id: "Q-NEW", createdAt: "2026-08-18T09:00:00Z" }),
    ]);
    expect(s.kind === "answered" && s.quote.id).toBe("Q-NEW");
  });

  it("counts a quote raised in the SAME second as the email", () => {
    /* What a fast operator working straight from the inbox produces. `>` instead of `>=`
       would report their own work as not done. */
    expect(answeredState(EMAIL_AT, [q({ createdAt: EMAIL_AT })]).kind).toBe("answered");
  });

  it("mentions older quotes alongside the answer, without confusing the two", () => {
    const s = answeredState(EMAIL_AT, [
      q({ id: "Q-NEW" }),
      q({ id: "Q-LASTMONTH", createdAt: "2026-07-01T10:00:00Z" }),
    ]);
    expect(s.kind === "answered" && s.alsoEarlier).toBe(1);
    expect(answeredNote(s, rupee)).toMatch(/1 older quote/);
  });
});

/**
 * ─── THE DISTINCTION THAT MAKES IT USEFUL RATHER THAN NOISY ─────────────────
 * A customer quoted last month who has now emailed "send me a quote" has NOT been
 * answered. Treating the old quote as the reply would suppress the warning on the one
 * enquiry that actually needs work.
 */
describe("a quote from BEFORE the email is not a reply to it", () => {
  const s = answeredState(EMAIL_AT, [q({ id: "Q-LASTMONTH", createdAt: "2026-07-01T10:00:00Z" })]);

  it("is reported as history, never as answered", () => {
    expect(s.kind).toBe("earlier-only");
  });

  it("says the customer is asking AGAIN", () => {
    const note = answeredNote(s, rupee)!;
    expect(note).toMatch(/asking again/);
    expect(note).not.toMatch(/already answered/i);
  });

  it("still names the earlier quote, because it is the context for the new one", () => {
    expect(answeredNote(s, rupee)).toContain("Q-LASTMONTH");
  });

  it("leaves the button reading 'Send quote' — there is work to do", () => {
    expect(quoteButtonLabel(s)).toBe("Send quote");
  });
});

describe("an enquiry nobody has quoted", () => {
  it("says nothing at all", () => {
    const s = answeredState(EMAIL_AT, []);
    expect(s.kind).toBe("none");
    expect(answeredNote(s, rupee)).toBeNull();
  });

  it("keeps the plain button label", () => {
    expect(quoteButtonLabel(answeredState(EMAIL_AT, []))).toBe("Send quote");
  });
});

/**
 * ─── IT TELLS, IT DOES NOT FORBID ───────────────────────────────────────────
 * Revising a quote is normal and frequent: the seat count changed, the price was
 * renegotiated, the first one expired. Blocking would make the app wrong on a legitimate
 * path in order to prevent a mistake a clearly-worded warning already prevents.
 */
describe("sending is never blocked", () => {
  it("stays allowed even when the enquiry is answered", () => {
    expect(blocksSending(answeredState(EMAIL_AT, [q()]))).toBe(false);
  });

  it("changes the WORDS instead, so the second send is a choice", () => {
    expect(quoteButtonLabel(answeredState(EMAIL_AT, [q()]))).toBe("Send another quote");
  });

  it("is allowed in every state", () => {
    for (const quotes of [[], [q()], [q({ createdAt: "2026-01-01T00:00:00Z" })]]) {
      expect(blocksSending(answeredState(EMAIL_AT, quotes))).toBe(false);
    }
  });
});

describe("it does not decide from quotes it was not given", () => {
  it("takes the caller's list as already scoped to this lead", () => {
    /* A quote to the wrong customer must never be able to mark an enquiry answered, so
       this function filters by party not at all — the caller does, from lead_id. */
    expect(answeredState.length).toBe(2);
  });
});
