import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_TRANSCRIPT_CHARS,
  callTurnFor,
  heardNotWrittenReason,
  heardSourceLabel,
  recallFacts,
  recallLinesAreSendable,
  resolveSharedIdentity,
  type IdentityCandidate,
} from "./unified-memory";
import { findPromises } from "./promise-check";
import { decideAutoSend } from "@/lib/quotes/auto-send-quote";

/* ══ THE CLAUSE THE BRIEF'S EXAMPLE GETS WRONG ═══════════════════════════════ */

describe("a seat count heard on a phone line is confirmed, never restated", () => {
  it("refuses to state a heard seat count back as settled", () => {
    /* ─── THE BRIEF'S OWN MESSAGE ─────────────────────────────────────────────
       "Subah humari phone par 20 seats Google Workspace ke baare mein baat hui thi."

       auto-send-quote.ts already refuses to price a seat count that came out of a transcribed
       voice note, and a live call is strictly worse: crosstalk, accents, line quality, and
       "twenty" against "twelve" in one syllable. Read back as fact, the number becomes one the
       customer assumes we agreed — and then the quotation is for seats nobody asked for. */
    const lines = recallFacts({
      hadCall: true,
      writtenProduct: "Google Workspace Business Starter",
      writtenSeats: null,
      seatsHeardOnly: 20,
      quoteExists: false,
    });
    const text = lines.join("\n");

    expect(text).not.toContain("20");
    expect(text).toContain("Do NOT state it back to them as settled");
    expect(text).toContain("Ask them to");
    expect(text).toContain("seats nobody asked for");
  });

  it("DOES allow a seat count that is written down", () => {
    /* The distinction is the whole point. A number on the lead row was typed by somebody or
       resolved by the dispatcher; a number off a phone line was not. */
    const text = recallFacts({
      hadCall: true,
      writtenProduct: null,
      writtenSeats: 20,
      seatsHeardOnly: null,
      quoteExists: false,
    }).join("\n");
    expect(text).toContain("Seat count on record: 20");
    expect(text).toContain("written down, so you may state it");
  });

  it("does not ask about a quotation that does not exist", () => {
    /* "Kya aapne quotation dekha?" — the other broken clause. Asking whether somebody read a
       document we never sent is a confusing first line, and SALES_AGENT_SYSTEM_PROMPT already
       forbids claiming one was sent or attached. */
    const text = recallFacts({
      hadCall: true,
      writtenProduct: null,
      writtenSeats: null,
      seatsHeardOnly: null,
      quoteExists: false,
    }).join("\n");
    expect(text).toContain("NO quotation exists on this lead yet");
    expect(text).toContain("Do NOT ask whether they have seen one");
  });

  it("refers to an existing quotation without claiming it was sent", () => {
    const text = recallFacts({
      hadCall: true,
      writtenProduct: null,
      writtenSeats: null,
      seatsHeardOnly: null,
      quoteExists: true,
    }).join("\n");
    expect(text).toContain("A quotation exists on this lead");
    expect(text).toContain("Do not say it was sent or attached");
  });

  it("says nothing at all when there was no call", () => {
    expect(
      recallFacts({
        hadCall: false,
        writtenProduct: "X",
        writtenSeats: 30,
        seatsHeardOnly: 20,
        quoteExists: true,
      }),
    ).toEqual([]);
  });
});

/* ══ The recall must survive our own promise guard ═══════════════════════════ */

