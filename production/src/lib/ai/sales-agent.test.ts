import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyHandoverRules,
  buildSalesAgentPrompt,
  parseSalesAgentDecision,
  quoteIsWarranted,
  maskAuthorisedSellingPoints,
  perSeatPerYear,
  isBelowCost,
  authorisedTotalsFor,
  HANDOVER_SEAT_CEILING,
  MIN_AUTONOMOUS_CONFIDENCE,
  MAX_CONTEXT_TURNS,
  SALES_AGENT_SYSTEM_PROMPT,
  type SalesAgentDecision,
  type SalesCatalogEntry,
} from "./sales-agent";
import { planQuoteFromEnquiry } from "@/lib/quotes/quote-from-enquiry";
import { findPromises } from "./promise-check";

/* ─────────────────────────────────────────────────────────────────────────────
   The AI sales agent's decisions.

   Everything here is about the same question: what can the model make happen on its own,
   and what must it not. The model writes the words; these rules decide whether the words
   reach a customer. So the tests that matter are the refusals.
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Every figure here is ₹ per seat per YEAR, which is what `SalesCatalogEntry` holds.
 *
 * They are round numbers chosen for readable assertions, NOT the live catalogue's — the live
 * `items.msrp` is per MONTH and `loadSalesCatalog` multiplies it by 12 (see MONTHS_PER_YEAR).
 * Said here because reading "270" in a per-year field is exactly the misreading that produced
 * a twelve-times under-quote on 24 Aug 2026.
 */
const CATALOGUE: SalesCatalogEntry[] = [
  {
    sku: "gw-starter",
    name: "Google Workspace Business Starter",
    vendor: "google",
    msrpPerSeatPerYear: 270,
    wholesalePerSeatPerYear: 110,
  },
  {
    sku: "gw-standard",
    name: "Google Workspace Standard",
    vendor: "google",
    msrpPerSeatPerYear: 864,
    wholesalePerSeatPerYear: 620,
  },
];

const LEAD = {
  leadId: "L-TEST",
  company: "Acme Pvt Ltd",
  contactName: "Asha",
  seats: 12,
  plan: "Google Workspace Business Starter",
  customerContact: "asha@acme.in",
  channel: "email" as const,
  existingQuoteId: null,
};

function decision(over: Partial<SalesAgentDecision> = {}): SalesAgentDecision {
  return {
    customer_intent: "wants a quote for 12 Starter seats",
    perceived_sentiment: "interested",
    confidence_score: 0.9,
    action_required: "REPLY",
    handover_reason: null,
    generated_response: {
      email_subject: "Your Google Workspace quote",
      body_text: "Namaste Asha,\n\nStarter is ₹270 per seat per year.\n\nRegards,\nANUTECH",
      whatsapp_summary: "Starter is ₹270 per seat per year.",
    },
    next_followup_loop: { in_hours: 48, trigger_condition: "quote sent, no reply yet" },
    seats_discussed: 12,
    ...over,
  };
}

const ALLOWED = CATALOGUE.map((c) => c.msrpPerSeatPerYear);

/* ── The prompt ──────────────────────────────────────────────────────────── */

