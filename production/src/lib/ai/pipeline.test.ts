import { describe, it, expect } from "vitest";
import {
  QUALIFIER_SYSTEM_PROMPT,
  REQUIRED_FACTS,
  SALES_STAGES,
  mergeQualification,
  narrowByQualification,
  parseQualification,
  qualifierBriefing,
  qualifierUserPrompt,
  atLeastAsCautious,
  stage,
  type AgentAction,
  type Qualification,
} from "./pipeline";

const qual = (over: Partial<Qualification> = {}): Qualification => ({
  product: "Google Workspace Business Starter",
  seats: 30,
  seats_source: "written",
  term: "annual",
  intent: "wants a quotation",
  objection: null,
  needs_human: false,
  confidence: 0.9,
  ...over,
});

const NOTHING_RECORDED = { plan: null, seats: null };

/* ══ The architectural guard ══════════════════════════════════════════════ */

describe("the pricing stage is CODE, and this test exists to keep it that way", () => {
  it("refuses to let the price stage become a model", () => {
    /* ─── READ THIS BEFORE CHANGING IT ───────────────────────────────────────
       If you are here because you are turning the pricing stage into an AI agent, that is a
       reasonable-sounding idea and it is the one thing in this pipeline that must not happen.
       A quotation is a document the customer can hold us to, and the GST series is a legal
       record under CGST Rule 46. Six separate guards exist to keep arithmetic out of the
       model's hands — catalogue-only prices, app-computed totals, rate-card discounts, the
       cost floor, verifyDraftMoney's allow-list, and the next_document_number allocator — and
       a "pricing agent" bypasses all six at once.

       The failure is invisible, which is what makes it the expensive kind: a model that writes
       a per-month rate onto a per-year line produces a document indistinguishable from a
       correct one, and this system already lost a day to exactly that twelve-times error. */
    const price = stage("price");
    expect(price.kind, price.why).toBe("code");
  });

  it("gives the qualifier NO prices at all", () => {
    /* The concrete win of splitting the prompt. The stage deciding "do we know enough to
       price this?" needs no price to do it, and a stage that cannot see one cannot leak one,
       compute with one, or be talked into naming one. */
    expect(stage("qualify").maySeePrices).toBe(false);
  });

  it("has exactly one code stage, and it is the money one", () => {
    const code = SALES_STAGES.filter((s) => s.kind === "code").map((s) => s.id);
    expect(code).toEqual(["price"]);
  });

  it("gives every stage a stated reason for being the kind it is", () => {
    /* A stage whose `why` is empty is a decision nobody recorded, and the next person to read
       the brief will change it without meeting the argument. */
    for (const s of SALES_STAGES) {
      expect(s.why.length, `${s.id} has no stated reason`).toBeGreaterThan(60);
    }
  });

  it("throws on an unknown stage rather than returning undefined into a guard", () => {
    /* Unreachable through the type. It matters anyway: `stage(...).kind` feeds the assertion
       above, and `undefined.kind` would throw somewhere less legible. */
    // @ts-expect-error deliberately outside the union
    expect(() => stage("pricing")).toThrow(/unknown sales stage/);
  });
});

/* ══ The qualifier's prompt carries no money ══════════════════════════════ */

describe("QUALIFIER_SYSTEM_PROMPT", () => {
  it("contains no figure that could be mistaken for a price", () => {
    /* Same discipline as telecaller-prompt.ts: a price in a prompt goes stale in silence, and
       here it would also undo the whole reason this stage is separate. Three digits or more,
       because the two-and-under numbers in this prompt are the confidence range and the
       seat-count EXAMPLES ("30 users"), which are illustrations of a customer's words rather
       than anything we would charge. */
    const money = QUALIFIER_SYSTEM_PROMPT.match(/(?<![\w.])\d{3,}(?![\w])/g);
    expect(money, `numeric literals found: ${money?.join(", ")}`).toBeNull();
  });

  it("never uses a currency word", () => {
    expect(QUALIFIER_SYSTEM_PROMPT).not.toMatch(/\bRs\b|₹|rupee|paise|GST|per seat/i);
  });

  it("tells the stage it does not write to the customer", () => {
    /* The other half of "no prices": a stage that cannot write to a customer cannot say a
       price even if it somehow worked one out. */
    expect(QUALIFIER_SYSTEM_PROMPT).toContain("YOU DO NOT WRITE TO THE CUSTOMER");
    expect(QUALIFIER_SYSTEM_PROMPT).toContain("YOU HAVE NO PRICES");
  });

  it("resolves ambiguity about the seat count toward asking", () => {
    expect(QUALIFIER_SYSTEM_PROMPT).toContain("choose inferred");
  });
});