describe("the recall block would itself pass findPromises", () => {
  it("never names a day or a time", () => {
    /* ─── THE TRAP THE TRADE-IN BLOCK FELL INTO TWO FEATURES AGO ──────────────
       "We spoke today" and "aaj baat hui thi" both contain tokens findPromises refuses — `today`
       and `aaj` are unconditional date matches — and `date` is in RELEVANT_PROMISE_KINDS, so a
       reply echoing either would be HELD. This module's whole subject is the past, which is
       exactly where a date word appears naturally. So the wording is "earlier" and "on our
       call", and the guard is run over every combination rather than over one sample. */
    const combos = [true, false].flatMap((quoteExists) =>
      [null, 20].flatMap((seatsHeardOnly) =>
        [null, 30].flatMap((writtenSeats) =>
          [null, "Google Workspace Business Starter"].map((writtenProduct) =>
            recallFacts({ hadCall: true, writtenProduct, writtenSeats, seatsHeardOnly, quoteExists }),
          ),
        ),
      ),
    );

    for (const lines of combos) {
      const verdict = findPromises(lines.join(" "));
      expect(verdict.safe, `held over: ${verdict.reason}`).toBe(true);
      expect(recallLinesAreSendable(lines)).toBe(true);
    }
  });

  it("tells the model not to guess when the call happened", () => {
    /* We are not given a timestamp, and a wrong "this morning" undoes the entire effect the
       brief is after. */
    const text = recallFacts({
      hadCall: true,
      writtenProduct: null,
      writtenSeats: null,
      seatsHeardOnly: null,
      quoteExists: false,
    }).join("\n");
    expect(text).toContain("not a day or a time");
    expect(text).toContain("a wrong 'this morning' undoes the whole effect");
  });
});

/* ══ The turn a call leaves behind ═══════════════════════════════════════════ */

describe("callTurnFor", () => {
  const base = {
    transcript: "Customer asked about Workspace for the sales team.",
    outcome: "completed",
    seatsHeard: 20,
    productHeard: null,
    durationSeconds: 245,
  };

  it("marks a heard seat count as heard, in words the next turn can read", () => {
    const t = callTurnFor(base);
    expect(t).toContain("Seat count HEARD on the call: 20");
    expect(t).toContain("NOT confirmed");
    expect(t).toContain("in writing");
  });

  it("reports the length in minutes, phrased as a length and not a commitment", () => {
    /* "about 4 minutes" is how long it took; "in 4 minutes" is a promise. The note goes into a
       prompt, and anything in a prompt can be echoed. */
    expect(callTurnFor(base)).toContain("Lasted about 4 minutes");
    expect(findPromises(callTurnFor(base)).safe).toBe(true);
  });

  it("says 'under a minute' rather than '0 minutes'", () => {
    /* Zero minutes reads as a bug and invites somebody to go looking for one. */
    expect(callTurnFor({ ...base, durationSeconds: 12 })).toContain("Lasted under a minute");
    expect(callTurnFor({ ...base, durationSeconds: 12 })).not.toContain("0 minute");
  });

  it("omits the length entirely when the vendor did not report one", () => {
    const t = callTurnFor({ ...base, durationSeconds: null });
    expect(t).not.toContain("Lasted");
  });

  it("truncates a long transcript rather than crowding out the conversation", () => {
    const t = callTurnFor({ ...base, transcript: "x".repeat(MAX_TRANSCRIPT_CHARS + 500) });
    expect(t).toContain("(transcript truncated)");
    expect(t.length).toBeLessThan(MAX_TRANSCRIPT_CHARS + 400);
  });

  it("survives an empty transcript and no seat count", () => {
    const t = callTurnFor({
      transcript: null,
      outcome: "no_answer",
      seatsHeard: null,
      productHeard: null,
      durationSeconds: null,
    });
    expect(t).toBe("Phone call — no_answer.");
  });

  it("never reports a zero or negative seat count as heard", () => {
    for (const seatsHeard of [0, -5]) {
      expect(callTurnFor({ ...base, seatsHeard })).not.toContain("Seat count HEARD");
    }
  });
});

/* ══ Reading it back ════════════════════════════════════════════════════════ */

describe("the note written and the note read are the same shape", () => {
  it("the webhook's prefix is what the reader looks for", () => {
    /* Two sides of one contract, and neither is reachable from a unit test on its own: the
       webhook writes the note and sales-agent.server.ts decides `hadCall` from its first
       words. If they drift, the recall silently never fires — a feature that looks built. */
    expect(callTurnFor({
      transcript: null, outcome: "completed", seatsHeard: null, productHeard: null,
      durationSeconds: null,
    }).startsWith("Phone call —")).toBe(true);

    const src = readFileSync(join(__dirname, "sales-agent.server.ts"), "utf8");
    expect(src).toContain('t.content.startsWith("Phone call —")');
  });

  it("the seat pattern written is the seat pattern parsed", () => {
    const src = readFileSync(join(__dirname, "sales-agent.server.ts"), "utf8");
    expect(src).toContain("Seat count HEARD on the call: ");
    const note = callTurnFor({
      transcript: null, outcome: "completed", seatsHeard: 17, productHeard: null,
      durationSeconds: null,
    });
    expect(/Seat count HEARD on the call: (\d+)/.exec(note)?.[1]).toBe("17");
  });
});

