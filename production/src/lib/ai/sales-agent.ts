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
 * the live catalog says **₹864 per seat per MONTH** (wholesale ₹620/month), measured 24 Aug
 * 2026. A hardcoded ₹750 would have under-quoted every Standard deal with nothing to catch it
 * — .github/workflows/money-check.yml exists because four products once shipped with defaults
 * BELOW their own vendor cost. So the catalog is read at call time and handed in as
 * `catalog`, and `allowedMoney` carries exactly those figures to the money guard.
 *
 * ─── AND READING IT AT CALL TIME WAS NOT ENOUGH ─────────────────────────────
 * This header used to describe ₹864 as a per-YEAR figure, and `loadSalesCatalog` copied the
 * column across on that belief. Reading the live value protects you from a stale number; it
 * does nothing about a wrong UNIT. Twelve times wrong, on every price, below our own cost —
 * see MONTHS_PER_YEAR for what it looked like in a real draft. The lesson the first half of
 * this comment was missing: name the unit next to the number, every time.
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
import { CUSTOM_PRICING_ABOVE, authorisedRatesForItem, discountedRate, slabFor, slabLines } from "@/lib/pricing/volume-slabs";
import { authorisedNetCostFigures, computeNetCost, netCostLines } from "@/lib/pricing/net-cost";

/**
 * Deals above this many seats are not auto-quoted, whatever the model thinks.
 *
 * ─── MOVED FROM 50 TO 100 ON 25 AUG 2026, AND THE OLD REASON IS WHY ─────────
 * This used to be 50, and the comment said: "above it the discount conversation is the deal
 * and a machine that skips it loses money that was available." That was correct — while the
 * machine had no discount to give. It now has one: a published volume rate card
 * (lib/pricing/volume-slabs.ts) that says exactly what 21–50 and 51–100 seats earn. Applying
 * a published rate is not a negotiation, so the objection stops holding at 100, where the
 * card stops and the answer really does become "it depends on what the vendor will fund".
 *
 * The 50-seat line did not disappear, it changed job. It is now REVIEW_ABOVE_SEATS: 51–100
 * seats are priced and drafted in full, and held for a person rather than sent. So the band
 * that used to produce nothing now produces a finished quote, and still nobody's money moves
 * without a human seeing it.
 */
export const HANDOVER_SEAT_CEILING = CUSTOM_PRICING_ABOVE;

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

/**
 * `items.msrp` and `items.wholesale` are ₹ per seat per **MONTH**.
 *
 * ─── THIS CONSTANT EXISTS BECAUSE THE UNIT WAS GOT WRONG HERE, LIVE ─────────
 * AGENTS.md §1 states it plainly (`Business Starter → msrp = 270` is ₹270 per seat per
 * month) and `lib/quotes/quote-from-enquiry.ts` has always honoured it: its annual line rate
 * is `msrp × 12`.
 *
 * `loadSalesCatalog` did NOT. It copied `items.msrp` straight into a field named
 * `msrpPerSeatPerYear`, so the prompt told the model "customer pays Rs 864 per seat per
 * year" for a product that costs us ₹620 per seat per MONTH — ₹7,440 a year. Every price the
 * agent stated was a twelfth of the real one, which is to say far below our own cost.
 *
 * Measured 24 Aug 2026 on a demo run: the agent's covering email said "12 seats of Google
 * Workspace Standard at Rs 864 per seat per year" while the quote it referenced by number
 * said ₹1,500/seat/year and the truth was ₹10,368. One deal, three numbers, two of them
 * below cost — and `verifyDraftMoney` APPROVED it, because its allow-list was built from the
 * same wrong figures. A money guard checking against the wrong source is not a guard.
 *
 * The conversion is a named function rather than a bare `* 12` so a test can pin it against
 * the quote path's rate for the same item. Two places computing one figure is what this
 * module's header warns about; this is that warning coming true inside the module itself.
 */
