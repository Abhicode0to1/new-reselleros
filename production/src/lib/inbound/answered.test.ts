import { describe, it, expect } from "vitest";
import {
  answeredState, answeredNote, quoteButtonLabel, blocksSending, answeredTone, type QuoteRef,
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
    expect(s.kind === "answered" && s.alsoAfter).toBe(0);
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

/**
 * ─── THE LINK THIS WHOLE FEATURE DEPENDS ON ────────────────────────────────
 * answeredState() is given quotes scoped by lead_id. If the quote never CARRIES a lead_id,
 * this module is unreachable however well it is written — which is exactly what happened.
 *
 * The Enquiries "Send quote" link did not pass `leadId`, so quote-builder.tsx:824 saved
 * `lead_id: null`. The live books show the result: Q-ADPL-2026-27-0010 and -0011, both
 * ₹1,34,138, fifteen minutes apart, for one enquiry. The duplicate, already made.
 *
 * These assert the shape the caller must produce, so the join cannot be quietly dropped
 * again.
 */
describe("a quote with no lead link cannot answer anything", () => {
  it("reports 'none' when the quote list is empty because the join found nothing", () => {
    /* What the page saw for eight months: quotes existed, none carried lead_id, so the
       lead-scoped query returned zero rows and the enquiry looked untouched. */
    expect(answeredState(EMAIL_AT, []).kind).toBe("none");
  });

  it("answers correctly the moment the link exists", () => {
    const s = answeredState(EMAIL_AT, [
      q({ id: "Q-ADPL-2026-27-0010", createdAt: "2026-08-18T03:01:04Z", amount: 134_138 }),
    ]);
    expect(s.kind).toBe("answered");
    expect(answeredNote(s, rupee)).toContain("₹1,34,138");
  });

  it("names only ONE of two duplicates as the answer, and counts the other", () => {
    /* Both real quotes, fifteen minutes apart. The banner must not read as though two
       separate things were answered. */
    const s = answeredState(EMAIL_AT, [
      q({ id: "Q-ADPL-2026-27-0010", createdAt: "2026-08-18T03:01:04Z", amount: 134_138 }),
      q({ id: "Q-ADPL-2026-27-0011", createdAt: "2026-08-18T03:16:50Z", amount: 134_138 }),
    ]);
    expect(s.kind === "answered" && s.quote.id).toBe("Q-ADPL-2026-27-0011");
    /* Both are AFTER the email, so neither is "earlier" -- there is one OTHER answer. */
    expect(s.kind === "answered" && s.alsoAfter).toBe(1);
    expect(s.kind === "answered" && s.alsoEarlier).toBe(0);
    /* And the banner leads with the duplicate, because that is the mistake already made. */
    expect(answeredNote(s, rupee)).toMatch(/already sent 2 quotes/);
    expect(answeredNote(s, rupee)).toMatch(/which one the customer should keep/);
  });
});

describe("the colour has to agree with the sentence", () => {
  const q = (id: string, iso: string) => ({ id, createdAt: iso, amount: 134138 });
  const EMAIL = "2026-08-18T03:00:00.000Z";

  it("one quote is a green tick — the work is done", () => {
    expect(answeredTone(answeredState(EMAIL, [q("A", "2026-08-18T03:01:00.000Z")]))).toBe("ok");
  });

  it("TWO quotes is not reassurance, it is the mistake", () => {
    /* A green tick beside "check which one the customer should keep" is read as
       "all fine" by anyone scanning the page, which is everyone. */
    const s = answeredState(EMAIL, [
      q("A", "2026-08-18T03:01:00.000Z"),
      q("B", "2026-08-18T03:16:00.000Z"),
    ]);
    expect(s).toMatchObject({ kind: "answered", alsoAfter: 1 });
    expect(answeredTone(s)).toBe("problem");
  });

  it("quoted only BEFORE this email is a warning — they are asking again", () => {
    expect(answeredTone(answeredState(EMAIL, [q("A", "2026-07-01T10:00:00.000Z")]))).toBe("warn");
  });
});