/* ══ Identity — the actual risk ══════════════════════════════════════════════ */

describe("resolveSharedIdentity refuses to guess", () => {
  const lead = (leadId: string, phoneDigits: string | null, contactEmail: string | null): IdentityCandidate => ({
    leadId,
    phoneDigits,
    contactEmail,
  });

  it("always prefers a known lead id over any matching", () => {
    /* It came from the row we wrote, not from comparing strings. */
    const v = resolveSharedIdentity({
      knownLeadId: "L-1",
      phoneDigits: "9876543210",
      contactEmail: "a@b.in",
      candidates: [lead("L-9", "9876543210", "a@b.in")],
    });
    expect(v).toEqual({ merge: true, leadId: "L-1", on: "lead" });
  });

  it("merges on a phone number that matches exactly one lead", () => {
    const v = resolveSharedIdentity({
      knownLeadId: null,
      phoneDigits: "9876543210",
      contactEmail: null,
      candidates: [lead("L-1", "9876543210", null), lead("L-2", "9000000000", null)],
    });
    expect(v).toEqual({ merge: true, leadId: "L-1", on: "phone" });
  });

  it("REFUSES a phone number that matches two leads", () => {
    /* ─── THIS IS THE DISCLOSURE, NOT AN INCONVENIENCE ────────────────────────
       Choosing means telling somebody about a deal that might be another company's — their seat
       count, their product, the fact that they are negotiating. There is no tie-break that
       makes that safe, and "most recent" is the most confident wrong answer available.

       Measured on the live table: 14 leads with a phone, 14 distinct, ZERO collisions today. So
       this is a guard for later — and still required, because at 28 leads zero is not evidence.
       A consultant handling IT for three firms, a shared office landline, the same person
       enquiring twice: each produces one number against several leads, and each is ordinary. */
    const v = resolveSharedIdentity({
      knownLeadId: null,
      phoneDigits: "9876543210",
      contactEmail: null,
      candidates: [lead("L-1", "9876543210", null), lead("L-2", "9876543210", null)],
    });
    expect(v.merge).toBe(false);
    if (!v.merge) {
      expect(v.reason).toContain("2 different leads");
      expect(v.reason).toContain("tell one customer about another's deal");
      expect(v.reason).toContain("a person can link it");
    }
  });

  it("REFUSES an address that matches two leads", () => {
    const v = resolveSharedIdentity({
      knownLeadId: null,
      phoneDigits: null,
      contactEmail: "accounts@sharma.in",
      candidates: [lead("L-1", null, "accounts@sharma.in"), lead("L-2", null, "accounts@sharma.in")],
    });
    expect(v.merge).toBe(false);
  });

  it("falls through to email when the phone matches nothing", () => {
    const v = resolveSharedIdentity({
      knownLeadId: null,
      phoneDigits: "9111111111",
      contactEmail: "a@b.in",
      candidates: [lead("L-1", "9876543210", "a@b.in")],
    });
    expect(v).toEqual({ merge: true, leadId: "L-1", on: "email" });
  });

  it("does not merge when nothing matches, and says why", () => {
    const v = resolveSharedIdentity({
      knownLeadId: null,
      phoneDigits: "9111111111",
      contactEmail: "new@person.in",
      candidates: [lead("L-1", "9876543210", "a@b.in")],
    });
    expect(v.merge).toBe(false);
    if (!v.merge) expect(v.reason).toContain("new enquiry");
  });

  it("matches an address case-insensitively but a number exactly", () => {
    const upper = resolveSharedIdentity({
      knownLeadId: null,
      phoneDigits: null,
      contactEmail: "Rahul@Sharma.IN",
      candidates: [lead("L-1", null, "rahul@sharma.in")],
    });
    expect(upper.merge).toBe(true);

    /* Digits are digits — a substring or a differently-prefixed number is a DIFFERENT number,
       and loosening this is how a wrong merge happens. */
    const loose = resolveSharedIdentity({
      knownLeadId: null,
      phoneDigits: "919876543210",
      contactEmail: null,
      candidates: [lead("L-1", "9876543210", null)],
    });
    expect(loose.merge).toBe(false);
  });

  it("ignores a blank known lead id rather than merging onto nothing", () => {
    const v = resolveSharedIdentity({
      knownLeadId: "   ",
      phoneDigits: "9876543210",
      contactEmail: null,
      candidates: [lead("L-1", "9876543210", null)],
    });
    expect(v).toEqual({ merge: true, leadId: "L-1", on: "phone" });
  });
});

