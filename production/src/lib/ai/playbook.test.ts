import { describe, it, expect } from "vitest";
import {
  MIN_DEALS_FOR_GUIDANCE,
  PLAYBOOK_FORBIDDEN,
  redactLesson,
  retrieveGuidance,
  seatBandFor,
  verifyLessonIsSafe,
  type DealLesson,
  type RawClosedDeal,
} from "./playbook";
import { AUTHORISED_CLAIMS } from "./tone";
import { findPromises } from "./promise-check";

/** A real-shaped won deal, with everything dangerous in the transcript. */
const wonDeal: RawClosedDeal = {
  outcome: "won",
  customerMessages: [
    "Zoho is cheaper, we were quoted Rs 2,40,000 by them for Sharma Traders",
    "too expensive, and we will buy direct from Google if you cannot match it",
  ],
  claimsLedWith: ["gst_invoice", "migration_included"],
  seats: 30,
  turnCount: 9,
  hadBusinessDomain: true,
};

const lesson = (over: Partial<DealLesson> = {}): DealLesson => ({
  outcome: "won",
  objections: ["cheaper_elsewhere"],
  claimsLedWith: ["gst_invoice"],
  seatBand: "21-50",
  turnCount: 8,
  hadBusinessDomain: true,
  ...over,
});

/* ══ THE LOOP OPTIMISES FOR WHAT CLOSES, AND FALSE CLAIMS CLOSE ══════════════ */

describe("what this module refuses to learn, and why", () => {
  const all = PLAYBOOK_FORBIDDEN.join(" | ");

  it("refuses to keep any wording from a conversation, and names the reason", () => {
    /* ─── THE DEEPEST PROBLEM, AND IT IS NOT SAMPLE SIZE ──────────────────────
       An outcome-driven loop optimises for WHAT CLOSES DEALS, and false claims close deals.
       Every guard in this codebase exists because the most persuasive thing to say is often the
       thing we cannot say: "official Google Partner" reassures a skeptic, "free 2-hour
       migration" closes an urgent buyer, "99.9% SLA" wins a technical buyer, "first month free"
       answers a price objection. All four were refused this week; all four would help win a
       deal. A system mining won conversations for winning phrases rediscovers every one of them
       and reintroduces it carrying the authority of "the data says this works". */
    expect(all).toContain("Do NOT store or retrieve any part of a customer's conversation verbatim");
    expect(all).toContain("selects for persuasiveness rather than truth");
  });

  it("refuses to keep a rupee figure, because it would bypass the money guard", () => {
    /* verifyDraftMoney measures a draft against `allowedMoney`, built from the catalogue. A
       figure retrieved from another deal's transcript is a price from a second source — which is
       the failure the whole money discipline is built to prevent. */
    expect(all).toContain("Do NOT store a rupee figure");
    expect(all).toContain("measures a draft against the catalogue and nothing else");
  });

  it("refuses to keep a customer's identity", () => {
    expect(all).toContain("Do NOT store a customer name, company, domain, address or contact");
    expect(all).toContain("their disclosure to make");
  });

  it("refuses to let the loop edit a prompt", () => {
    /* The diagram has "AI Knowledge Base Auto-Updater" writing "Updated Prompts". The prompt is
       where every guard lives. */
    expect(all).toContain("Do NOT let this loop edit any prompt");
    expect(all).toContain("dilute those guards in the direction of whatever closes deals");
  });

  it("exports no function that returns prompt text", () => {
    /* Structural, not a rule. There is nothing in this module a caller could paste into a
       prompt: every export returns identifiers, counts, or a refusal sentence. */
    const guidance = retrieveGuidance({ lessons: [], objections: ["too_expensive"], seatBand: "21-50" });
    expect(typeof guidance.leadWith === "string" || guidance.leadWith === null).toBe(true);
    expect(Object.keys(guidance).sort()).toEqual(["leadWith", "matched", "unavailable", "won"]);
  });
});

/* ══ The transcript is read and thrown away ══════════════════════════════════ */