/* ══ Stage 1 reconciled against what we hold ══════════════════════════════ */

describe("mergeQualification", () => {
  it("prefers what a colleague recorded over what the model read", () => {
    /* leads.plan and leads.seats were typed by a person or resolved by the dispatcher against
       the catalogue. A model re-reading the same conversation is not grounds to overwrite. */
    const m = mergeQualification(qual({ product: "Zoho Workplace", seats: 5 }), {
      plan: "Google Workspace Business Starter",
      seats: 30,
    });
    expect(m.product).toBe("Google Workspace Business Starter");
    expect(m.seats).toBe(30);
  });

  it("fills in from the qualifier when the lead is silent", () => {
    const m = mergeQualification(qual(), NOTHING_RECORDED);
    expect(m.product).toBe("Google Workspace Business Starter");
    expect(m.seats).toBe(30);
    expect(m.readyToPrice).toBe(true);
  });

  it("REFUSES a seat count the model worked out rather than read", () => {
    /* "the whole team" is not thirty seats, however confident the model is. A seat count
       nobody typed becomes a total on a document the customer never agreed to. */
    const m = mergeQualification(qual({ seats_source: "inferred" }), NOTHING_RECORDED);
    expect(m.seats).toBeNull();
    expect(m.readyToPrice).toBe(false);
    expect(m.blockingReason).toBe("the seat count was worked out, not stated");
  });

  it("REFUSES a written seat count that arrived on a voice note", () => {
    /* Two different doubts, both fatal to pricing: the model may have inferred the number,
       AND a machine may have transcribed the words it came from. Either alone is enough. */
    const m = mergeQualification(qual(), NOTHING_RECORDED, { heardNotWritten: true });
    expect(m.seats).toBeNull();
    expect(m.blockingReason).toBe("the seat count was heard on a voice note, not written");
  });

  it("still trusts a RECORDED seat count on a voice-note thread", () => {
    /* The doubt is about the transcription, not about the lead row. If a colleague wrote 30
       down, a later voice note does not un-write it. */
    const m = mergeQualification(qual({ seats: null, seats_source: "none" }), { plan: null, seats: 30 }, { heardNotWritten: true });
    expect(m.seats).toBe(30);
  });

  it("distinguishes 'no seat count' from 'a seat count I do not trust'", () => {
    const none = mergeQualification(qual({ seats: null, seats_source: "none" }), NOTHING_RECORDED);
    expect(none.blockingReason).toBe("no seat count yet");
  });

  it("asks for the FIRST missing fact only, in order", () => {
    const noProduct = mergeQualification(
      qual({ product: null, seats: null, seats_source: "none", term: null }),
      NOTHING_RECORDED,
    );
    expect(noProduct.missing).toEqual(["product", "seats", "term"]);
    expect(noProduct.askFor).toBe("product");

    const onlyTerm = mergeQualification(qual({ term: null }), NOTHING_RECORDED);
    expect(onlyTerm.missing).toEqual(["term"]);
    expect(onlyTerm.askFor).toBe("term");
    expect(onlyTerm.blockingReason).toBe("monthly or annual not confirmed yet");
  });

  it("never prices when the qualifier asked for a person, even with every fact present", () => {
    const m = mergeQualification(qual({ needs_human: true }), { plan: "X", seats: 30 });
    expect(m.missing).toEqual([]);
    expect(m.readyToPrice).toBe(false);
  });

  it("treats a whitespace-only recorded plan as nothing recorded", () => {
    const m = mergeQualification(qual({ product: "Zoho Mail" }), { plan: "   ", seats: null });
    expect(m.product).toBe("Zoho Mail");
  });

  it("treats a recorded seat count of zero as nothing recorded", () => {
    /* leads.seats defaults to 0 on some rows. Zero seats is not a deal, and reading it as one
       would price a quotation for nobody. */
    const m = mergeQualification(qual({ seats: 12 }), { plan: null, seats: 0 });
    expect(m.seats).toBe(12);
  });

  it("names the fact, not the machinery, in every blocking reason", () => {
    /* §24: a block that says "qualifier blocked" tells an operator to find an engineer. */
    const reasons = [
      mergeQualification(qual({ product: null }), NOTHING_RECORDED),
      mergeQualification(qual({ seats: null, seats_source: "none" }), NOTHING_RECORDED),
      mergeQualification(qual({ seats_source: "inferred" }), NOTHING_RECORDED),
      mergeQualification(qual({ term: null }), NOTHING_RECORDED),
    ].map((m) => m.blockingReason);

    for (const r of reasons) {
      expect(r).not.toMatch(/qualifier|stage|pipeline|model/i);
      expect(r.length).toBeGreaterThan(10);
    }
  });
});