/* ══ The hold reason names the channel it came from ══════════════════════════ */

describe("heardNotWrittenReason", () => {
  it("names a phone call when that is where the number came from", () => {
    /* The refusal used to say "a transcribed voice note" unconditionally. Once the telecall path
       started setting the flag there was a second source, and a held quote whose reason names a
       voice note nobody left sends the operator looking for the wrong thing. */
    expect(heardNotWrittenReason("phone_call")).toContain("a phone call, transcribed by the voice agent");
    expect(heardNotWrittenReason("voice_note")).toContain("a transcribed voice note");
    expect(heardSourceLabel("phone_call")).not.toContain("voice note");
  });

  it("still says which fact is doubtful and what to do about it", () => {
    /* §24: not "failed", not "skipped" — the draft is priced and one confirmation away. */
    for (const source of ["phone_call", "voice_note"] as const) {
      const r = heardNotWrittenReason(source);
      expect(r).toContain("drafted and priced");
      expect(r).toContain("confirm the number with them");
    }
  });

  it("reaches decideAutoSend, which holds the quote rather than dropping it", () => {
    const verdict = decideAutoSend({
      seats: 20,
      seatsHeardNotWritten: true,
      heardSource: "phone_call",
      recipient: "rahul@sharmatraders.in",
      quoteId: "Q-1",
      emailConfigured: true,
      senderIsOurs: false,
      isSelfTest: false,
      termAssumed: false,
    });
    expect(verdict.send).toBe(false);
    /* Narrowed rather than asserted through — AutoSendDecision is a discriminated union and a
       send:true branch carries no reason at all. */
    if (!verdict.send) expect(verdict.reason).toContain("a phone call");
  });
});

/* ══ The hole this closed ════════════════════════════════════════════════════ */

describe("the telecall webhook now carries the doubt it claimed to check", () => {
  const src = readFileSync(
    join(__dirname, "..", "..", "app", "api", "v1", "telecalling", "webhook", "route.ts"),
    "utf8",
  );

  it("passes heardNotWritten into the quote path", () => {
    /* ─── MEASURED 25 AUG 2026: IT DID NOT ────────────────────────────────────
       `heardNotWritten` appeared nowhere in this route, so a seat count heard on a LIVE PHONE
       LINE went to a priced, sent quotation with no writing-doubt guard at all. verifyCallMoney
       checks MONEY figures in the transcript; classifyCall checks how the call ended. Neither
       looks at the seat count.

       It can only ever HOLD: decideAutoSend drafts and prices the quote in full and asks a
       person to confirm the number. Strictly more cautious, one path, additive — which is why
       this was fixed here rather than flagged like the dispatcher's seat resolution. */
    expect(src).toContain("heardNotWritten: true");
  });

  it("no longer claims a check that does not exist", () => {
    /* The comment said "the uncertainty in this path is the seat count, and that is checked
       above". Nothing above checked it. A false comment on a money path is read as authoritative
       by whoever touches the line next. */
    expect(src).not.toContain("that is checked above rather than smuggled");
    expect(src).toContain("AND THE SENTENCE THAT USED TO BE HERE WAS FALSE");
  });

  it("writes the call into the shared transcript", () => {
    expect(src).toContain("recordSalesTurn({");
    expect(src).toContain("callTurnFor({");
    expect(src).toContain('role: "system"');
  });

  it("does not invent a product the vendor never reported", () => {
    /* PostCallSignals has no product field — the vendor reports seats, a disposition and a
       transcript. Deriving a product name from the transcript here would be the app inventing a
       fact about the call. */
    expect(src).toContain("productHeard: null");
  });
});