describe("redactLesson keeps no prose at all", () => {
  it("extracts the objections and discards every word", () => {
    const l = redactLesson(wonDeal);
    expect(l.objections).toContain("cheaper_elsewhere");
    expect(l.objections).toContain("too_expensive");
    expect(l.objections).toContain("buy_direct");

    /* The dangerous parts of that transcript are simply not present. */
    const serialised = JSON.stringify(l);
    expect(serialised).not.toContain("Sharma");
    expect(serialised).not.toContain("2,40,000");
    expect(serialised).not.toContain("240000");
    expect(serialised).not.toContain("Zoho");
  });

  it("uses the BATTLECARD taxonomy, not a second list", () => {
    /* detectObjections is the same function the prompt uses to choose which card to load, so
       what gets LEARNED and what gets ANSWERED cannot drift. */
    const l = redactLesson(wonDeal);
    for (const o of l.objections) {
      expect(["cheaper_elsewhere", "buy_direct", "too_expensive", "thinking_about_it"]).toContain(o);
    }
  });

  it("reduces a seat count to a BAND", () => {
    /* "The 30-seat deal at Sharma Traders" is a customer; "the 21-50 band" is a pattern. */
    expect(redactLesson(wonDeal).seatBand).toBe("21-50");
    expect(JSON.stringify(redactLesson(wonDeal))).not.toContain("30");
  });

  it("filters claims against the authorised list rather than trusting the caller", () => {
    const l = redactLesson({
      ...wonDeal,
      // @ts-expect-error deliberately outside the union, as a bad caller would pass
      claimsLedWith: ["gst_invoice", "iso_certified", "uptime_sla"],
    });
    expect(l.claimsLedWith).toEqual(["gst_invoice"]);
    for (const c of l.claimsLedWith) expect(AUTHORISED_CLAIMS).toContain(c);
  });

  it("records a lost deal exactly the same way", () => {
    /* The friction points are as useful as the winning ones, and neither may carry wording. */
    const l = redactLesson({ ...wonDeal, outcome: "lost" });
    expect(l.outcome).toBe("lost");
    expect(verifyLessonIsSafe(l).safe).toBe(true);
  });

  it("survives an empty conversation", () => {
    const l = redactLesson({ ...wonDeal, customerMessages: [] });
    expect(l.objections).toEqual([]);
    expect(verifyLessonIsSafe(l).safe).toBe(true);
  });
});

describe("seatBandFor", () => {
  it.each([
    [null, "unknown"],
    [0, "unknown"],
    [-5, "unknown"],
    [1, "1-20"],
    [20, "1-20"],
    [21, "21-50"],
    [50, "21-50"],
    [51, "51-100"],
    [100, "51-100"],
    [101, "100+"],
    [5000, "100+"],
  ])("puts %s in %s", (seats, band) => {
    expect(seatBandFor(seats as number | null)).toBe(band);
  });

  it("uses the same boundaries the rate card does", () => {
    /* 20/50/100 are REVIEW_ABOVE_SEATS and the volume slab edges. A band that disagreed with the
       pricing bands would group deals that were priced differently. */
    expect(seatBandFor(20)).not.toBe(seatBandFor(21));
    expect(seatBandFor(50)).not.toBe(seatBandFor(51));
    expect(seatBandFor(100)).not.toBe(seatBandFor(101));
  });
});

/* ══ Verified, not trusted ══════════════════════════════════════════════════ */

