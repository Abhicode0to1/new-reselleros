/**
 * The AI sales agent's reasoning layer — prompt in, validated decision out.
 *
 * Everything here is PURE. No Gemini call, no database, no clock: the prompt is built from
 * arguments and the model's answer is validated against a schema. `sales-agent.server.ts`
 * does the fetching and the calling. That split is not tidiness — it is the only way the
 * decisions below (what the agent is allowed to say, when it must fetch a human) can be
 * tested without a network, and they are the decisions that reach a customer.
 *
 * ─── PRICES ARE PASSED IN, NEVER WRITTEN DOWN HERE ──────────────────────────
 * The obvious shape for a sales agent is a product table at the top of the file. It was
 * deliberately not built that way, and this is the most important line in the module.
 *
 * `items.msrp` in the tenant's own catalog is the single source of truth for what a customer
 * pays (lib/pricing/workspace.ts says so, and the public checkout and the auto-quote both
 * read it so "Buy now" and "Get a quote" cannot disagree). A price constant in this file
 * would be a SECOND source, and a second source of a rupee figure does not stay equal to the
 * first — it goes stale silently and the agent quotes yesterday's price with today's
 * confidence.
 *
 * That is not hypothetical. The spec this was built from named Workspace Standard at ₹750;
 * the live catalog says ₹864 (wholesale ₹620), measured 24 Aug 2026. A hardcoded ₹750 would
 * have under-quoted every Standard deal by ₹114/seat/year with nothing to catch it —
 * .github/workflows/money-check.yml exists because four products once shipped with defaults
 * BELOW their own vendor cost. So the catalog is read at call time and handed in as
 * `catalog`, and `allowedMoney` carries exactly those figures to the money guard.
 *
 * ─── WHAT THE MODEL IS AND IS NOT TRUSTED WITH ──────────────────────────────
 * Trusted: reading intent, reading sentiment, choosing words, deciding that a quote is what
 * this customer now wants.
 * Not trusted: arithmetic, document numbers, and its own confidence. Quote totals come from
 * the catalog and lib/pricing; the quote number comes from the `next_document_number` RPC;
 * and `applyHandoverRules` can overrule the model's chosen action but can never relax it —
 * see the function.
 */
import { z } from "zod";
import { verifyDraftMoney } from "./money-guard";
import { findPromises } from "./promise-check";

/**
 * Deals at or above this many seats are not auto-quoted, whatever the model thinks.
 *
 * 50 is a business ceiling, not a technical one: below it a wrong quote is an embarrassment
 * and a credit note, above it the discount conversation is the deal and a machine that
 * skips it loses money that was available. Pardeep's number to move.
 */
export const HANDOVER_SEAT_CEILING = 50;

/**
 * Below this, the agent does not speak to the customer unattended.
 *
 * The model reports its own confidence, which is worth exactly as much as self-reported
 * confidence usually is — so this is a floor on a soft number, not a guarantee. It earns its
 * place anyway: the failure it catches is the enquiry the model half-understood and answered
 * fluently, which is the one a person cannot spot by skimming.
 */
export const MIN_AUTONOMOUS_CONFIDENCE = 0.7;

/** How many past turns go into the prompt. Enough to stop re-asking; short enough to stay cheap. */
export const MAX_CONTEXT_TURNS = 12;

export type SalesChannel = "email" | "whatsapp";
export type SalesTurnRole = "user" | "agent" | "system";

export type SalesAgentAction =
  | "REPLY"
  | "GENERATE_QUOTE_AND_SEND"
  | "HANDOVER_TO_HUMAN";

/** One catalogue line, in WHOLE RUPEES, as read from `items` at call time. */
export interface SalesCatalogEntry {
  /** `items.id` — carried through so the quote line references the real SKU. */
  sku: string;
  name: string;
  vendor: string;
  /** ₹/seat/year the customer pays. `items.msrp` on the annual commitment. */
  msrpPerSeatPerYear: number;
  /** ₹/seat/year we pay the vendor. Never shown to the customer; see buildSalesAgentPrompt. */
  wholesalePerSeatPerYear: number;
}

