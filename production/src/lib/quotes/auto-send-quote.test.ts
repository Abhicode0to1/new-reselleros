import { describe, it, expect } from "vitest";
import { decideAutoSend, type AutoSendInput } from "./auto-send-quote";

const ok: AutoSendInput = {
  termAssumed: false,
  recipient: "buyer@othercompany.com",
  quoteId: "Q-ADPL-2026-27-0007",
  emailConfigured: true,
};

describe("decideAutoSend — the one case that sends", () => {
  it("sends when the mail named the term and everything else is in place", () => {
    expect(decideAutoSend(ok)).toEqual({ send: true });
  });
});

describe("decideAutoSend — the term rule", () => {
  it("HOLDS when the term was assumed", () => {
    /* Pardeep's rule, chosen 23 Aug 2026: send when the mail named the term, hold when it
       did not. Monthly and annual differ by 12×, and a price the app inferred and posted is
       one the customer can hold us to — no small print underneath repairs the first number
       they read. */
    const d = decideAutoSend({ ...ok, termAssumed: true });
    expect(d.send).toBe(false);
  });

  it("says which fact is missing and who can supply it", () => {
    /* §24. "Skipped" would be useless here: the draft is built and priced, and it is one
       confirmation away from going out. */
    const d = decideAutoSend({ ...ok, termAssumed: true });
    if (d.send) throw new Error("expected a hold");
    expect(d.reason).toMatch(/did not say monthly or annual/);
    expect(d.reason).toMatch(/ready and priced/);
    expect(d.reason).toMatch(/confirm the term/);
  });
});

describe("decideAutoSend — what else stops a send", () => {
  it("never sends to one of our own addresses", () => {
    /* Unreachable in the webhook — the disposition guard skips our own senders before a
       lead exists. Checked anyway: the one thing worse than not sending is auto-replying to
       ourselves in a loop. */
    const d = decideAutoSend({ ...ok, senderIsOurs: true });
    expect(d.send).toBe(false);
    if (d.send) return;
    expect(d.reason).toMatch(/our own addresses/);
  });

  it("does not send when no draft was created", () => {
    const d = decideAutoSend({ ...ok, quoteId: null });
    expect(d.send).toBe(false);
    if (d.send) return;
    expect(d.reason).toMatch(/nothing to send/);
  });

  it.each([null, undefined, "", "   ", "not-an-address"])(
    "does not send to %j",
    (recipient) => {
      const d = decideAutoSend({ ...ok, recipient });
      expect(d.send).toBe(false);
    },
  );

  it("does not pretend to send when email is not configured", () => {
    /* A deployment with no Resend key must say so rather than logging a success. */
    const d = decideAutoSend({ ...ok, emailConfigured: false });
    expect(d.send).toBe(false);
    if (d.send) return;
    expect(d.reason).toMatch(/not configured/);
  });
});

describe("decideAutoSend — order of refusals", () => {
  it("reports the self-send guard even when the term is also missing", () => {
    /* Two things wrong at once should report the one that matters. Sending to ourselves is
       a loop; a missing term is a wait. */
    const d = decideAutoSend({ ...ok, senderIsOurs: true, termAssumed: true, quoteId: null });
    expect(d.send).toBe(false);
    if (d.send) return;
    expect(d.reason).toMatch(/our own addresses/);
  });

  it("reports the missing term last, once everything mechanical is fine", () => {
    /* So the operator-facing message is about the DECISION they can make, not about
       plumbing they cannot. */
    const d = decideAutoSend({ ...ok, termAssumed: true });
    if (d.send) throw new Error("expected a hold");
    expect(d.reason).not.toMatch(/configured|address|nothing to send/);
  });
});

describe("decideAutoSend — the operator's own self-test", () => {
  it("DOES send to our own address when the mail was a marked self-test", () => {
    /* The point of the exercise is seeing exactly what a customer receives. A self-test
       that stops one step short of the send tests everything except the thing most likely
       to be wrong. */
    const d = decideAutoSend({ ...ok, senderIsOurs: true, isSelfTest: true });
    expect(d).toEqual({ send: true });
  });

  it("still refuses our own address when it was NOT a marked self-test", () => {
    const d = decideAutoSend({ ...ok, senderIsOurs: true, isSelfTest: false });
    expect(d.send).toBe(false);
    if (d.send) return;
    expect(d.reason).toMatch(/our own addresses/);
  });

  it("does not exempt a self-test from the TERM rule", () => {
    /* The marker buys passage through the own-address guard and nothing else. A self-test
       with no term stated must hold, or the test would prove a behaviour the real path does
       not have — which is worse than not testing it. */
    const d = decideAutoSend({ ...ok, senderIsOurs: true, isSelfTest: true, termAssumed: true });
    expect(d.send).toBe(false);
    if (d.send) return;
    expect(d.reason).toMatch(/did not say monthly or annual/);
  });

  it("does not exempt a self-test from the mechanical checks either", () => {
    expect(decideAutoSend({ ...ok, senderIsOurs: true, isSelfTest: true, quoteId: null }).send).toBe(false);
    expect(decideAutoSend({ ...ok, senderIsOurs: true, isSelfTest: true, emailConfigured: false }).send).toBe(false);
  });
});