export const MONTHS_PER_YEAR = 12;

/** ₹/seat/month → ₹/seat/year. Rounded once, at the end. */
export function perSeatPerYear(perSeatPerMonth: number): number {
  return Math.round(perSeatPerMonth * MONTHS_PER_YEAR);
}

/**
 * A SKU the agent must not be shown, because quoting it would sell below cost.
 *
 * `money-check.yml` exists because four products once shipped with defaults BELOW their own
 * vendor cost — but that check runs over committed defaults, not over what the agent is
 * handed at call time. This is the same question asked at the point of use.
 *
 * A wholesale of 0 means "not recorded", not "free": it passes, because a missing cost must
 * not remove a real product from the catalogue. That is the same call `loadSalesCatalog`
 * already made about margin being context-only.
 */
export function isBelowCost(entry: { msrpPerSeatPerYear: number; wholesalePerSeatPerYear: number }): boolean {
  if (entry.wholesalePerSeatPerYear <= 0) return false;
  return entry.msrpPerSeatPerYear < entry.wholesalePerSeatPerYear;
}

/** One catalogue line, in WHOLE RUPEES, as read from `items` at call time. */
export interface SalesCatalogEntry {
  /** `items.id` — carried through so the quote line references the real SKU. */
  sku: string;
  name: string;
  vendor: string;
  /** ₹/seat/YEAR the customer pays — `items.msrp × 12`. See MONTHS_PER_YEAR. */
  msrpPerSeatPerYear: number;
  /** ₹/seat/YEAR we pay the vendor — `items.wholesale × 12`. Never shown to the customer. */
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
  /**
   * `leads.gstin`. Decides whether the input-tax-credit line may be stated AT ALL.
   *
   * Measured on production 25 Aug 2026: 16 of 28 leads have none. ITC is worth nothing to an
   * unregistered business, so this is not a nicety — see lib/pricing/net-cost.ts.
   */
  gstin?: string | null;
}

/**
 * Rupee totals the APP computed, which the agent is therefore allowed to state.
 *
 * ─── WHY THIS EXISTS, MEASURED 24 Aug 2026 ──────────────────────────────────
 * The model is not trusted with arithmetic — `sales-agent.ts`'s header says so and
 * `verifyDraftMoney` enforces it by authorising only the per-seat catalogue figures. Correct,
 * and it had a consequence nobody had hit until the unit bug was fixed: the moment the agent
 * started computing the RIGHT annual total it began handing over on every quote email.
 *
 *   "The draft's email names a price we did not authorise (Rs 1,24,416)"
 *
 * ₹1,24,416 is 12 × ₹10,368 — exactly right, and refused, because a total is arithmetic. So a
 * covering email for a quote could never be sent: the one thing it must say is the amount.
 *
 * The fix is not to let the model do arithmetic. It is for the APP to compute the totals and
 * hand them over as authorised facts — same shape as the catalogue itself. `authorisedTotalsFor`
 * derives the seats × price figure, and the caller adds a real quote's own subtotal and amount
 * when one exists. Anything the model invents beyond that list still hands over.
 */