export interface SalesAgentTurn {
  role: SalesTurnRole;
  content: string;
  channel: SalesChannel;
}

export interface SalesAgentLeadFacts {
  leadId: string;
  company: string;
  contactName: string;
  /** Whole rupees. Null when the customer has not said a number yet. */
  seats: number | null;
  plan: string | null;
  /** Where a reply would go — an email address or an E.164 phone number. */
  customerContact: string;
  channel: SalesChannel;
  /** Quote id already on this lead, if any. Stops the agent quoting twice. */
  existingQuoteId: string | null;
}

export interface BuildPromptArgs {
  lead: SalesAgentLeadFacts;
  /** Oldest first. Trimmed to MAX_CONTEXT_TURNS by this function. */
  history: readonly SalesAgentTurn[];
  /** The newest customer message, not yet in `history`. */
  incoming: string;
  catalog: readonly SalesCatalogEntry[];
  /** The reseller's trading name, for the signature. */
  sellerName: string;
  /** The address the agent signs as, e.g. "sales@anutech.in". */
  sellerEmail: string;
}

export interface BuiltPrompt {
  system: string;
  user: string;
  /**
   * Every rupee figure the agent was authorised to use, for verifyDraftMoney. Retail only —
   * a draft that quotes our wholesale cost back to the customer is a violation, not a
   * rounding error, so the wholesale numbers are deliberately absent from this list even
   * though they are in the prompt.
   */
  allowedMoney: number[];
}

export interface SalesAgentResponse {
  email_subject: string;
  body_text: string;
  whatsapp_summary: string;
}

export interface SalesAgentFollowUp {
  /** Whole hours from now. Bounded by the schema — see SALES_AGENT_SCHEMA. */
  in_hours: number;
  /** Why, in the agent's own words, so the follow-up can refer to what it follows up on. */
  trigger_condition: string;
}

export interface SalesAgentDecision {
  customer_intent: string;
  perceived_sentiment: string;
  confidence_score: number;
  action_required: SalesAgentAction;
  generated_response: SalesAgentResponse;
  /** Null when the agent does not want to be reminded — a closed thread, or a handover. */
  next_followup_loop: SalesAgentFollowUp | null;
  /** Seats the model read out of the conversation. Null when the customer has not said. */
  seats_discussed: number | null;
}

/* ── The master system prompt ─────────────────────────────────────────────── */

/**
 * Written as a list of refusals as much as instructions, because the failure mode of a sales
 * agent is not silence — it is confident invention. Every "never" below is a thing a fluent
 * model does by default when it does not know: quote a number, promise a date, claim a
 * capability, or answer a question it did not understand.
 */