describe("the prompt carries the catalogue and nothing it should not", () => {
  it("puts the retail price in front of the model", () => {
    const p = buildSalesAgentPrompt({
      lead: LEAD,
      history: [],
      incoming: "How much for 12 users?",
      catalog: CATALOGUE,
      sellerName: "ANUTECH DIGITAL PVT LTD",
      sellerEmail: "sales@anutech.in",
    });
    expect(p.user).toContain("Google Workspace Business Starter");
    expect(p.user).toContain("270");
  });

  it("NEVER puts a wholesale figure in allowedMoney", () => {
    /* The guard's allow-list is what a draft is measured against. If our cost were in it, a
       draft that quoted ₹110 — our own buying price — to the customer would pass. That is not
       a rounding error, it is handing the margin to the buyer. The cost is still in the PROMPT
       so the model understands the shape of the deal; it is the allow-list it must be absent
       from. */
    const p = buildSalesAgentPrompt({
      lead: LEAD,
      history: [],
      incoming: "How much?",
      catalog: CATALOGUE,
      sellerName: "ANUTECH",
      sellerEmail: "sales@anutech.in",
    });
    /* Was `toEqual([270, 864])` until 25 Aug 2026. The list grew on purpose when the volume
       rate card landed: it now carries each item's list rate AND the rates its slabs can
       produce (270 → 261 at 3%, 256 at 5%), because a discounted figure the agent quotes
       CORRECTLY must not be flagged as unauthorised — that would hand over every 21+ seat
       deal. The rule this test exists for is unchanged and is asserted below: our own buying
       price is still absent, and `discountedRate` refuses any discount that would land on it. */
    /* The tail three arrived with the net-cost block: 12 seats × ₹270 = ₹3,240 taxable, ₹583
       GST, ₹3,823 payable. Same reasoning as the slab rates — a figure the app told the agent
       to state must not then be flagged by the guard measuring what it said.

       And the last two arrived with the cross-sell block: the upgrade's own price (864) and the
       step up from what they asked for (864 - 270 = 594). Same reasoning again — a price the
       app told the agent to offer must not be flagged by the guard reading what it wrote.

       ─── AND A STEP-UP IS A DIFFERENCE, WHICH CAN LAND ON OUR COST ────────────
       594 is one retail price minus another, and nothing about that arithmetic stops it coming
       out equal to a WHOLESALE figure in the same catalogue. It does not here — but
       "unlikely to collide" is not "cannot", and this list is exactly where a collision would
       do damage. So authorisedOfferFigures subtracts the catalogue's own cost figures from its
       result, and the two assertions below are what that protects.

       The rule this test is named for is unchanged and is what those assertions check: our
       buying price is still absent. */
    expect(p.allowedMoney).toEqual([270, 261, 256, 864, 838, 820, 3823, 583, 3240, 864, 594]);
    expect(p.allowedMoney).not.toContain(110);
    expect(p.allowedMoney).not.toContain(620);
  });

  it("authorises no ITC figure for a lead with no GSTIN", () => {
    /* 16 of 28 production leads have none, and this fixture is one of them. An unregistered
       business cannot claim input tax credit, so there must be nothing in the allow-list that
       would let the agent state a claimable amount for them. */
    const p = buildSalesAgentPrompt({
      lead: LEAD,
      history: [],
      incoming: "How much?",
      catalog: CATALOGUE,
      sellerName: "ANUTECH",
      sellerEmail: "sales@anutech.in",
    });
    expect(p.user).toContain("Share your GSTIN");
    expect(p.user).not.toContain("claim back as input tax credit");
  });

  it("states the claimable GST once a valid GSTIN is on the lead", () => {
    const p = buildSalesAgentPrompt({
      lead: { ...LEAD, gstin: "07ABDCA0298H1ZP" },
      history: [],
      incoming: "How much?",
      catalog: CATALOGUE,
      sellerName: "ANUTECH",
      sellerEmail: "sales@anutech.in",
    });
    expect(p.user).toContain("claim back as input tax credit");
    expect(p.user).toContain("Rs 583");
    /* Net of the reclaimable GST, 3,823 − 583. */
    expect(p.allowedMoney).toContain(3_240);
  });

  it("forbids the comparison the brief asked for, in the prompt itself", () => {
    /* The block was specified as "Direct Google se … Reverse Charge GST … ITC claim nahi
       milta" plus a 3.5% card fee and a ₹15,000 migration value. Those are claims about a
       competitor's invoicing entity, about the customer's bank, and about a product with no
       SKU — so the prompt tells the model not to make any of them. */
    const p = buildSalesAgentPrompt({
      lead: { ...LEAD, gstin: "07ABDCA0298H1ZP" },
      history: [],
      incoming: "How much?",
      catalog: CATALOGUE,
      sellerName: "ANUTECH",
      sellerEmail: "sales@anutech.in",
    });
    expect(p.user).toContain("Do NOT compare this with buying direct from any vendor");
    expect(p.user).toContain("do NOT state what a card or");
    expect(p.user).toContain("do NOT put a rupee value on anything we include for free");
  });

  it("omits the block entirely when there is nothing to price yet", () => {
    /* No seat count means no deal shape, and a "net cost" for a deal nobody has described
       would be a confident number about nothing. */
    const p = buildSalesAgentPrompt({
      lead: { ...LEAD, seats: null },
      history: [],
      incoming: "How much?",
      catalog: CATALOGUE,
      sellerName: "ANUTECH",
      sellerEmail: "sales@anutech.in",
    });
    expect(p.user).not.toContain("WHAT THIS COSTS THEM, NET");
  });

  it("never authorises a discounted rate that equals our cost", () => {
    /* The hole the growth above could have opened. For an SKU whose margin happens to equal a
       slab, `floor(list × (1 − pct))` lands exactly on wholesale — and our buying price would
       have entered the allow-list silently, on the one product where it matters. */
    const p = buildSalesAgentPrompt({
      lead: LEAD,
      history: [],
      incoming: "How much?",
      /* 5% off 100 is exactly 95, which is this item's cost. */
      catalog: [{ sku: "X", name: "Thin", vendor: "other", msrpPerSeatPerYear: 100, wholesalePerSeatPerYear: 95 }],
      sellerName: "ANUTECH",
      sellerEmail: "sales@anutech.in",
    });
    expect(p.allowedMoney).not.toContain(95);
  });

  it("tells the model our cost is internal", () => {
    const p = buildSalesAgentPrompt({
      lead: LEAD,
      history: [],
      incoming: "How much?",
      catalog: CATALOGUE,
      sellerName: "ANUTECH",
      sellerEmail: "sales@anutech.in",
    });
    expect(p.user).toContain("INTERNAL, never state");
  });

  it("forbids naming a price at all when the catalogue is empty", () => {
    /* An empty catalogue with a chatty model is how an invented price reaches a customer. */
    const p = buildSalesAgentPrompt({
      lead: LEAD,
      history: [],
      incoming: "How much?",
      catalog: [],
      sellerName: "ANUTECH",
      sellerEmail: "sales@anutech.in",
    });
    expect(p.user).toContain("you may not name any price");
    expect(p.allowedMoney).toEqual([]);
  });

  it("keeps the LAST turns of a long conversation, not the first", () => {
    /* The newest exchange is the one being answered. Trimming from the wrong end would hand
       the model the opening pleasantries and hide the seat count. */
    const history = Array.from({ length: MAX_CONTEXT_TURNS + 5 }, (_, i) => ({
      role: "user" as const,
      content: `message-${i}`,
      channel: "email" as const,
    }));
    const p = buildSalesAgentPrompt({
      lead: LEAD,
      history,
      incoming: "and now?",
      catalog: CATALOGUE,
      sellerName: "ANUTECH",
      sellerEmail: "sales@anutech.in",
    });
    expect(p.user).toContain(`message-${MAX_CONTEXT_TURNS + 4}`);
    expect(p.user).not.toContain("message-0\n");
  });

  it("says a quote already exists, so the agent does not mint a second", () => {
    /* Every quote takes an irreversible number from the gapless CGST Rule 46 series. */
    const p = buildSalesAgentPrompt({
      lead: { ...LEAD, existingQuoteId: "Q-ADPL-2026-27-0007" },
      history: [],
      incoming: "any update?",
      catalog: CATALOGUE,
      sellerName: "ANUTECH",
      sellerEmail: "sales@anutech.in",
    });
    expect(p.user).toContain("Q-ADPL-2026-27-0007");
    expect(p.user).toContain("Do not create a second one");
  });

  it("the system prompt refuses invented prices and unauthorised discounts", () => {
    expect(SALES_AGENT_SYSTEM_PROMPT).toContain("Never invent");
    expect(SALES_AGENT_SYSTEM_PROMPT).toContain("Never promise a discount");
  });
});

/* ── Parsing ─────────────────────────────────────────────────────────────── */