/* ══ The asymmetry ═══════════════════════════════════════════════════════ */

describe("narrowByQualification — may only ever move toward caution", () => {
  const ACTIONS: AgentAction[] = ["GENERATE_QUOTE_AND_SEND", "REPLY", "HANDOVER_TO_HUMAN"];
  const RANK: Record<AgentAction, number> = {
    GENERATE_QUOTE_AND_SEND: 0,
    REPLY: 1,
    HANDOVER_TO_HUMAN: 2,
  };

  const VERDICTS = [
    ["everything known", qual()],
    ["no term", qual({ term: null })],
    ["no product", qual({ product: null })],
    ["inferred seats", qual({ seats_source: "inferred" })],
    ["no seats at all", qual({ seats: null, seats_source: "none" })],
    ["wants a person", qual({ needs_human: true })],
    ["wants a person AND everything known", qual({ needs_human: true })],
  ] as const;

  it("never loosens, for any combination of asked action and verdict", () => {
    /* THIS IS THE WHOLE SAFETY ARGUMENT for letting one model call constrain another. A
       qualifier that misreads a message can only push the agent toward the safe end — the
       worst case costs a salesperson a minute, never a wrong number in front of a customer.
       Walked exhaustively rather than sampled, because it is 21 cases. */
    for (const asked of ACTIONS) {
      for (const [label, q] of VERDICTS) {
        const out = narrowByQualification(asked, mergeQualification(q, NOTHING_RECORDED));
        expect(
          RANK[out.action],
          `${asked} + "${label}" came back as ${out.action}, which is less cautious`,
        ).toBeGreaterThanOrEqual(RANK[asked]);
      }
    }
  });

  it("can never turn a REPLY into a quotation", () => {
    /* The qualifier may STOP a quote. It may not start one. Even with every fact present and
       full confidence, an asked-for REPLY stays a REPLY. */
    const out = narrowByQualification("REPLY", mergeQualification(qual(), { plan: "X", seats: 30 }));
    expect(out.action).toBe("REPLY");
    expect(out.narrowed).toBe(false);
  });

  it("can never take a handover back", () => {
    const out = narrowByQualification(
      "HANDOVER_TO_HUMAN",
      mergeQualification(qual(), { plan: "X", seats: 30 }),
    );
    expect(out.action).toBe("HANDOVER_TO_HUMAN");
  });

  it("hands over — NOT downgrades to REPLY — when a quotation was drafted it may not send", () => {
    /* ─── THE FIRST VERSION OF THIS RETURNED REPLY, AND THAT WAS WRONG ────────
       Not because of the action but because of the DRAFT. `qualifierBriefing` already told the
       responder, on this same turn, that no quotation goes out and which single fact to ask
       for. A responder that asked to quote anyway wrote its prose around a document — a total,
       a reference number, "as per the attached" — and sending that as a plain reply points the
       customer at a document nobody made.

       It is also a real disagreement between two stages about a fact that decides a price, and
       that is a person's call. It should be rare: the ordinary case is both stages seeing the
       same gap and the responder simply asking the question, which never reaches here. */
    const out = narrowByQualification(
      "GENERATE_QUOTE_AND_SEND",
      mergeQualification(qual({ term: null }), NOTHING_RECORDED),
    );
    expect(out.action).toBe("HANDOVER_TO_HUMAN");
    expect(out.narrowed).toBe(true);
    expect(out.reason).toContain("monthly or annual not confirmed yet");
    expect(out.reason).toContain("the draft was written as a quotation");
    expect(out.reason).toContain("confirm the term");
  });

  it("never downgrades a quotation to a plain REPLY, for any missing fact", () => {
    /* The generalisation of the test above. There is no verdict that turns a drafted quotation
       into a sendable reply — every one of them fetches a person instead. */
    for (const q of [
      qual({ term: null }),
      qual({ product: null }),
      qual({ seats: null, seats_source: "none" }),
      qual({ seats_source: "inferred" }),
    ]) {
      const out = narrowByQualification("GENERATE_QUOTE_AND_SEND", mergeQualification(q, NOTHING_RECORDED));
      expect(out.action).toBe("HANDOVER_TO_HUMAN");
    }
  });

  it("escalates a reply to a handover when the qualifier asked for a person", () => {
    const out = narrowByQualification("REPLY", mergeQualification(qual({ needs_human: true }), NOTHING_RECORDED));
    expect(out.action).toBe("HANDOVER_TO_HUMAN");
    expect(out.narrowed).toBe(true);
    expect(out.reason).toContain("take this over");
  });

  it("clamps a looser verdict back to what was asked — tested directly, because nothing reaches it", () => {
    /* ─── THIS TEST EXISTS BECAUSE A MUTATION SURVIVED ───────────────────────
       Deleting the clamp from narrowByQualification left all 48 tests green. Not a weak
       assertion: the branches above it never produce a looser result, so no input could reach
       it. An unreachable guard with a passing test is a guard nobody has checked.

       It is still worth having — it is what keeps the one-directional promise true against a
       future branch somebody adds — so it is now a function, and this hands it the looser
       inputs narrowByQualification cannot. Every pair where `want` is less cautious than
       `asked` must come back as `asked`. */
    const looser: Array<[AgentAction, AgentAction]> = [
      ["REPLY", "GENERATE_QUOTE_AND_SEND"],
      ["HANDOVER_TO_HUMAN", "GENERATE_QUOTE_AND_SEND"],
      ["HANDOVER_TO_HUMAN", "REPLY"],
    ];
    for (const [asked, want] of looser) {
      expect(atLeastAsCautious(asked, want), `${asked} must not be loosened to ${want}`).toBe(asked);
    }

    /* And it must not over-correct: a genuinely tighter verdict has to survive. */
    expect(atLeastAsCautious("GENERATE_QUOTE_AND_SEND", "HANDOVER_TO_HUMAN")).toBe("HANDOVER_TO_HUMAN");
    expect(atLeastAsCautious("GENERATE_QUOTE_AND_SEND", "REPLY")).toBe("REPLY");
    expect(atLeastAsCautious("REPLY", "REPLY")).toBe("REPLY");
  });

  it("leaves a warranted quotation alone", () => {
    const out = narrowByQualification(
      "GENERATE_QUOTE_AND_SEND",
      mergeQualification(qual(), { plan: "X", seats: 30 }),
    );
    expect(out.action).toBe("GENERATE_QUOTE_AND_SEND");
    expect(out.narrowed).toBe(false);
    expect(out.reason).toBe("");
  });
});