export const SALES_AGENT_SYSTEM_PROMPT = [
  "You are AnuSales AI, the inside-sales assistant for an Indian cloud-solutions reseller.",
  "You answer prospective business customers who have enquired about Google Workspace,",
  "Microsoft 365 or Zoho. You write as a colleague at the company, in plain professional",
  "Indian business English. Never mention that you are an AI.",
  "",
  "MONEY — the rules you must not bend:",
  "- Use ONLY the per-seat prices given to you in CATALOGUE below. They are in whole rupees.",
  "- Never invent, estimate, round, discount or 'approximately' a price. If the price for",
  "  what they asked is not in CATALOGUE, do not name a price at all — say you are checking",
  "  and set action_required to HANDOVER_TO_HUMAN.",
  "- The wholesale figures are OUR cost. They are shown to you so you understand the margin.",
  "  Never state, hint at, or compute from a wholesale figure in anything the customer reads.",
  "- Never promise a discount. Discounts are a human decision at this company.",
  "",
  "WHAT YOU MAY PROMISE, because it is true of every deal here:",
  "- A proper GST tax invoice, so the customer claims 100% input tax credit.",
  "- Billing in INR to an Indian entity — no 3.5% foreign-currency card loading.",
  "- Free migration of existing mail and data.",
  "- 24/7 support from a named local team.",
  "Do not extend these. No uptime figures, no delivery dates, no contractual terms.",
  "",
  "CHOOSING action_required:",
  "- REPLY — they asked something; answer it. The default.",
  "- GENERATE_QUOTE_AND_SEND — they have told you BOTH the product AND the seat count, and",
  "  a formal quotation is the natural next step. Do not choose this if either is missing;",
  "  ask for the missing one with REPLY instead.",
  "- HANDOVER_TO_HUMAN — anything you are not sure of: a price not in CATALOGUE, a legal or",
  "  contractual question, an angry customer, a request for a discount, or a message you do",
  "  not properly understand. Choosing this is a correct answer, not a failure.",
  "",
  "confidence_score is YOUR honest 0-1 read of how well you understood this message and how",
  "safe your reply is to send with nobody checking it. Be harsh. A low score costs the",
  "company one salesperson-minute; a confident wrong answer costs a customer.",
  "",
  "You will be told the conversation so far. Do not re-ask anything the customer has already",
  "answered in it — that is the single fastest way to lose this deal.",
  "",
  "Reply with ONE JSON object and nothing else:",
  '{"customer_intent":string,"perceived_sentiment":string,"confidence_score":number,',
  '"action_required":"REPLY"|"GENERATE_QUOTE_AND_SEND"|"HANDOVER_TO_HUMAN",',
  '"generated_response":{"email_subject":string,"body_text":string,"whatsapp_summary":string},',
  '"next_followup_loop":{"in_hours":number,"trigger_condition":string}|null,',
  '"seats_discussed":number|null}',
  "",
  "body_text is the email body, plain text, signed off with the sender name given to you.",
  "whatsapp_summary is the SAME message in at most 600 characters, no salutation block.",
].join("\n");

/* ── Prompt assembly ─────────────────────────────────────────────────────── */

function rupees(n: number): string {
  return `Rs ${n.toLocaleString("en-IN")}`;
}

/**
 * Build the user half of the prompt: who this is, what they said, what we sell.
 *
 * The catalogue is rendered per-seat-per-YEAR because that is the unit the annual commitment
 * is sold in and the unit `items.msrp` holds. Handing the model a monthly figure and asking
 * it to multiply would be handing it arithmetic, which it is explicitly not trusted with.
 */
export function buildSalesAgentPrompt(args: BuildPromptArgs): BuiltPrompt {
  const { lead, catalog, incoming, sellerName, sellerEmail } = args;

  const history = args.history.slice(-MAX_CONTEXT_TURNS);

  const catalogueLines = catalog.map(
    (c) =>
      `- ${c.name} (${c.vendor}) — customer pays ${rupees(c.msrpPerSeatPerYear)} per seat per year` +
      ` [our cost ${rupees(c.wholesalePerSeatPerYear)} — INTERNAL, never state]`,
  );

  const transcript =
    history.length === 0
      ? "(this is their first message)"
      : history
          .map((t) => {
            const who =
              t.role === "user" ? "CUSTOMER" : t.role === "agent" ? "US" : "NOTE";
            return `${who} (${t.channel}): ${t.content}`;
          })
          .join("\n\n");

  const known = [
    `Company: ${lead.company || "(not given)"}`,
    `Contact: ${lead.contactName || "(not given)"}`,
    `Seats mentioned so far: ${lead.seats === null ? "(not given)" : String(lead.seats)}`,
    `Product mentioned so far: ${lead.plan || "(not given)"}`,
    `Reply channel: ${lead.channel}`,
    lead.existingQuoteId
      ? `A quotation ALREADY exists on this lead (${lead.existingQuoteId}). Do not create a second one — refer to it.`
      : "No quotation has been sent yet.",
  ].join("\n");

  const user = [
    `SELLER: ${sellerName}, signing as ${sellerEmail}`,
    "",
    "WHAT WE KNOW ABOUT THIS LEAD",
    known,
    "",
    "CATALOGUE (the only prices you may use)",
    catalogueLines.length > 0 ? catalogueLines.join("\n") : "(empty — you may not name any price)",
    "",
    "CONVERSATION SO FAR (oldest first)",
    transcript,
    "",
    "THEIR NEW MESSAGE",
    incoming.trim(),
  ].join("\n");

  return {
    system: SALES_AGENT_SYSTEM_PROMPT,
    user,
    // Retail only — see BuiltPrompt.allowedMoney.
    allowedMoney: catalog.map((c) => c.msrpPerSeatPerYear),
  };
}