describe("what comes back from the model is validated, not trusted", () => {
  it("accepts a well-formed decision", () => {
    const r = parseSalesAgentDecision(decision());
    expect(r.ok).toBe(true);
  });

  it("rejects a draft with no body and says which field", () => {
    /* The reason lands on the lead's timeline, so it has to name the problem. */
    const bad = decision();
    const r = parseSalesAgentDecision({
      ...bad,
      generated_response: { ...bad.generated_response, body_text: "" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("body_text");
  });

  it("rejects an action it does not recognise", () => {
    const r = parseSalesAgentDecision({ ...decision(), action_required: "SEND_INVOICE" });
    expect(r.ok).toBe(false);
  });

  it("clamps a confidence above 1 instead of throwing the answer away", () => {
    /* A model answering 1.2 has still said "very sure". Discarding that replaces a usable
       signal with a retry. */
    const r = parseSalesAgentDecision({ ...decision(), confidence_score: 1.4 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.decision.confidence_score).toBe(1);
  });

  it("clamps a negative confidence to 0", () => {
    const r = parseSalesAgentDecision({ ...decision(), confidence_score: -3 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.decision.confidence_score).toBe(0);
  });

  it("refuses a follow-up scheduled absurdly far out", () => {
    /* Unbounded, this is a scheduling primitive under the model's control: "in 100000 hours"
       is a silently dropped lead. */
    const r = parseSalesAgentDecision({
      ...decision(),
      next_followup_loop: { in_hours: 100_000, trigger_condition: "someday" },
    });
    expect(r.ok).toBe(false);
  });

  it("refuses a follow-up scheduled for right now", () => {
    /* 0 hours means the nudge races the reply it is following up on. */
    const r = parseSalesAgentDecision({
      ...decision(),
      next_followup_loop: { in_hours: 0, trigger_condition: "immediately" },
    });
    expect(r.ok).toBe(false);
  });

  it("treats a missing follow-up as 'do not remind me', not an error", () => {
    const withoutLoop: Record<string, unknown> = { ...decision() };
    delete withoutLoop.next_followup_loop;
    const r = parseSalesAgentDecision(withoutLoop);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.decision.next_followup_loop).toBeNull();
  });

  it("rejects a non-object outright", () => {
    expect(parseSalesAgentDecision("sure, I'll help!").ok).toBe(false);
    expect(parseSalesAgentDecision(null).ok).toBe(false);
  });
});

/* ── The rules the model does not get a vote on ──────────────────────────── */

describe("handover: the deal is too big", () => {
  it("hands over above the seat ceiling", () => {
    const r = applyHandoverRules({
      decision: decision({ action_required: "GENERATE_QUOTE_AND_SEND" }),
      seats: HANDOVER_SEAT_CEILING + 1,
      allowedMoney: ALLOWED,
    });
    expect(r.decision.action_required).toBe("HANDOVER_TO_HUMAN");
    expect(r.overruled).toBe(true);
    expect(r.reason).toContain("ceiling");
  });

  it("allows a deal exactly AT the ceiling", () => {
    /* The rule is "above", not "at". An off-by-one here silently stops the largest deal the
       agent is trusted with. */
    const r = applyHandoverRules({
      decision: decision({ action_required: "GENERATE_QUOTE_AND_SEND" }),
      seats: HANDOVER_SEAT_CEILING,
      allowedMoney: ALLOWED,
    });
    expect(r.decision.action_required).toBe("GENERATE_QUOTE_AND_SEND");
    expect(r.overruled).toBe(false);
  });

  it("falls back to the model's seat count when the lead has none", () => {
    /* A first enquiry naming 200 seats has nothing on the lead yet. Reading only the lead
       would auto-quote the biggest deal in the pipeline. */
    const r = applyHandoverRules({
      decision: decision({ action_required: "GENERATE_QUOTE_AND_SEND", seats_discussed: 200 }),
      seats: null,
      allowedMoney: ALLOWED,
    });
    expect(r.decision.action_required).toBe("HANDOVER_TO_HUMAN");
    expect(r.reason).toContain("200 seats");
  });

  it("cancels the follow-up on handover", () => {
    /* The lead is a person's problem now. An automated nudge landing on top of a human
       conversation is worse than no nudge. */
    const r = applyHandoverRules({
      decision: decision({ action_required: "GENERATE_QUOTE_AND_SEND" }),
      seats: 500,
      allowedMoney: ALLOWED,
    });
    expect(r.decision.next_followup_loop).toBeNull();
  });
});

describe("handover: the model was not sure enough", () => {
  it("hands over below the confidence floor", () => {
    const r = applyHandoverRules({
      decision: decision({ confidence_score: MIN_AUTONOMOUS_CONFIDENCE - 0.01 }),
      seats: 10,
      allowedMoney: ALLOWED,
    });
    expect(r.decision.action_required).toBe("HANDOVER_TO_HUMAN");
    expect(r.reason).toContain("below");
  });

  it("allows a decision exactly AT the floor", () => {
    const r = applyHandoverRules({
      decision: decision({ confidence_score: MIN_AUTONOMOUS_CONFIDENCE }),
      seats: 10,
      allowedMoney: ALLOWED,
    });
    expect(r.overruled).toBe(false);
  });
});

describe("handover: the draft names money we did not authorise", () => {
  it("catches an invented price in the email body", () => {
    /* The failure this exists for: the model restates a number and nothing downstream
       notices, so a customer is asked for money they do not owe — in the reseller's name. */
    const r = applyHandoverRules({
      decision: decision({
        generated_response: {
          email_subject: "Quote",
          body_text: "Special price for you: ₹199 per seat per year.",
          whatsapp_summary: "Starter is ₹270 per seat per year.",
        },
      }),
      seats: 10,
      allowedMoney: ALLOWED,
    });
    expect(r.decision.action_required).toBe("HANDOVER_TO_HUMAN");
    expect(r.reason).toContain("price we did not authorise");
  });

  it("catches a wrong price in the WhatsApp summary even when the email is clean", () => {
    /* Two separately-written pieces of text. A figure can be right in one and wrong in the
       other, and only one of them is what a WhatsApp customer reads. */
    const r = applyHandoverRules({
      decision: decision({
        generated_response: {
          email_subject: "Quote",
          body_text: "Starter is ₹270 per seat per year.",
          whatsapp_summary: "Starter is ₹99 per seat per year.",
        },
      }),
      seats: 10,
      allowedMoney: ALLOWED,
    });
    expect(r.decision.action_required).toBe("HANDOVER_TO_HUMAN");
    expect(r.reason).toContain("WhatsApp summary");
  });

  it("catches our own wholesale cost being quoted back to the customer", () => {
    /* ₹110 is a real number from the catalogue — it is just the wrong side of it. */
    const r = applyHandoverRules({
      decision: decision({
        generated_response: {
          email_subject: "Quote",
          body_text: "We can do ₹110 per seat per year.",
          whatsapp_summary: "₹270 per seat per year.",
        },
      }),
      seats: 10,
      allowedMoney: ALLOWED,
    });
    expect(r.decision.action_required).toBe("HANDOVER_TO_HUMAN");
  });

  it("passes an authorised price written the Indian way", () => {
    /* Rejecting a CORRECT message because it said "Rs. 864" would be its own kind of false
       alarm, and a guard that cries wolf gets switched off. */
    const r = applyHandoverRules({
      decision: decision({
        generated_response: {
          email_subject: "Quote",
          body_text: "Standard is Rs. 864 per seat per year.",
          whatsapp_summary: "Standard: INR 864 per seat/year.",
        },
      }),
      seats: 10,
      allowedMoney: ALLOWED,
    });
    expect(r.overruled).toBe(false);
  });
});

describe("handover: the draft promises something nobody approved", () => {
  it("catches a delivery date", () => {
    const r = applyHandoverRules({
      decision: decision({
        generated_response: {
          email_subject: "Quote",
          body_text: "Starter is ₹270 per seat per year. We'll migrate everything by Friday.",
          whatsapp_summary: "₹270 per seat per year.",
        },
      }),
      seats: 10,
      allowedMoney: ALLOWED,
    });
    expect(r.decision.action_required).toBe("HANDOVER_TO_HUMAN");
    expect(r.reason).toContain("commits us");
  });

  it("catches an unauthorised discount", () => {
    const r = applyHandoverRules({
      decision: decision({
        generated_response: {
          email_subject: "Quote",
          body_text: "Starter is ₹270 per seat per year, and I can offer you a discount.",
          whatsapp_summary: "₹270 per seat per year.",
        },
      }),
      seats: 10,
      allowedMoney: ALLOWED,
    });
    expect(r.decision.action_required).toBe("HANDOVER_TO_HUMAN");
  });

  it("does NOT trip on 18% GST", () => {
    /* The load-bearing exclusion. findPromises flags every percentage, which is right for an
       acknowledgement that should promise nothing and wrong for a quotation — GST is a
       statutory rate, not a concession. Without this the agent would hand over 100% of the
       time and the feature would be dead on arrival. */
    const r = applyHandoverRules({
      decision: decision({
        generated_response: {
          email_subject: "Quote",
          body_text: "Starter is ₹270 per seat per year. GST at 18% applies.",
          whatsapp_summary: "₹270 per seat per year plus 18% GST.",
        },
      }),
      seats: 10,
      allowedMoney: ALLOWED,
    });
    expect(r.overruled).toBe(false);
    expect(r.decision.action_required).toBe("REPLY");
  });

  it("does NOT trip on the authorised price itself", () => {
    /* The other half of the same exclusion: findPromises runs its money check with an EMPTY
       allow-list, so every price is a "promise" to it. Money is already checked against the
       catalogue above. */
    const r = applyHandoverRules({
      decision: decision(),
      seats: 10,
      allowedMoney: ALLOWED,
    });
    expect(r.overruled).toBe(false);
  });
});

describe("the rules can only ever tighten, never loosen", () => {
  it("leaves a model-chosen handover alone", () => {
    const r = applyHandoverRules({
      decision: decision({ action_required: "HANDOVER_TO_HUMAN" }),
      seats: 2,
      allowedMoney: ALLOWED,
    });
    expect(r.decision.action_required).toBe("HANDOVER_TO_HUMAN");
    expect(r.overruled).toBe(false);
  });

  it("never turns a handover back into a send, even when every other check passes", () => {
    /* The easy bug in the other direction: a later rule that "recovers" a handover because
       the money was fine would quietly undo the model's own decision to be careful — the one
       judgement it is best placed to make. */
    const r = applyHandoverRules({
      decision: decision({
        action_required: "HANDOVER_TO_HUMAN",
        confidence_score: 1,
        seats_discussed: 1,
      }),
      seats: 1,
      allowedMoney: ALLOWED,
    });
    expect(r.decision.action_required).toBe("HANDOVER_TO_HUMAN");
  });
});

/* ── Does a quote actually get made? ────────────────────────────────────── */

describe("quoteIsWarranted", () => {
  it("is false for a plain reply", () => {
    expect(quoteIsWarranted(decision(), 12)).toBe(false);
  });

  it("is true when the agent asked and the seats are known and in range", () => {
    expect(quoteIsWarranted(decision({ action_required: "GENERATE_QUOTE_AND_SEND" }), 12)).toBe(true);
  });

  it("is false with no seat count anywhere", () => {
    /* A quote for an unknown number of seats is a document with an invented quantity on it,
       and it consumes a real number from the gapless GST series to say so. */
    expect(
      quoteIsWarranted(
        decision({ action_required: "GENERATE_QUOTE_AND_SEND", seats_discussed: null }),
        null,
      ),
    ).toBe(false);
  });

  it("is false above the ceiling, so it cannot outflank the handover rule", () => {
    expect(
      quoteIsWarranted(decision({ action_required: "GENERATE_QUOTE_AND_SEND" }), HANDOVER_SEAT_CEILING + 1),
    ).toBe(false);
  });

  it("is false for zero seats", () => {
    expect(quoteIsWarranted(decision({ action_required: "GENERATE_QUOTE_AND_SEND" }), 0)).toBe(false);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   The prompt's own promise list, and the guard that used to refuse it.

   Written 24 Aug 2026 from a live probe: the first real enquiry this agent ever saw was
   read correctly (confidence 0.95) and then blocked by its own guard, because the prompt
   authorises "24/7 support" and "Free migration" and findPromises flags both — `24/7`
   as a date (it reads as 24 July) and bare `free` as a giveaway. Every reply using the
   company's actual selling points handed over.

   These tests pin BOTH sides of the exemption. The false-positive half is why the feature
   works at all; the still-caught half is why the guard is still a guard.
   ───────────────────────────────────────────────────────────────────────────── */

describe("the two claims the prompt authorises", () => {
  it("the prompt really does authorise them — if this fails, the exemption below is wrong", () => {
    /* The exemption is only defensible while the prompt still says these are allowed. If
       somebody removes them from the promise list, this test fails FIRST and points at the
       mask, rather than the mask silently permitting something no longer authorised. */
    expect(SALES_AGENT_SYSTEM_PROMPT).toContain("24/7 support from a named local team");
    expect(SALES_AGENT_SYSTEM_PROMPT).toContain("Free migration of existing mail and data");
  });

  it("does NOT hand over on 24/7 support", () => {
    const r = applyHandoverRules({
      decision: decision({
        generated_response: {
          email_subject: "Quote",
          body_text:
            "Starter is ₹270 per seat per year. You also get 24/7 support from a named local team.",
          whatsapp_summary: "₹270 per seat per year, with 24/7 support.",
        },
      }),
      seats: 10,
      allowedMoney: ALLOWED,
    });
    expect(r.overruled).toBe(false);
    expect(r.decision.action_required).toBe("REPLY");
  });

  it("does NOT hand over on free migration, however the model phrases it", () => {
    for (const line of [
      "Migration of your existing mail and data is free.",
      "We include free migration of your existing mailboxes.",
      "Migration is free of charge.",
    ]) {
      const r = applyHandoverRules({
        decision: decision({
          generated_response: {
            email_subject: "Quote",
            body_text: `Starter is ₹270 per seat per year. ${line}`,
            whatsapp_summary: "₹270 per seat per year.",
          },
        }),
        seats: 10,
        allowedMoney: ALLOWED,
      });
      expect(r.overruled, `"${line}" should not have handed over`).toBe(false);
    }
  });

  it("STILL hands over on a giveaway that is not migration", () => {
    /* The boundary. "free" is exempt only in a sentence about migration — this is the case
       the discount rule exists for, and a mask wide enough to let it through would have
       removed the rule rather than exempted a phrase. */
    const r = applyHandoverRules({
      decision: decision({
        generated_response: {
          email_subject: "Quote",
          body_text: "Starter is ₹270 per seat per year. The first month is free.",
          whatsapp_summary: "₹270 per seat per year.",
        },
      }),
      seats: 10,
      allowedMoney: ALLOWED,
    });
    expect(r.decision.action_required).toBe("HANDOVER_TO_HUMAN");
  });

  it("STILL hands over on a date, even in a migration sentence", () => {
    /* The mask hides `free`, not the whole sentence. A migration DEADLINE is exactly the
       kind of promise a person has to make. */
    const r = applyHandoverRules({
      decision: decision({
        generated_response: {
          email_subject: "Quote",
          body_text:
            "Starter is ₹270 per seat per year. Migration is free and we will finish it by Friday.",
          whatsapp_summary: "₹270 per seat per year.",
        },
      }),
      seats: 10,
      allowedMoney: ALLOWED,
    });
    expect(r.decision.action_required).toBe("HANDOVER_TO_HUMAN");
    expect(r.reason).toContain("Friday");
  });

  it("the mask rewrites nothing else — same text, character for character", () => {
    /* It splits on sentence punctuation and rejoins. A mask that reflowed the body would
       change what the promise check reads in every OTHER sentence, which is a guard failing
       for a reason nobody would look for. */
    const body =
      "Hello.\nStarter is ₹270 per seat per year!\nShall I raise a quotation? Thanks.\n";
    expect(maskAuthorisedSellingPoints(body)).toBe(body);
  });

  it("masks 24x7 and 24 * 7 too, because a model writes all three", () => {
    expect(maskAuthorisedSellingPoints("24/7 support")).not.toContain("24/7");
    expect(maskAuthorisedSellingPoints("24x7 support")).not.toContain("24x7");
    expect(maskAuthorisedSellingPoints("24 * 7 support")).not.toMatch(/24\s*\*\s*7/);
  });

  /* ── The rate card's own volume discount (26 Aug 2026) ──────────────────────
     Measured on Q-ADPL-2026-27-0017, the first real quotation this agent sent: the email
     said "70 seats at Rs 3,240 per seat per year, plus 18% GST" — Rs 2,67,624 by the
     reader's own arithmetic — while the document totalled Rs 2,54,243, because the 5% band
     for 51–100 seats was applied and never mentioned.

     The prompt now requires naming it. Without the mask that instruction would hand over
     EVERY discounted quotation, which is the dead-feature shape this whole function exists
     to prevent. The tests that matter here are the four that must still HOLD. */

  const AUTHORISED = 5;

  it("excuses the slab this deal actually gets", () => {
    const body = "Rs 3,240 per seat per year, less the 5% volume discount for 51-100 seats.";
    expect(maskAuthorisedSellingPoints(body, AUTHORISED)).not.toMatch(/\bdiscount\b/i);
  });

  it("STILL HOLDS a discount with no percentage — 'I can give you a discount'", () => {
    /* The sentence a salesperson is allowed to say and a machine is not. No figure means
       nothing the app computed, so there is nothing authorised to excuse. */
    const body = "I can give you a discount on this.";
    expect(maskAuthorisedSellingPoints(body, AUTHORISED)).toMatch(/\bdiscount\b/i);
  });

  it("STILL HOLDS a percentage the rate card did not give — 10% when the slab is 5%", () => {
    /* The model rounding up, or inventing, or conceding to win an argument. This is the case
       the whole guard exists for, and the exemption must not reach it. */
    const body = "As a special case I can offer a 10% discount.";
    expect(maskAuthorisedSellingPoints(body, AUTHORISED)).toMatch(/\bdiscount\b/i);
  });

  it("STILL HOLDS when the slab authorises nothing — 1-20 seats is list price", () => {
    /* Under 21 seats the rate card gives 0%. A reply naming any discount there is inventing
       one, so the caller passes null and nothing is excused. */
    const body = "Happy to apply a 5% discount for you.";
    expect(maskAuthorisedSellingPoints(body, null)).toMatch(/\bdiscount\b/i);
    expect(maskAuthorisedSellingPoints(body, 0)).toMatch(/\bdiscount\b/i);
    expect(maskAuthorisedSellingPoints(body)).toMatch(/\bdiscount\b/i);
  });

  it("STILL HOLDS a discount in a DIFFERENT sentence from the authorised figure", () => {
    /* Sentence-scoped, like the migration/`free` rule above it. Otherwise one authorised
       percentage anywhere in the mail would excuse every other promise in it. */
    const body = "The volume rate is 5% for this band. I can also throw in a discount.";
    expect(maskAuthorisedSellingPoints(body, AUTHORISED)).toMatch(/\bdiscount\b/i);
  });

  it("does not accept a near-miss figure — 5.5% against an authorised 5", () => {
    /* The slabs are whole percents. Accepting a decimal that merely starts with the right
       digits is precisely the widening this file warns about elsewhere. */
    const body = "Applying a 5.5% discount for this size.";
    expect(maskAuthorisedSellingPoints(body, AUTHORISED)).toMatch(/\bdiscount\b/i);
  });

  it("reads 'per cent' and 'percent' as well as '%'", () => {
    for (const w of ["5%", "5 percent", "5 per cent"]) {
      const body = `A ${w} volume discount applies at this seat count.`;
      expect(maskAuthorisedSellingPoints(body, AUTHORISED), w).not.toMatch(/\bdiscount\b/i);
    }
  });

  it("changes nothing when no discount word is present", () => {
    /* The mask must stay a no-op on the ordinary reply — same character-for-character rule
       the test above pins for the other two exemptions. */
    const body = "Rs 3,240 per seat per year, plus 18% GST. Shall I raise the quotation?";
    expect(maskAuthorisedSellingPoints(body, AUTHORISED)).toBe(body);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   The prompt hands over the FINISHED volume rate, it does not ask for a lookup.

   Two live quotations, both wrong the same way:
     Q-ADPL-2026-27-0017  70 seats — "Rs 3,240 per seat per year plus 18% GST", 5% unmentioned
     Q-ADPL-2026-27-0018  80 seats — the same, AFTER an instruction telling it to say so

   The second one is why this block exists. The instruction was deployed and verified live, and
   the model still skipped it, because it asked for three things the app already knew: find the
   band, do the arithmetic, remember to mention it. So the figures are computed here and the
   model only repeats them — the shape `authorisedTotals` already uses for rupee totals.
   ───────────────────────────────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────────────────────────────
   A handover says WHY, and the log stops guessing.

   26 Aug 2026. A customer answered "monthly" on an 80-seat quotation. The agent handed over
   and the operator's log read "the agent was not confident enough to answer this itself".
   Its confidence was 0.95 against a 0.7 threshold. That sentence was a fallback used for
   EVERY unoverruled handover — which is exactly the case where the model chose to hand over
   deliberately, so it reported the one thing that was not the reason.

   The real reason: the agent has no monthly rate and refused to invent one. An hour went into
   finding that, and the log had pointed away from it the whole time.
   ───────────────────────────────────────────────────────────────────────────── */

describe("handover_reason", () => {
  const raw = {
    customer_intent: "wants monthly billing",
    perceived_sentiment: "neutral",
    confidence_score: 0.95,
    action_required: "HANDOVER_TO_HUMAN",
    generated_response: { email_subject: "s", body_text: "b", whatsapp_summary: "w" },
    next_followup_loop: null,
    seats_discussed: 80,
  };

  it("is carried through when the model gives one", () => {
    const r = parseSalesAgentDecision({ ...raw, handover_reason: "no monthly rate in the catalogue" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.decision.handover_reason).toBe("no monthly rate in the catalogue");
  });

  it("defaults to null rather than failing the parse", () => {
    /* A terser model reply must still produce a usable decision. A missing reason costs a
       vaguer log line; a schema error costs the entire reply — and this schema sits between a
       customer's message and any answer at all. */
    const r = parseSalesAgentDecision(raw);
    expect(r.ok).toBe(true);
    expect(r.ok && r.decision.handover_reason).toBeNull();
  });

  it("the prompt asks for it, and names a FACT not a feeling", () => {
    expect(SALES_AGENT_SYSTEM_PROMPT).toContain("handover_reason");
    expect(SALES_AGENT_SYSTEM_PROMPT).toContain("no monthly rate in the catalogue");
  });

  it("the dispatcher stops claiming low confidence for a chosen handover", () => {
    /* Source scan: dispatchSalesDecision writes to the DB, so there is no unit seam. What is
       being protected is a SENTENCE an operator reads at 11pm to decide whether to take a lead
       over — and the old one sent me to the wrong place for an hour. */
    const code = readFileSync(
      join(process.cwd(), "src", "lib", "ai", "actions", "quote-dispatcher.ts"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    expect(code).toContain("decision.handover_reason");
    /* The exact old string must not come back. */
    expect(code).not.toContain("was not confident enough to answer this itself");
    /* And when the model gave no reason, the line carries the confidence so the reader can
       see for themselves that it was not the problem. */
    expect(code).toContain("confidence_score.toFixed(2)");
  });
});

describe("THIS DEAL'S VOLUME RATE is computed, not looked up", () => {
  const build = (seats: number | null, plan: string | null = "Google Workspace Business Starter") =>
    buildSalesAgentPrompt({
      lead: { ...LEAD, seats, plan },
      history: [],
      incoming: "quote please",
      catalog: CATALOGUE,
      sellerName: "ANUTECH DIGITAL PVT LTD",
      sellerEmail: "sales@anutech.in",
    }).user;

  it("80 seats gets the 5% band with both rupee figures worked out", () => {
    /* Its own catalogue, on purpose. The shared CATALOGUE fixture carries 270 in a field named
       `msrpPerSeatPerYear` — a per-MONTH value in a per-year slot, which is the exact confusion
       the "items.msrp is per MONTH" block below was written about. Asserting the live numbers
       against that fixture would pass while proving nothing about the real deal.

       These are Q-ADPL-2026-27-0018's actual figures: ₹270/month = ₹3,240/year list, less the
       5% band for 51–100 seats = ₹3,078. */
    const p = buildSalesAgentPrompt({
      lead: { ...LEAD, seats: 80 },
      history: [],
      incoming: "quote please",
      catalog: [{ ...CATALOGUE[0], msrpPerSeatPerYear: 3240, wholesalePerSeatPerYear: 1320 }],
      sellerName: "ANUTECH DIGITAL PVT LTD",
      sellerEmail: "sales@anutech.in",
    }).user;
    expect(p).toContain("THIS DEAL'S VOLUME RATE");
    expect(p).toContain("5%");
    expect(p).toMatch(/3,240/);
    expect(p).toMatch(/3,078/);
  });

  it("21-50 seats gets 3%, not 5% — the band is read from slabFor, not written here", () => {
    const p = build(30);
    expect(p).toContain("3%");
    expect(p).not.toMatch(/THIS DEAL'S VOLUME RATE[\s\S]{0,300}\b5%/);
  });

  it("1-20 seats gets NO block at all — inventing a discount there is the old bug", () => {
    /* The rate card gives 0% under 21 seats. A block naming any discount would be telling the
       model to promise something the quote will not apply. */
    expect(build(12)).not.toContain("THIS DEAL'S VOLUME RATE");
    expect(build(20)).not.toContain("THIS DEAL'S VOLUME RATE");
  });

  it("no seat count and no product mean no block", () => {
    /* Without either there is no single rate to name. The rate-card TABLE is still in the
       prompt for that case, which is what the model needs while it is still asking. */
    expect(build(null)).not.toContain("THIS DEAL'S VOLUME RATE");
    expect(build(80, null)).not.toContain("THIS DEAL'S VOLUME RATE");
    expect(build(80, "A Product We Do Not Sell")).not.toContain("THIS DEAL'S VOLUME RATE");
  });

  it("above 100 seats there is no block — that deal is a person's job", () => {
    /* slabFor returns a non-slab outcome above CUSTOM_PRICING_ABOVE, and applyHandoverRules
       hands the deal over anyway. A discount line here would be drafting words for a reply
       that must never be sent. */
    expect(build(150)).not.toContain("THIS DEAL'S VOLUME RATE");
  });

  it("stays silent when the discount would reach our own cost", () => {
    /* discountedRate REFUSES a slab that lands at or below cost, and returns appliedPercent 0.
       Naming a discount the quote will not apply is the SAME bug this block fixes, in mirror
       image: words the document contradicts. Cost 3,100 against a 5%-discounted 3,078. */
    const thin = [{ ...CATALOGUE[0], wholesalePerSeatPerYear: 3100 }];
    const p = buildSalesAgentPrompt({
      lead: { ...LEAD, seats: 80 },
      history: [],
      incoming: "quote please",
      catalog: thin,
      sellerName: "ANUTECH DIGITAL PVT LTD",
      sellerEmail: "sales@anutech.in",
    }).user;
    expect(p).not.toContain("THIS DEAL'S VOLUME RATE");
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   The unit of `items.msrp`, pinned across BOTH paths that price from it.

   Found live on 24 Aug 2026. `loadSalesCatalog` copied `items.msrp` into a field named
   `msrpPerSeatPerYear` without the × 12, so the agent's covering email said "12 seats of
   Google Workspace Standard at Rs 864 per seat per year" while the quote it referenced by
   number said ₹1,500/seat/year and the truth was ₹10,368. Two of those three numbers were
   below our own cost — and verifyDraftMoney APPROVED it, because its allow-list came from
   the same wrong figures.

   The cross-path test is the important one. A test that only checked `perSeatPerYear(864)`
   would have passed on the day the bug shipped, because the bug was a belief about the
   column, not an arithmetic slip.
   ───────────────────────────────────────────────────────────────────────────── */

describe("items.msrp is per MONTH, and both paths must agree", () => {
  /* AGENTS.md §1's own example, and the live row behind it. */
  const STARTER = { msrpPerMonth: 270, wholesalePerMonth: 110 };
  const STANDARD = { msrpPerMonth: 864, wholesalePerMonth: 620 };

  it("converts to per-year", () => {
    expect(perSeatPerYear(STARTER.msrpPerMonth)).toBe(3240);
    expect(perSeatPerYear(STANDARD.msrpPerMonth)).toBe(10368);
  });

  it("agrees with the QUOTE path's annual rate for the same item", () => {
    /* The guard that matters. planQuoteFromEnquiry has always been right; this asserts the
       agent's figure is the SAME number, so the two cannot drift apart again. If somebody
       removes the × 12 from either side, this fails and names both files. */
    const plan = planQuoteFromEnquiry({
      item: {
        id: "GW-STD",
        name: "Google Workspace Standard",
        msrp: STANDARD.msrpPerMonth,
        wholesale: STANDARD.wholesalePerMonth,
      },
      seats: 12,
      term: "annual",
      newLineId: () => "line-1",
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.items[0].rate).toBe(perSeatPerYear(STANDARD.msrpPerMonth));
  });

  it("the per-year retail is ABOVE the per-year cost — the bug made it far below", () => {
    /* With the unit wrong, the agent stated ₹864/year against a ₹7,440/year cost. Stated as
       an assertion so the shape of the failure is recorded, not just the fix. */
    expect(perSeatPerYear(STANDARD.msrpPerMonth)).toBeGreaterThan(
      perSeatPerYear(STANDARD.wholesalePerMonth),
    );
    expect(STANDARD.msrpPerMonth).toBeLessThan(perSeatPerYear(STANDARD.wholesalePerMonth));
  });
});

describe("a SKU priced below its own cost is withheld from the agent", () => {
  it("flags retail under cost", () => {
    expect(isBelowCost({ msrpPerSeatPerYear: 5000, wholesalePerSeatPerYear: 7440 })).toBe(true);
  });

  it("allows retail above cost", () => {
    expect(isBelowCost({ msrpPerSeatPerYear: 10368, wholesalePerSeatPerYear: 7440 })).toBe(false);
  });

  it("treats an unrecorded cost as unknown, not as free", () => {
    /* A missing cost must not remove a real product from the catalogue — the same call
       loadSalesCatalog already made about margin being context-only. */
    expect(isBelowCost({ msrpPerSeatPerYear: 1200, wholesalePerSeatPerYear: 0 })).toBe(false);
  });

  it("allows retail exactly at cost", () => {
    /* Zero margin is a commercial decision somebody may have made on purpose. Below cost is
       not. The boundary is asserted so a later `<=` does not quietly withhold real SKUs. */
    expect(isBelowCost({ msrpPerSeatPerYear: 7440, wholesalePerSeatPerYear: 7440 })).toBe(false);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Totals the APP works out, so the agent can state the amount it is writing about.

   Found the moment the unit bug was fixed, 24 Aug 2026. The agent computed the correct
   annual total and was refused for it:

     "The draft's email names a price we did not authorise (Rs 1,24,416)"

   ₹1,24,416 is 12 × ₹10,368 — right, and not in the allow-list, because a total is
   arithmetic and the model is not trusted with arithmetic. Correct rule, fatal consequence:
   a covering email for a quote must say the amount, so every quote email handed over.

   The answer is not to trust the model with sums. It is for the app to do them.
   ───────────────────────────────────────────────────────────────────────────── */

describe("authorised totals", () => {
  const CATALOG = [
    { sku: "GW-STD", name: "Google Workspace Business Standard", vendor: "google", msrpPerSeatPerYear: 10368, wholesalePerSeatPerYear: 7440 },
    { sku: "GW-PLS", name: "Google Workspace Business Plus", vendor: "google", msrpPerSeatPerYear: 16560, wholesalePerSeatPerYear: 13800 },
  ];

  it("works out seats × price for the product on the lead", () => {
    expect(
      authorisedTotalsFor(CATALOG, { plan: "Google Workspace Business Standard", seats: 12 }),
    ).toEqual([124416]);
  });

  it("authorises NOTHING when a fact is missing", () => {
    /* Empty means "state no total", which is the strict direction — the agent falls back to
       the per-seat price, which is always authorised. */
    expect(authorisedTotalsFor(CATALOG, { plan: "Google Workspace Business Standard", seats: null })).toEqual([]);
    expect(authorisedTotalsFor(CATALOG, { plan: null, seats: 12 })).toEqual([]);
    expect(authorisedTotalsFor(CATALOG, { plan: "Google Workspace Business Standard", seats: 0 })).toEqual([]);
  });

  it("refuses to guess when the product is not in the catalogue", () => {
    /* No fuzzy matching — the rule quote-dispatcher's resolveItem follows. A near-miss would
       authorise a figure computed from the WRONG product's price, which is worse than
       authorising nothing. */
    expect(authorisedTotalsFor(CATALOG, { plan: "Standard", seats: 12 })).toEqual([]);
  });

  it("the prompt carries them, and the money guard accepts a draft that states one", () => {
    const p = buildSalesAgentPrompt({
      lead: { ...LEAD, plan: "Google Workspace Business Standard", seats: 12 },
      history: [],
      incoming: "Please send the quotation.",
      catalog: CATALOG,
      sellerName: "ANUTECH DIGITAL PVT LTD",
      sellerEmail: "sales@anutech.in",
      authorisedTotals: authorisedTotalsFor(CATALOG, { plan: "Google Workspace Business Standard", seats: 12 }),
    });

    expect(p.user).toContain("AUTHORISED TOTALS");
    expect(p.allowedMoney).toContain(124416);
    expect(p.allowedMoney).toContain(10368);

    /* End to end: the exact sentence that was refused live must now pass. */
    const r = applyHandoverRules({
      decision: decision({
        generated_response: {
          email_subject: "Your quotation",
          body_text:
            "12 seats of Google Workspace Business Standard comes to Rs 1,24,416 per year, " +
            "plus 18% GST.",
          whatsapp_summary: "Rs 1,24,416 per year plus 18% GST.",
        },
      }),
      seats: 12,
      allowedMoney: p.allowedMoney,
    });
    expect(r.overruled, `reason: ${r.reason}`).toBe(false);
  });

  it("STILL refuses a total the app did not work out", () => {
    /* The boundary. Authorising one computed figure must not open the door to any figure —
       a model that adds a "setup fee" or rounds the total up is the case this catches. */
    const p = buildSalesAgentPrompt({
      lead: { ...LEAD, plan: "Google Workspace Business Standard", seats: 12 },
      history: [],
      incoming: "Please send the quotation.",
      catalog: CATALOG,
      sellerName: "A",
      sellerEmail: "sales@anutech.in",
      authorisedTotals: authorisedTotalsFor(CATALOG, { plan: "Google Workspace Business Standard", seats: 12 }),
    });

    const r = applyHandoverRules({
      decision: decision({
        generated_response: {
          email_subject: "Your quotation",
          body_text: "12 seats comes to Rs 1,30,000 per year all inclusive.",
          whatsapp_summary: "Rs 1,30,000 per year.",
        },
      }),
      seats: 12,
      allowedMoney: p.allowedMoney,
    });
    expect(r.decision.action_required).toBe("HANDOVER_TO_HUMAN");
    expect(r.reason).toContain("1,30,000");
  });

  it("says plainly when no total is authorised", () => {
    const p = buildSalesAgentPrompt({
      lead: { ...LEAD, plan: null, seats: null },
      history: [],
      incoming: "What do you charge?",
      catalog: CATALOG,
      sellerName: "A",
      sellerEmail: "sales@anutech.in",
    });
    expect(p.user).toContain("you may not state a total");
    expect(p.authorisedTotals).toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   The system prompt's rules, pinned.

   Rewritten 24 Aug 2026 after reading what the model ACTUALLY wrote on four live
   enquiries. Every assertion below is a real observed behaviour, not a hypothetical:

     · it signed off as "ResellerOS" — the software's name, because FROM_EMAIL's default
       carries it and the prompt said "signing as <that>"
     · it never once asked monthly-or-annual, which is the ONE fact that decides whether a
       quotation may go out at all (`termAssumed` in lib/quotes/quote-from-enquiry.ts)
     · it recited all four selling points in every mail, so the second one reads as a brochure
     · it wrote "Rs 864" with no unit — and a bare number is exactly how a twelve-times
       error stayed invisible for a day

   These are string assertions, which is a blunt instrument. They earn their place because a
   prompt is the one part of this module with no other test: nothing else notices when a rule
   is quietly dropped during an edit.
   ───────────────────────────────────────────────────────────────────────────── */

describe("the system prompt keeps the rules that were learned the hard way", () => {
  const P = SALES_AGENT_SYSTEM_PROMPT;

  it("demands the unit beside every price", () => {
    expect(P).toContain("per seat per year");
    expect(P).toMatch(/bare number/i);
  });

  it("forbids the model doing its own arithmetic, and points at AUTHORISED TOTALS", () => {
    expect(P).toMatch(/NEVER multiply, add or total anything yourself/i);
    expect(P).toContain("AUTHORISED TOTALS");
  });

  it("chases the billing term, because a quotation cannot go out without it", () => {
    /* The highest-value line in the whole prompt: monthly and annual differ by 12x, and
       `termAssumed` blocks the auto-send. The agent used to never ask. */
    expect(P).toMatch(/MONTHLY OR ANNUAL/i);
    expect(P).toMatch(/differ by 12x/i);
  });

  it("asks for one missing fact at a time, in a stated order", () => {
    expect(P).toMatch(/one thing at a time/i);
    expect(P).toContain("1. which product");
    expect(P).toContain("3. monthly or annual");
  });

  it("caps the selling points, so a second mail does not read as a brochure", () => {
    expect(P).toMatch(/AT MOST TWO/);
    expect(P).toMatch(/brochure/i);
  });

  it("refuses to sign as a product or platform name", () => {
    /* Observed: "Warm regards, ResellerOS, ANUTECH DIGITAL PVT LTD". The envelope string is
       plumbing and the customer should never see it. */
    expect(P).toMatch(/SIGNING OFF/);
    expect(P).toMatch(/never sign as, or mention, any product or platform name/i);
  });

  it("refuses to claim it did something in the customer's account", () => {
    expect(P).toMatch(/cannot log into their account/i);
    expect(P).toMatch(/Never say a document was 'sent' or 'attached'/i);
  });

  it("requires a concrete next step, never a bare 'let me know'", () => {
    /* CLAUDE.md §24 applied to a sales reply: a message that does not say what to do next is
       one somebody has to think about before answering, and they will not. */
    expect(P).toMatch(/ONE THING YOU NEED/);
    expect(P).toMatch(/never a bare 'let me know'/i);
  });

  it("still keeps every money refusal it had before", () => {
    /* The rewrite must not have traded an old guard for a new one. */
    expect(P).toContain("Never invent");
    expect(P).toContain("Never promise a discount");
    expect(P).toMatch(/wholesale figures are OUR cost/);
    expect(P).toMatch(/HANDOVER_TO_HUMAN/);
  });

  it("requires the term for a quote, not just the seat count", () => {
    expect(P).toMatch(/the product, the seat count AND the term/i);
  });
});

describe("the prompt's own examples must survive its own guards", () => {
  it("contains no date word that findPromises would refuse", () => {
    /* Measured 24 Aug 2026, one probe after this prompt was rewritten. The next-step example
       read "I will send the quotation TODAY". The model copied the word, findPromises' DATE
       rule caught it, and the whole reply handed over — over one word, in an example I had
       just added to stop replies being vague.

       This is L103 turning up inside the prompt itself: a guard firing on text the prompt
       told the model to produce. So the prompt is now checked against the guard that polices
       its output, which is the only way an example cannot quietly disagree with a rule. */
    /* Through the same mask the real path uses — otherwise this fails on "24/7", which IS
       authorised and IS exempted at runtime. Checking the raw prompt would be checking a
       pipeline that does not exist. */
    const findings = findPromises(
      maskAuthorisedSellingPoints(SALES_AGENT_SYSTEM_PROMPT),
    ).findings.filter((f) => f.kind === "date");
    expect(
      findings.map((f) => f.matched),
      "a date word in the prompt is a date word in the reply",
    ).toEqual([]);
  });

  it("tells the model explicitly that the next step carries no date", () => {
    expect(SALES_AGENT_SYSTEM_PROMPT).toMatch(/NO DATE and NO DEADLINE/);
    expect(SALES_AGENT_SYSTEM_PROMPT).toMatch(/Say WHAT you will do\s+and never WHEN/);
  });
});

describe("battlecards reach the prompt only when an objection was raised", () => {
  const promptFor = (incoming: string) =>
    buildSalesAgentPrompt({
      lead: LEAD,
      history: [],
      incoming,
      catalog: CATALOGUE,
      sellerName: "ANUTECH",
      sellerEmail: "sales@anutech.in",
    }).user;

  it("stays out of an ordinary enquiry", () => {
    /* Loading every card into every prompt would teach the agent to argue with customers who
       were not arguing, and the cards are constraints as much as scripts — the ones that do
       not apply are noise the model has to read past. */
    expect(promptFor("15 log ke liye Google Workspace chahiye, kitna lagega?"))
      .not.toContain("THIS MESSAGE RAISED AN OBJECTION");
  });

  it("appears when the customer says a competitor is cheaper", () => {
    const p = promptFor("Zoho cheaper hai, main Zoho le raha hu");
    expect(p).toContain("THIS MESSAGE RAISED AN OBJECTION");
    expect(p).toContain("we sell it too");
  });

  it("carries NO price anchor when we do not stock the named vendor", () => {
    /* This fixture's catalogue is two Google items and no Zoho, so there is nothing to anchor
       against — and the card falls back to asking what the customer needs rather than inventing
       a comparison. Asserted here because the first version of this test expected the anchor
       and was reading the wrong fixture: `priceAnchor` returning null IS the correct behaviour
       for a vendor we do not carry. The anchor itself is covered in battlecards.test.ts, whose
       catalogue has both. */
    expect(promptFor("Zoho cheaper hai")).not.toContain("Price anchor");
  });

  it("forbids the vendor claims the brief asked for", () => {
    /* The briefed card said "Direct Google par ... GST invoice lagne mein dikkat aati hai" —
       the same claim lib/pricing/net-cost.ts refuses, because Google bills Indian customers
       through Google Cloud India Pvt Ltd against an Indian GSTIN. Letting the battlecard say
       it would break that guard from the other side, on the same day it was written. */
    const p = promptFor("Main direct Google se khareed lunga");
    expect(p).toContain("does not issue a GST invoice");
    expect(p).toContain("no phone support");
  });

  it("never offers the comparison sheet that does not exist", () => {
    expect(promptFor("Zoho cheaper hai").toLowerCase()).not.toContain("comparison sheet");
  });
});