describe("verifyLessonIsSafe", () => {
  it("passes a properly reduced lesson", () => {
    expect(verifyLessonIsSafe(lesson()).safe).toBe(true);
  });

  it("CATCHES a figure that survived the reduction", () => {
    /* The check exists because redactLesson being careful is not the same as it being correct,
       and a field added later is covered without anybody remembering to extend this. */
    const bad = { ...lesson(), turnCount: 240_000 } as DealLesson;
    const v = verifyLessonIsSafe(bad);
    expect(v.safe).toBe(false);
    expect(v.reason).toContain("240000");
    expect(v.reason).toContain("a price from outside the catalogue");

    /* ─── AND THIS TEST CAUGHT THE CHECK BEING BLIND ──────────────────────────
       The first version scanned serialised JSON with /(?<![w.:"])d{3,}/, excluding ':' so it
       would not match inside keys — and in JSON every numeric VALUE is preceded by ':'. So it
       could not see a number field at all, and this exact case passed. The check validates the
       SHAPE now: every field against its own closed set. */
  });

  it("allows a legitimate small number", () => {
    /* turnCount is the one real number here. One and two digits pass, three do not — the same
       threshold the prompt tests use. */
    expect(verifyLessonIsSafe({ ...lesson(), turnCount: 9 }).safe).toBe(true);
    expect(verifyLessonIsSafe({ ...lesson(), turnCount: 42 }).safe).toBe(true);
  });

  it("CATCHES a currency mention however it got there", () => {
    /* Not by looking for a currency symbol — by refusing anything that is not one of the five
       bands. A whitelist catches what a blacklist has to anticipate. */
    const bad = { ...lesson(), seatBand: "Rs 3,240 band" } as unknown as DealLesson;
    const v = verifyLessonIsSafe(bad);
    expect(v.safe).toBe(false);
    expect(v.reason).toContain("is not a seat band");
  });

  it("accepts every legitimate band, including the ones with numbers in the label", () => {
    /* "51-100" tripped the first version's numeric scan. A band label is structure, not a
       figure, and conflating the two is what made that scan wrong in both directions. */
    for (const seatBand of ["1-20", "21-50", "51-100", "100+", "unknown"] as const) {
      expect(verifyLessonIsSafe({ ...lesson(), seatBand }).safe, seatBand).toBe(true);
    }
  });

  it("CATCHES a long piece of text, which means prose survived", () => {
    /* Wording is what carries an unauthorised claim from one deal into the next. Every
       legitimate value here is a short enumerated token. */
    /* Through `unknown`, because a direct cast is itself the type error and TypeScript then
       reports the @ts-expect-error as unused. What these tests mean is "pretend a bad caller
       produced this shape", and `unknown` is how that is spelled. */
    const bad = {
      ...lesson(),
      seatBand: "they said our security posture was the deciding factor in the end",
    } as unknown as DealLesson;
    const v = verifyLessonIsSafe(bad);
    expect(v.safe).toBe(false);
    expect(v.reason).toContain("is not a seat band");
  });

  it("would catch the whole raw transcript being stored", () => {
    /* The failure this module exists to make impossible, asserted directly. */
    const bad = {
      ...lesson(),
      transcript: wonDeal.customerMessages.join(" "),
    } as unknown as DealLesson;
    const v = verifyLessonIsSafe(bad);
    expect(v.safe).toBe(false);
    /* Caught because `transcript` is not a known FIELD — not because its contents happened to
       look suspicious. A whitelist on the shape does not have to guess what a leak looks like. */
    expect(v.reason).toContain("which a lesson has no field for");
    expect(v.reason).toContain("wording is how an");
  });

  it("passes every lesson redactLesson can produce, over a spread of inputs", () => {
    /* The two halves have to agree: whatever the reducer emits, the checker must accept — or the
       feature is broken in the safe direction and nothing gets learned at all. */
    for (const seats of [null, 5, 30, 75, 400]) {
      for (const outcome of ["won", "lost"] as const) {
        for (const messages of [[], wonDeal.customerMessages, ["thinking about it"]]) {
          const l = redactLesson({ ...wonDeal, outcome, seats, customerMessages: messages });
          const v = verifyLessonIsSafe(l);
          expect(v.safe, `${outcome}/${seats}: ${v.reason}`).toBe(true);
        }
      }
    }
  });
});

/* ══ It will not recommend on three deals ═══════════════════════════════════ */