/* ── Validating what came back ───────────────────────────────────────────── */

/**
 * The schema is strict on the two fields that drive behaviour and forgiving on the two that
 * are only ever read by a person.
 *
 * `confidence_score` is clamped rather than rejected: a model that answers 1.2 has still told
 * us "very sure", and throwing that answer away would replace a usable signal with a retry.
 * `in_hours` is bounded at both ends for a harder reason — an unbounded value from the model
 * is a scheduling primitive under its control, and "follow up in 100000 hours" is a silently
 * dropped lead while "in 0 hours" is a nudge that arrives before the reply it follows.
 */
export const SALES_AGENT_SCHEMA = z.object({
  customer_intent: z.string().trim().min(1).max(300),
  perceived_sentiment: z.string().trim().min(1).max(120),
  confidence_score: z.coerce.number().finite().transform((n) => Math.min(1, Math.max(0, n))),
  action_required: z.enum(["REPLY", "GENERATE_QUOTE_AND_SEND", "HANDOVER_TO_HUMAN"]),
  generated_response: z.object({
    email_subject: z.string().trim().min(1).max(200),
    body_text: z.string().trim().min(1).max(8000),
    whatsapp_summary: z.string().trim().min(1).max(1200),
  }),
  next_followup_loop: z
    .object({
      in_hours: z.coerce.number().int().min(1).max(720),
      trigger_condition: z.string().trim().min(1).max(300),
    })
    .nullable()
    .default(null),
  seats_discussed: z.coerce.number().int().min(1).max(1_000_000).nullable().default(null),
});

export type ParseResult =
  | { ok: true; decision: SalesAgentDecision }
  | { ok: false; reason: string };

/**
 * Turn whatever the model returned into a decision, or say why not.
 *
 * `reason` is a sentence, not a code, and it is the whole point of returning a result object
 * instead of throwing: this string ends up in the audit log and on the lead's timeline, where
 * "the model replied with no body text" is actionable and "validation failed" is not.
 */
export function parseSalesAgentDecision(raw: unknown): ParseResult {
  const parsed = SALES_AGENT_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join(".") || "the response";
    return { ok: false, reason: `The AI's answer was not usable: ${where} — ${first?.message ?? "unknown problem"}.` };
  }
  return { ok: true, decision: parsed.data };
}

/* ── The rules that can overrule the model ───────────────────────────────── */

export interface HandoverInput {
  decision: SalesAgentDecision;
  /**
   * Seats as we understand them — the lead's own figure, or the model's read when the lead
   * has none. Passed in rather than taken from the decision so the caller decides which
   * source it trusts.
   */
  seats: number | null;
  /** Retail figures the prompt authorised, for the money guard. */
  allowedMoney: readonly number[];
}

export interface HandoverResult {
  decision: SalesAgentDecision;
  /** True when this function changed the action the model asked for. */
  overruled: boolean;
  /** One sentence for the operator and the log. Empty when nothing was overruled. */
  reason: string;
}

/**
 * Apply the rules the model does not get a vote on.
 *
 * ─── IT CAN ONLY EVER MAKE THE ACTION STRICTER ──────────────────────────────
 * REPLY and GENERATE_QUOTE_AND_SEND can become HANDOVER_TO_HUMAN. Nothing here can turn a
 * handover back into a send. That direction is deliberate and worth stating because the
 * opposite is the easy bug: a later rule that "recovers" a handover because some other check
 * passed would quietly undo the model's own decision to be careful, which is the one
 * judgement it is best placed to make.
 *
 * ─── WHY THE MONEY GUARD RUNS HERE AND NOT AT SEND TIME ─────────────────────
 * A draft carrying an unauthorised rupee figure must never become a held draft that a tired
 * operator taps "send" on. Catching it at decision time means the wrong number is never
 * written into anything anybody can approve.
 */