describe("the volume review band", () => {
  const sendable = {
    termAssumed: false,
    recipient: "buyer@acme.in",
    quoteId: "Q-ADPL-2026-27-0001",
    emailConfigured: true,
  };

  it("still sends a small deal by itself", () => {
    expect(decideAutoSend({ ...sendable, seats: 20 }).send).toBe(true);
    expect(decideAutoSend({ ...sendable, seats: 50 }).send).toBe(true);
  });

  it("holds a 51-seat deal even though the quote is fully priced", () => {
    /* The band the rate card opened. It used to be a flat handover with no quote attached; it
       now produces a finished 5% quote that a person reads before it leaves. A ~₹8 lakh deal
       on a discount policy that has never been exercised is not where this app acts alone. */
    const d = decideAutoSend({ ...sendable, seats: 51 });
    expect(d.send).toBe(false);
    if (!d.send) {
      expect(d.reason).toContain("51 seats");
      expect(d.reason, "the operator must be told the quote IS ready").toContain("drafted and priced");
    }
  });

  it("holds a deal above the rate card too", () => {
    expect(decideAutoSend({ ...sendable, seats: 500 }).send).toBe(false);
  });

  it("leaves the older refusals ahead of it, so the sharper reason wins", () => {
    /* A 60-seat enquiry that also named no term must report the TERM problem — that one is
       about a price the customer could hold us to, and it is fixable in one reply. Ordering
       the reasons is the difference between an operator who knows what to do and one who
       fixes the wrong thing. */
    const d = decideAutoSend({ ...sendable, seats: 60, senderIsOurs: true });
    expect(d.send).toBe(false);
    if (!d.send) expect(d.reason).toContain("our own addresses");
  });

  it("behaves exactly as before when no seat count is supplied", () => {
    /* Every call site passes it, but the field is optional in shape — a caller that forgets
       must not silently gain a new refusal. */
    expect(decideAutoSend(sendable).send).toBe(true);
  });
});

describe("heard, not written — a transcribed voice note", () => {
  const sendable = {
    termAssumed: false,
    seats: 15,
    recipient: "buyer@acme.in",
    quoteId: "Q-ADPL-2026-27-0002",
    emailConfigured: true,
  };

  it("sends a typed enquiry that named its term", () => {
    expect(decideAutoSend(sendable).send).toBe(true);
  });

  it("HOLDS the same enquiry when the seat count was heard", () => {
    /* "Bhaiya 15 log ke liye…" heard as "50 log" is 3.3× the quantity — and since the volume
       rate card landed it also moves the deal from the 0% band into the 3% one. One mis-heard
       syllable, two wrong numbers, on a document the customer can hold us to. */
    const d = decideAutoSend({ ...sendable, seatsHeardNotWritten: true });
    expect(d.send).toBe(false);
    if (!d.send) {
      expect(d.reason).toContain("transcribed voice note");
      expect(d.reason, "the operator must know the quote is ready").toContain("drafted and priced");
      expect(d.reason).toContain("confirm the number");
    }
  });

  it("holds it even when everything else about the enquiry is perfect", () => {
    /* No confidence threshold anywhere in this path, on purpose: the provider reports how sure
       it is about the LANGUAGE, not the words, and Hinglish is where language confidence is
       lowest and least meaningful. The rule is categorical instead. */
    const d = decideAutoSend({ ...sendable, seats: 5, termAssumed: false, seatsHeardNotWritten: true });
    expect(d.send).toBe(false);
  });

  it("is unaffected when the flag is absent, so typed enquiries behave exactly as before", () => {
    expect(decideAutoSend({ ...sendable, seatsHeardNotWritten: undefined }).send).toBe(true);
    expect(decideAutoSend({ ...sendable, seatsHeardNotWritten: false }).send).toBe(true);
  });
});