export interface BuildPromptArgs {
  lead: SalesAgentLeadFacts;
  /** See the interface comment. Empty means the agent may state no total at all. */
  authorisedTotals?: readonly number[];
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
  /** The app-computed totals that went into allowedMoney, for the log. */
  authorisedTotals: number[];
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
  "- ALWAYS write the unit next to the figure: 'Rs 10,368 per seat per year', never 'Rs 10,368'.",
  "  A bare number is how a twelve-times error hid in this system for a whole day. If you are",
  "  about to write a price without a unit, you are about to write a number nobody can check.",
  "- NEVER multiply, add or total anything yourself. If a total is needed, use one of the",
  "  figures in AUTHORISED TOTALS exactly as given. If the total you want is not there, give",
  "  the per-seat price and the seat count and let the customer see the arithmetic — do not do",
  "  it for them.",
  "- Never invent, estimate, round, discount or 'approximately' a price. If the price for",
  "  what they asked is not in CATALOGUE, do not name a price at all — say you are checking",
  "  and set action_required to HANDOVER_TO_HUMAN.",
  "- Prices are always EXCLUDING GST. Say 'plus 18% GST' when you name one. Never state a",
  "  GST-inclusive total unless that exact figure is in AUTHORISED TOTALS.",
  "- The wholesale figures are OUR cost. They are shown to you so you understand the margin.",
  "  Never state, hint at, or compute from a wholesale figure in anything the customer reads.",
  "- Never promise a discount. Discounts are a human decision at this company.",
  "",
  "THE ONE FACT YOU MUST CHASE: MONTHLY OR ANNUAL",
  "A quotation cannot go out until the customer has said which billing term they want, because",
  "monthly and annual differ by 12x and a term we assumed is a price they can hold us to. So:",
  "- If they have named a product and a seat count but NOT the term, your reply asks for the",
  "  term and nothing else. That one question is worth more than anything else you could write.",
  "- If they have already said monthly or annual anywhere in the conversation, never ask again.",
  "",
  "WHAT TO ASK FOR, IN THIS ORDER — one thing at a time",
  "Ask for the FIRST of these that is missing, and only that one. A reply asking three",
  "questions gets one answer, usually the least useful.",
  "  1. which product",
  "  2. how many seats",
  "  3. monthly or annual",
  "",
  "WHAT YOU MAY PROMISE, because it is true of every deal here:",
  "- A proper GST tax invoice, so the customer claims 100% input tax credit.",
  "- Billing in INR to an Indian entity — no 3.5% foreign-currency card loading.",
  "- Free migration of existing mail and data.",
  "- 24/7 support from a named local team.",
  "Use AT MOST TWO of these, and only ones that answer what they actually asked. Reciting all",
  "four in every mail is what makes a real person sound like a brochure — and the customer sees",
  "the same four lines the second time you write, which is worse than saying nothing.",
  "Do not extend the list. No uptime figures, no delivery dates, no contractual terms.",
  "",
  "NEVER CLAIM SOMETHING HAPPENED THAT YOU CANNOT SEE",
  "- You cannot log into their account, change their DNS, or start a migration. Never write as",
  "  if you have.",
  "- Never say a document was 'sent' or 'attached'. You do not control the envelope. Say the",
  "  quotation has been prepared, and give its reference number if you were given one.",
  "- Never invent a reference number, a date, or a person's name.",
  "",
  "END EVERY REPLY WITH THE ONE THING YOU NEED",
  "The last line says what happens next and who does it — 'Send me the seat count and I will",
  "prepare the quotation' — never a bare 'let me know'. A message that does not say what to do",
  "next is a message somebody has to think about before answering, and they will not.",
  "The next step must carry NO DATE and NO DEADLINE of any kind — no day name, no calendar",
  "date, no hour count, no 'end of' anything. A timing word there is a promise: it is refused",
  "before it can be sent, and the whole reply is held over that one word. Say WHAT you will do",
  "and never WHEN.",
  "",
  "SIGNING OFF",
  "Sign with the SELLER'S COMPANY NAME as given to you, and a first name if you were given one.",
  "The address you are signing as may contain software or sender names — those are plumbing.",
  "Never sign as, or mention, any product or platform name that is not the seller's own company.",
  "",
  "CHOOSING action_required:",
  "- REPLY — they asked something; answer it. The default.",
  "- GENERATE_QUOTE_AND_SEND — they have told you the product, the seat count AND the term, and",
  "  a formal quotation is the natural next step. If any of the three is missing, choose REPLY",
  "  and ask for the first missing one instead.",
  "- HANDOVER_TO_HUMAN — anything you are not sure of: a price not in CATALOGUE, a legal or",
  "  contractual question, an angry customer, a request for a discount, a question about",
  "  someone else's account, or a message you do not properly understand. Choosing this is a",
  "  correct answer, not a failure.",
  "",
  /* "0 to 1", not "0-1": the hyphenated form is date-shaped and findPromises reads it as one.
     Nothing in this prompt may contain a token the guard would refuse, because anything here
     can end up echoed in a reply — see the test that scans this whole string. */
  "confidence_score is YOUR honest 0 to 1 read of how well you understood this message and how",
  "safe your reply is to send with nobody checking it. Be harsh. A low score costs the",
  "company one salesperson-minute; a confident wrong answer costs a customer.",
  "",
  "You will be told the conversation so far. Do not re-ask anything the customer has already",
  "answered in it — that is the single fastest way to lose this deal.",
  "",
  "next_followup_loop — when to come back if they go quiet. trigger_condition is written for",
  "the colleague who reads it later, and names the fact you are waiting on: 'no seat count yet',",
  "not 'follow up'. Null when the thread is finished or a person is taking over.",
  "",
  "Reply with ONE JSON object and nothing else:",
  '{"customer_intent":string,"perceived_sentiment":string,"confidence_score":number,',
  '"action_required":"REPLY"|"GENERATE_QUOTE_AND_SEND"|"HANDOVER_TO_HUMAN",',
  '"generated_response":{"email_subject":string,"body_text":string,"whatsapp_summary":string},',
  '"next_followup_loop":{"in_hours":number,"trigger_condition":string}|null,',
  '"seats_discussed":number|null}',
  "",
  "body_text is the email body, plain text. whatsapp_summary is the SAME message in at most 600",
  "characters, no salutation block — keep the price, the unit and the next step; drop the rest.",
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