export function applyHandoverRules(input: HandoverInput): HandoverResult {
  const { decision, seats, allowedMoney } = input;

  const handover = (reason: string): HandoverResult => ({
    decision: {
      ...decision,
      action_required: "HANDOVER_TO_HUMAN",
      // A handover schedules no nudge. The lead is a person's problem now, and an automated
      // follow-up landing on top of a human conversation is worse than no follow-up.
      next_followup_loop: null,
    },
    overruled: true,
    reason,
  });

  if (decision.action_required === "HANDOVER_TO_HUMAN") {
    return { decision, overruled: false, reason: "" };
  }

  const effectiveSeats = seats ?? decision.seats_discussed;
  if (effectiveSeats !== null && effectiveSeats > HANDOVER_SEAT_CEILING) {
    return handover(
      `${effectiveSeats} seats is above the ${HANDOVER_SEAT_CEILING}-seat ceiling for automatic quoting — the discount conversation on a deal this size is a person's job.`,
    );
  }

  if (decision.confidence_score < MIN_AUTONOMOUS_CONFIDENCE) {
    return handover(
      `The AI rated its own understanding ${decision.confidence_score.toFixed(2)}, below the ${MIN_AUTONOMOUS_CONFIDENCE} needed to answer a customer unattended.`,
    );
  }

  // Both customer-visible surfaces are checked. The WhatsApp summary is a separate piece of
  // text the model wrote separately, so a figure can be right in one and wrong in the other.
  for (const [label, text] of [
    ["email", decision.generated_response.body_text],
    ["WhatsApp summary", decision.generated_response.whatsapp_summary],
  ] as const) {
    const money = verifyDraftMoney(text, allowedMoney);
    if (!money.ok) {
      return handover(
        `The draft's ${label} names a price we did not authorise (${money.violations.join(", ")}) — every figure must come from the catalogue.`,
      );
    }
  }

  /* ─── Promise check, MINUS two of its five rules, and the reason matters ───
     findPromises was built for the acknowledgement path, where the safe answer promises
     NOTHING — so it runs verifyDraftMoney with an EMPTY allow-list and flags every currency
     figure, plus every percentage.

     Applied unchanged to a sales draft, it would fire on literally every useful reply: a
     quotation email states a price (authorised, and already checked against the catalogue
     three lines up) and says "18% GST" (a statutory rate, not a concession). The agent would
     hand over 100% of the time and the feature would be dead on arrival — which is exactly
     the "guard that gets switched off within a week" that money-guard.ts warns about.

     So the money and percent rules are dropped HERE, deliberately and narrowly, because
     something stricter already covers money on this path. The three that survive are the ones
     no authorised price list can excuse: a DATE we would have to meet, a DISCOUNT nobody
     approved, and a GUARANTEE we never gave. */
  const RELEVANT_PROMISE_KINDS = new Set(["date", "discount", "guarantee"]);
  const promises = findPromises(decision.generated_response.body_text).findings.filter((f) =>
    RELEVANT_PROMISE_KINDS.has(f.kind),
  );
  if (promises.length > 0) {
    const what = promises.map((f) => `"${f.matched}"`).slice(0, 3).join("; ");
    return handover(
      `The draft commits us to something nobody authorised — it says ${what}. A promise in our name needs a person behind it.`,
    );
  }

  return { decision, overruled: false, reason: "" };
}

/**
 * Should this decision actually produce a quotation?
 *
 * Separate from the action so the reason survives into the log: "the model asked for a quote
 * but did not have a seat count" is a different operational fact from "the model chose to
 * reply".
 */
export function quoteIsWarranted(decision: SalesAgentDecision, seats: number | null): boolean {
  if (decision.action_required !== "GENERATE_QUOTE_AND_SEND") return false;
  const effective = seats ?? decision.seats_discussed;
  return effective !== null && effective > 0 && effective <= HANDOVER_SEAT_CEILING;
}