describe("retrieveGuidance", () => {
  const many = (n: number, over: Partial<DealLesson> = {}) =>
    Array.from({ length: n }, () => lesson(over));

  it("refuses to recommend below the minimum, and says how far off it is", () => {
    /* The live count of won deals WITH a conversation attached is ZERO — 27 won deals, none
       with a recorded conversation — so this threshold is doing work today. */
    const g = retrieveGuidance({
      lessons: many(3),
      objections: ["cheaper_elsewhere"],
      seatBand: "21-50",
    });
    expect(g.leadWith).toBeNull();
    expect(g.matched).toBe(3);
    expect(g.unavailable).toContain("Only 3 closed deals match");
    expect(g.unavailable).toContain(String(MIN_DEALS_FOR_GUIDANCE));
    expect(g.unavailable).toContain("not a pattern");
  });

  it("recommends once there are enough matching deals", () => {
    const g = retrieveGuidance({
      lessons: many(MIN_DEALS_FOR_GUIDANCE),
      objections: ["cheaper_elsewhere"],
      seatBand: "21-50",
    });
    expect(g.leadWith).toBe("gst_invoice");
    expect(g.matched).toBe(MIN_DEALS_FOR_GUIDANCE);
    expect(g.unavailable).toBe("");
  });

  it("returns a claim IDENTIFIER, never a phrase", () => {
    const g = retrieveGuidance({
      lessons: many(30),
      objections: ["cheaper_elsewhere"],
      seatBand: "21-50",
    });
    expect(AUTHORISED_CLAIMS).toContain(g.leadWith!);
  });

  it("requires the seat band to match, not just the objection", () => {
    /* The answer to a price objection at 12 seats is not the answer at 200, where a discount
       band exists. */
    const g = retrieveGuidance({
      lessons: many(40, { seatBand: "1-20" }),
      objections: ["cheaper_elsewhere"],
      seatBand: "100+",
    });
    expect(g.matched).toBe(0);
    expect(g.leadWith).toBeNull();
  });

  it("requires a shared objection, not just the band", () => {
    const g = retrieveGuidance({
      lessons: many(40, { objections: ["thinking_about_it"] }),
      objections: ["buy_direct"],
      seatBand: "21-50",
    });
    expect(g.matched).toBe(0);
  });

  it("counts only WON deals toward the recommendation, but reports both", () => {
    const lessons = [
      ...many(20, { outcome: "won", claimsLedWith: ["gst_invoice"] }),
      ...many(20, { outcome: "lost", claimsLedWith: ["local_support"] }),
    ];
    const g = retrieveGuidance({ lessons, objections: ["cheaper_elsewhere"], seatBand: "21-50" });
    expect(g.matched).toBe(40);
    expect(g.won).toBe(20);
    expect(g.leadWith).toBe("gst_invoice");
  });

  it("holds a stable order between two equally successful claims", () => {
    /* Guidance that moves without the data moving is guidance nobody trusts twice. */
    const lessons = [
      ...many(15, { claimsLedWith: ["gst_invoice"] }),
      ...many(15, { claimsLedWith: ["local_support"] }),
    ];
    const a = retrieveGuidance({ lessons, objections: ["cheaper_elsewhere"], seatBand: "21-50" });
    const b = retrieveGuidance({
      lessons: [...lessons].reverse(),
      objections: ["cheaper_elsewhere"],
      seatBand: "21-50",
    });
    expect(a.leadWith).toBe(b.leadWith);
  });

  it("says so when the matching deals recorded no claim at all", () => {
    const g = retrieveGuidance({
      lessons: many(30, { claimsLedWith: [] }),
      objections: ["cheaper_elsewhere"],
      seatBand: "21-50",
    });
    expect(g.leadWith).toBeNull();
    expect(g.unavailable).toContain("None of the matching deals recorded which claim");
  });

  it("survives an empty lesson store", () => {
    const g = retrieveGuidance({ lessons: [], objections: [], seatBand: "unknown" });
    expect(g.matched).toBe(0);
    expect(g.leadWith).toBeNull();
    expect(g.unavailable.length).toBeGreaterThan(20);
  });
});

/* ══ Nothing here could be echoed into a reply unsafely ══════════════════════ */

describe("the sentences this module produces are sendable", () => {
  it("every refusal and unavailable message passes the promise guard", () => {
    /* These reach an operator rather than a customer, but the habit is the point: two blocks
       earlier today were written with a token their own guard refuses. */
    const sentences = [
      ...PLAYBOOK_FORBIDDEN,
      retrieveGuidance({ lessons: [], objections: [], seatBand: "unknown" }).unavailable,
      verifyLessonIsSafe({ ...lesson(), turnCount: 999 }).reason,
    ];
    for (const s of sentences) {
      if (!s) continue;
      /* The money prohibition names money deliberately, so it is exempt from the currency half —
         but it must still not contain a date or a guarantee. */
      const verdict = findPromises(s);
      const onlyMoney =
        verdict.findings.length > 0 && verdict.findings.every((f) => f.kind === "money");
      expect(verdict.safe || onlyMoney, `${verdict.reason} :: ${s.slice(0, 60)}`).toBe(true);
    }
  });
});