  /* Computed once and used twice — the sentences go in the prompt, the figures go in
     allowedMoney. Null when there is nothing to price yet (no product or no seat count), in
     which case the block is omitted entirely rather than rendered empty. */
  const netCost = netCostFactsFor(catalog, lead, sellerName);
  const netCostBlock = netCost?.lines ?? null;

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

  const totals = args.authorisedTotals ?? [];
  const totalLines =
    totals.length === 0
      ? "(none — you may not state a total or a multiplied figure, only the per-seat prices above)"
      : totals.map((t) => `- ${rupees(t)}`).join("\n");

  const user = [
    `SELLER: ${sellerName}, signing as ${sellerEmail}`,
    "",
    "WHAT WE KNOW ABOUT THIS LEAD",
    known,
    "",
    "CATALOGUE (the only prices you may use)",
    catalogueLines.length > 0 ? catalogueLines.join("\n") : "(empty — you may not name any price)",
    "",
    /* The rate card, rendered from lib/pricing/volume-slabs.ts rather than written here, so
       the model can never be shown a slab the quote path does not apply. Same rule the
       telecaller's price block follows, and the same reason the catalogue is read at call
       time instead of pasted: a second copy of a money rule stops matching the first. */
    "VOLUME RATE CARD (the ONLY discounts you may offer — the quote applies these itself)",
    slabLines().join("\n"),
    "You do not decide a discount; you read it off this table by seat count. Never invent a",
    "percentage, never round one up, and never offer a discount to win an argument.",
    "",
    "AUTHORISED TOTALS (already worked out for you — state these, never your own arithmetic)",
    totalLines,
    "",
    /* The net-cost block. Finished SENTENCES, not figures for the model to assemble — the same
       discipline as the totals above, and for a sharper reason: the brief for this asked the
       agent to compare us with buying direct from Google, quote a 3.5% card fee and price a
       free migration at ₹15,000. Those are claims about a competitor's tax treatment, about
       the customer's own bank, and about a product with no SKU. See lib/pricing/net-cost.ts.
       The model gets what our own invoice says and nothing else. */
    ...(netCostBlock
      ? [
          "WHAT THIS COSTS THEM, NET (state these sentences as written, or not at all)",
          netCostBlock.join("\n"),
          "Do NOT compare this with buying direct from any vendor, do NOT state what a card or",
          "bank charges, and do NOT put a rupee value on anything we include for free. You do",
          "not know their bank, their vendor's invoicing entity, or what migration is worth.",
        ]
      : []),
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
    // Retail per-seat figures PLUS the app-computed totals — see BuiltPrompt.allowedMoney
    // and BuildPromptArgs.authorisedTotals. Wholesale is deliberately absent from both.
    /* List rate AND every rate the volume card can produce for that item, from
       `authorisedRatesForItem` — the same function the quote path prices through.

       Both directions matter and both have burned this file before. A discounted rate the
       agent quotes CORRECTLY must not be flagged as unauthorised (that would hand over every
       21+ seat deal). And a rate the quote could never produce must not be authorised — 24 Aug
       is the whole reason: the guard's list was built from a different source than the draft
       and approved a below-cost figure. One function, both lists. */
    allowedMoney: [
      ...catalog.flatMap((c) =>
        authorisedRatesForItem(c.msrpPerSeatPerYear, c.wholesalePerSeatPerYear),
      ),
      ...totals,
      /* The net-cost figures, from the SAME computation that wrote the sentences above. A
         guard that flagged the payable amount it had just told the agent to state would hand
         over every quote that mentioned it. */
      ...(netCost?.figures ?? []),
    ],
    authorisedTotals: [...totals],
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
 * Hide the two claims THIS FILE'S OWN PROMPT authorises, before the promise check reads them.
 *
 * ─── MEASURED ON THE FIRST REAL MESSAGE THIS AGENT EVER SAW, 24 Aug 2026 ────
 * A probe enquiry went through the live webhook. The agent read it correctly — intent right,
 * confidence 0.95 — wrote a good reply, and then its own guard refused to send it:
 *
 *   reply.send / held — 'The draft commits us to something nobody authorised — it says
 *   "24/7"; "free". A promise in our name needs a person behind it.'
 *
 * Both of those are things `SALES_AGENT_SYSTEM_PROMPT` explicitly tells it it MAY say:
 * "24/7 support from a named local team" and "Free migration of existing mail and data".
 * So the prompt authorised two phrases and the guard refused them — meaning every reply that
 * used the company's actual selling points handed over, which is close to every first reply.
 * The machinery was alive and the feature was practically dead.
 *
 * Why `findPromises` fires: `24/7` matches its DATE branch `\d{1,2}[/-]\d{1,2}` — it reads as
 * 24 July — and bare `free` matches its DISCOUNT branch, which is correct for "first month
 * free" and wrong here. Neither pattern is broken; they were written for the acknowledgement
 * path, where the safe reply promises NOTHING at all.
 *
 * ─── WHY MASK TWO PHRASES RATHER THAN DROP THE RULES ────────────────────────
 * Dropping `date` would let "we'll migrate everything by Friday" through, and dropping
 * `discount` would let "the first month is free" through. Those are the two the rule exists
 * for. So the exemption is exactly as wide as the prompt's own promise list and no wider:
 *
 *   · `24/7` (and 24x7) → always, because in a sales reply it never means a date
 *   · `free`            → ONLY inside a sentence that is also about migration
 *
 * The second condition is the important half. "Migration is free" is the authorised claim;
 * "the first month is free" in any other sentence is still caught, and there is a test
 * pinning that boundary. Same shape as `support-agent.ts`'s maskSupportIdioms, which exists
 * for the same reason on the support side.
 */
export function maskAuthorisedSellingPoints(text: string): string {
  /* Round-the-clock support. `24 x 7` and `24*7` included because a model writes all three. */
  let out = text.replace(/\b24\s*[/x*]\s*7\b/gi, "round-the-clock");

  /* Sentence by sentence, so "free" is exempt only where migration is the subject. Splitting
     on the punctuation KEEPS it (lookbehind), so re-joining reproduces the text exactly —
     a mask that reflows the body would change what the promise check reads elsewhere. */
  out = out
    .split(/(?<=[.!?\n])/)
    .map((sentence) =>
      /\bmigrat/i.test(sentence) ? sentence.replace(/\bfree\b/gi, "included") : sentence,
    )
    .join("");

  return out;
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
  const promises = findPromises(
    /* The prompt's own promise list, hidden from the check that would refuse it. Measured on
       the first live message: without this, "24/7" and "free migration" handed over every
       reply. See maskAuthorisedSellingPoints. */
    maskAuthorisedSellingPoints(decision.generated_response.body_text),
  ).findings.filter((f) => RELEVANT_PROMISE_KINDS.has(f.kind));
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

/* ── The totals the app works out for the agent ───────────────────────────── */

/**
 * The one total the agent may state before any quote exists: seats × the catalogue price.
 *
 * PURE, and it does the arithmetic the model is not trusted with — that is the whole point.
 * Returns empty whenever anything is missing (no seats, no product, product not in the
 * catalogue), because an empty authorised list means "state no total", which is the strict
 * direction.
 *
 * Exact name match against the catalogue, no fuzzy matching — the same rule
 * `quote-dispatcher.ts`'s `resolveItem` follows, and for the same reason: a near-miss here
 * would authorise a figure computed from the WRONG product's price, which is worse than
 * authorising nothing.
 */
export function authorisedTotalsFor(
  catalog: readonly SalesCatalogEntry[],
  lead: { plan: string | null; seats: number | null },
): number[] {
  if (!lead.plan || lead.seats === null || lead.seats <= 0) return [];
  const item = catalog.find((c) => c.name === lead.plan);
  if (!item) return [];
  return [item.msrpPerSeatPerYear * lead.seats];
}

/**
 * What this lead would actually pay, and what they could reclaim of it.
 *
 * ─── ONE COMPUTATION, THREE CONSUMERS ───────────────────────────────────────
 * The sentences the agent may state, the figures the money guard authorises, and the
 * arithmetic behind both come from here. Building the allow-list separately from the prose is
 * how 24 Aug happened: the guard measured a draft against numbers from a different source and
 * approved one below our own cost.
 *
 * The seat count and product come off the LEAD, the rate comes off the catalogue read at call
 * time, and the discount comes off the volume rate card. So the net-cost block cannot disagree
 * with the quote the same lead would produce — they are the same three inputs.
 *
 * Returns null when there is nothing to price yet: no product, no seat count, or a product
 * that is not in this tenant's catalogue. A "net cost" for a deal whose shape nobody knows
 * would be a confident number about nothing.
 */
export function netCostFactsFor(
  catalog: readonly SalesCatalogEntry[],
  lead: { plan: string | null; seats: number | null; gstin?: string | null },
  sellerName: string,
): { lines: string[]; figures: number[] } | null {
  if (!lead.plan || lead.seats === null || lead.seats <= 0) return null;
  const item = catalog.find((c) => c.name === lead.plan);
  if (!item) return null;

  const slab = slabFor(lead.seats);
  const priced =
    slab.kind === "slab"
      ? discountedRate(item.msrpPerSeatPerYear, slab.slab.percent, item.wholesalePerSeatPerYear)
      : { appliedPercent: 0 };

  const net = computeNetCost({
    subtotal: item.msrpPerSeatPerYear * lead.seats,
    discountPct: priced.appliedPercent,
    /* 18% — SaaS under HSN 998313 (CLAUDE.md §13), the same rate the quote writes. */
    taxRate: 18,
    buyerGstin: lead.gstin,
  });

  return { lines: netCostLines(net, sellerName), figures: authorisedNetCostFigures(net) };
}