/* ══ What stage 1 hands stage 3 ══════════════════════════════════════════ */

describe("qualifierBriefing", () => {
  it("says nothing when there is nothing to constrain", () => {
    /* An empty heading in the responder's prompt is noise, and this prompt is already the
       largest thing the model reads. */
    expect(qualifierBriefing(mergeQualification(qual(), { plan: "X", seats: 30 }))).toEqual([]);
  });

  it("names the one thing to ask for, and forbids the rest", () => {
    const text = qualifierBriefing(mergeQualification(qual({ term: null }), NOTHING_RECORDED)).join("\n");
    expect(text).toContain("THE ONE THING TO ASK FOR: term");
    expect(text).toContain("and nothing else");
    expect(text).toContain("No quotation goes out on this message");
  });

  it("does not leak an untrusted seat count into the responder's prompt", () => {
    /* The inferred 30 must not appear. A number in the prompt is a number the model may
       repeat, and repeating it to the customer is how an inferred figure becomes an agreed
       one — which is the exact thing mergeQualification refused a moment earlier. */
    const text = qualifierBriefing(
      mergeQualification(qual({ seats_source: "inferred" }), NOTHING_RECORDED),
    ).join("\n");
    expect(text).not.toContain("30");
    expect(text).toContain("not confirmed in writing yet");
  });

  it("tells the responder to answer the objection first", () => {
    const text = qualifierBriefing(
      mergeQualification(qual({ objection: "Zoho is cheaper" }), { plan: "X", seats: 30 }),
    ).join("\n");
    expect(text).toContain("THEY PUSHED BACK ON: Zoho is cheaper");
    expect(text).toContain("before anything else");
  });

  it("on a handover, forbids quoting and promising in the same breath", () => {
    const text = qualifierBriefing(
      mergeQualification(qual({ needs_human: true }), { plan: "X", seats: 30 }),
    ).join("\n");
    expect(text).toContain("Do not quote and do not promise anything");
    expect(text).not.toContain("THE ONE THING TO ASK FOR");
  });
});

