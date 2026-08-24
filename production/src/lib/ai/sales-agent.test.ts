import { describe, it, expect } from "vitest";
import {
  applyHandoverRules,
  buildSalesAgentPrompt,
  parseSalesAgentDecision,
  quoteIsWarranted,
  HANDOVER_SEAT_CEILING,
  MIN_AUTONOMOUS_CONFIDENCE,
  MAX_CONTEXT_TURNS,
  SALES_AGENT_SYSTEM_PROMPT,
  type SalesAgentDecision,
  type SalesCatalogEntry,
} from "./sales-agent";

/* ─────────────────────────────────────────────────────────────────────────────
   The AI sales agent's decisions.

   Everything here is about the same question: what can the model make happen on its own,
   and what must it not. The model writes the words; these rules decide whether the words
   reach a customer. So the tests that matter are the refusals.
   ───────────────────────────────────────────────────────────────────────────── */

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
    expect(p.allowedMoney).toEqual([270, 864]);
    expect(p.allowedMoney).not.toContain(110);
    expect(p.allowedMoney).not.toContain(620);
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