/* ══ Parsing and the user prompt ═════════════════════════════════════════ */

describe("parseQualification", () => {
  it("accepts a well-formed verdict", () => {
    const r = parseQualification(qual());
    expect(r.ok).toBe(true);
  });

  it.each([
    [{ ...qual(), seats: 0 }, "zero seats"],
    [{ ...qual(), seats: 2.5 }, "a fractional seat"],
    [{ ...qual(), seats_source: "guessed" }, "an invented source"],
    [{ ...qual(), term: "yearly" }, "a term outside the enum"],
    [{ ...qual(), confidence: 1.4 }, "a confidence above one"],
    [{ ...qual(), intent: "" }, "an empty intent"],
    [{}, "an empty object"],
  ])("refuses %#: %s", (raw, why) => {
    const r = parseQualification(raw);
    expect(r.ok, `should refuse ${why}`).toBe(false);
  });

  it("gives the failing field in the reason", () => {
    const r = parseQualification({ ...qual(), term: "yearly" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("term");
  });
});

describe("qualifierUserPrompt", () => {
  const base = {
    company: "Sharma Traders",
    recordedProduct: null,
    recordedSeats: null,
    history: [],
    incoming: "  We need email for our team.  ",
  };

  it("marks what we hold as RECORDED, not as true", () => {
    /* The qualifier's job includes noticing the customer just corrected it. Labelling the old
       figure as fact would tell it to defend the stale number instead. */
    const p = qualifierUserPrompt({ ...base, recordedProduct: "Zoho Mail", recordedSeats: 20 });
    expect(p).toContain("ALREADY RECORDED");
    expect(p).toContain("not");
    expect(p).toContain("necessarily what is true now");
  });

  it("says plainly when a field is empty rather than printing null", () => {
    const p = qualifierUserPrompt(base);
    expect(p).toContain("product: nothing recorded");
    expect(p).toContain("seats: nothing recorded");
    expect(p).not.toContain("null");
  });

  it("prints a recorded zero rather than hiding it", () => {
    /* mergeQualification treats 0 as nothing recorded, but the prompt should still show what
       the row says — a qualifier told "nothing recorded" when the row holds 0 cannot notice
       that the row is wrong. */
    expect(qualifierUserPrompt({ ...base, recordedSeats: 0 })).toContain("seats: 0");
  });

  it("keeps the newest message last and trims it", () => {
    const p = qualifierUserPrompt(base);
    expect(p.trimEnd().endsWith("We need email for our team.")).toBe(true);
  });

  it("labels who said what, and collapses newlines inside a turn", () => {
    const p = qualifierUserPrompt({
      ...base,
      history: [
        { role: "user", content: "Hi\n\nhow much?" },
        { role: "agent", content: "Which product?" },
        { role: "system", content: "quote Q-1 prepared" },
      ],
    });
    expect(p).toContain("CUSTOMER: Hi how much?");
    expect(p).toContain("US: Which product?");
    expect(p).toContain("NOTE: quote Q-1 prepared");
  });

  it("keeps the NEWEST turns when the history is long", () => {
    const history = Array.from({ length: 30 }, (_, i) => ({
      role: "user" as const,
      content: `turn ${i}`,
    }));
    const p = qualifierUserPrompt({ ...base, history, maxTurns: 4 });
    expect(p).toContain("turn 29");
    expect(p).not.toContain("turn 25");
  });

  it("says it is a first message rather than showing an empty conversation", () => {
    expect(qualifierUserPrompt(base)).toContain("this is their first message");
  });
});

describe("REQUIRED_FACTS", () => {
  it("is in ask-for-this-first order", () => {
    /* Product before seats before term. Asking "monthly or annual?" of somebody who has not
       said what they want is a question they cannot answer. */
    expect(REQUIRED_FACTS).toEqual(["product", "seats", "term"]);
  });
});
