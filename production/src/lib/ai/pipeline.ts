/**
 * Three specialists instead of one prompt carrying everything.
 *
 * The brief for this was a network of subagents: a qualifier, a pricing specialist, and a
 * closer. Two of those three are the right idea and are built here. THE MIDDLE ONE IS NOT A
 * MODEL, and that is not a shortcut — it is the reason the rest of this file is safe to add.
 *
 * ─── WHY ONE PROMPT WAS THE WRONG SHAPE (measured, not felt) ─────────────────
 * `buildSalesAgentPrompt` currently hands the model 11,194 characters containing TEN money
 * figures, and asks it to do six things at once: read the intent, decide whether we know
 * enough to quote, handle an objection, pick which claims to make, choose an action, and write
 * both an email and a WhatsApp version of it. Five of those are judgement and one is prose,
 * and prose is the one that always gets done well. The judgement is what gets crowded out.
 *
 * The specific cost, and the thing this file fixes: the stage that decides "do we know enough
 * to price this?" does not need a single price to do its job — and today it is holding ten of
 * them while it works. `allowedMoney` exists precisely because the one prompt must carry them.
 *
 * ─── WHAT EACH STAGE MAY SEE ────────────────────────────────────────────────
 *   1. QUALIFY   model.  The conversation. NO prices, NO catalogue, no ability to write to the
 *                        customer at all. Reports facts and what is missing.
 *   2. PRICE     CODE.   The catalogue, the rate card, the cost floor, the document series.
 *                        No model anywhere near it. See the block below.
 *   3. CLOSE     model.  The conversation, the figures stage 2 computed, and the battlecards.
 *                        Writes the message. May state only what stage 2 authorised.
 *
 * ─── STAGE 2 IS CODE, AND A TEST HOLDS IT THERE ─────────────────────────────
 * "Margin check karke official GST quote generate karta hai" is the one job in this pipeline
 * that must never be given to a language model. A quotation is a document a customer can hold
 * us to and a GST series is a legal record under CGST Rule 46, so the whole of this repo's
 * money discipline exists to keep the arithmetic out of the model's hands:
 *
 *   · prices come from the catalogue, never from the prompt    (SALES_AGENT_SYSTEM_PROMPT)
 *   · totals are computed by the app                           (authorisedTotalsFor)
 *   · discounts are percentages off a rate card                (lib/pricing/volume-slabs)
 *   · nothing may be sold below our own cost                   (isBelowCost, discountedRate)
 *   · every number in a draft is checked against an allow-list (verifyDraftMoney)
 *   · document numbers come from one Postgres allocator        (next_document_number)
 *
 * A "pricing agent" undoes all six at once. Worse, it undoes them invisibly: a model that
 * writes a per-month rate onto a per-year line produces a document that looks exactly like a
 * correct one. `pipeline.test.ts` fails with that reason attached if anybody ever changes
 * `kind` on the price stage, because the next person to read this brief will have the same
 * good idea and deserves to meet the argument rather than the bug.
 *
 * ─── THE ASYMMETRY THAT MAKES A MODEL-DRIVEN GATE SAFE ──────────────────────
 * Stage 1's verdict is BINDING on stage 3, but only in one direction: it can stop a quote and
 * it can call for a human. It can never authorise a quote, and it can never take a handover
 * back. So the worst a confused qualifier can do is make the agent more cautious than it
 * needed to be, which costs a salesperson a minute. `narrowByQualification` enforces that with
 * a rank, and a test walks every combination.
 */
import { z } from "zod";

/* ── The stage contract ───────────────────────────────────────────────────── */

export type StageKind = "model" | "code";
export type StageId = "qualify" | "price" | "close";

export interface SalesStage {
  readonly id: StageId;
  /** What a person would call this specialist. */
  readonly title: string;
  readonly kind: StageKind;
  /** What this stage is given. Documentation, and the basis of the money assertion below. */
  readonly sees: readonly string[];
  /**
   * Whether a price may appear in this stage's input AT ALL.
   *
   * False for `qualify` is the concrete win of splitting the prompt: a stage that cannot see a
   * price cannot leak one, cannot compute with one, and cannot be talked into naming one.
   */
  readonly maySeePrices: boolean;
  /** Why it is this kind. Read out loud by the guard test when the price stage changes. */
  readonly why: string;
}

export const SALES_STAGES: readonly SalesStage[] = [
  {
    id: "qualify",
    title: "SDR and lead qualifier",
    kind: "model",
    sees: ["the conversation so far", "the newest message", "what the lead row already records"],
    maySeePrices: false,
    why:
      "Reading what somebody asked for is a language job, and it is the one stage where a " +
      "mistake is cheap: the worst outcome is asking a question we did not need to ask.",
  },
  {
    id: "price",
    title: "Quote and pricing specialist",
    kind: "code",
    sees: ["the catalogue", "the volume rate card", "our wholesale cost", "the document series"],
    maySeePrices: true,
    why:
      "A quotation is a document the customer can hold us to and the GST series is a legal " +
      "record under CGST Rule 46. Arithmetic here is deterministic, testable and auditable; a " +
      "model's arithmetic is none of those, and a wrong total looks exactly like a right one.",
  },
  {
    id: "close",
    title: "Deal closer and payment agent",
    kind: "model",
    sees: ["the conversation", "the figures stage 2 computed", "the objection battlecards"],
    maySeePrices: true,
    why:
      "Answering an objection in the customer's own register is a language job. It may state " +
      "only figures stage 2 authorised, which verifyDraftMoney checks after the fact.",
  },
] as const;

export function stage(id: StageId): SalesStage {
  const found = SALES_STAGES.find((s) => s.id === id);
  /* Not reachable through the type, but this is the one place other modules look a stage up by
     name, so it fails loudly rather than returning undefined into a guard. */
  if (!found) throw new Error(`unknown sales stage: ${id}`);
  return found;
}

/* ── Stage 1: the qualifier ───────────────────────────────────────────────── */

/**
 * The three things a quotation cannot go out without, in the order they should be asked for.
 *
 * Order matters more than it looks. A reply asking three questions gets one answer, usually
 * the least useful one — so the responder asks for the FIRST thing missing and nothing else.
 */
export const REQUIRED_FACTS = ["product", "seats", "term"] as const;
export type RequiredFact = (typeof REQUIRED_FACTS)[number];

/**
 * The qualifier's prompt. Deliberately short, and deliberately penniless.
 *
 * No catalogue, no prices, no seller claims, no instruction to write anything a customer will
 * read. It reports; it does not speak. A test asserts this string contains no money at all,
 * because the moment a price appears here the stage stops being safe by construction and
 * starts being safe by good behaviour.
 */
export const QUALIFIER_SYSTEM_PROMPT = [
  "You are the qualifier for an Indian cloud-solutions reseller's inside-sales desk. A",
  "colleague will answer this customer; your only job is to tell them what we actually know.",
  "",
  "YOU DO NOT WRITE TO THE CUSTOMER. You produce facts, not sentences. Nothing you output is",
  "shown to anybody outside this company.",
  "",
  "YOU HAVE NO PRICES AND YOU NEVER NAME ONE. Not a rate, not a total, not an estimate, not a",
  "discount, not 'around' anything. If the customer asked what it costs, that is a fact to",
  "report — 'they asked for pricing' — never a fact to answer. Pricing is done elsewhere by",
  "the application itself, from a rate card you cannot see.",
  "",
  "THE THREE FACTS THAT MATTER, because a quotation cannot be built without them:",
  "  product — which service, as close to how THEY named it as possible",
  "  seats   — how many people it is for",
  "  term    — monthly or annual",
  "",
  "TERM IS THE ONE PEOPLE FORGET. Monthly and annual differ by twelve times, so a term we",
  "assumed is a price the customer can hold us to. If they have not said which, term is null,",
  "however obvious it feels from the rest of the message.",
  "",
  "seats_source — THE FIELD TO BE STRICT ABOUT:",
  "  written  — they gave a number. 'we need 30 licences', '30 users', 'for 30 staff'.",
  "  inferred — you worked it out. 'the whole team', 'our sales floor', 'a few people',",
  "             'same as last year'. A number you reasoned your way to goes here even when",
  "             you are confident, because a seat count nobody typed becomes a total on a",
  "             document, and the customer never agreed to it.",
  "  none     — no seat count in the conversation at all.",
  "When in doubt between written and inferred, choose inferred. It costs one question.",
  "",
  "Report a fact as known ONLY if it is in the conversation. Do not carry over what a similar",
  "customer usually wants. Do not fill a gap with the most likely answer.",
  "",
  "objection — if this message pushes back on something (a competitor is cheaper, they will",
  "buy direct, they are worried about migration, they went quiet and came back cold), say what",
  "the pushback IS in one plain phrase. Null when there is none. Do not answer it.",
  "",
  "needs_human — true when a person should take this over: a legal or contractual question, a",
  "request for a discount, an angry customer, a question about somebody else's account, or a",
  "message you do not properly understand. Choosing true is a correct answer, not a failure.",
  "",
  "confidence is your honest read, 0 to 1, of how well you understood this message. Be harsh.",
  "",
  "Reply with ONE JSON object and nothing else:",
  '{"product":string|null,"seats":number|null,"seats_source":"written"|"inferred"|"none",',
  '"term":"monthly"|"annual"|null,"intent":string,"objection":string|null,',
  '"needs_human":boolean,"confidence":number}',
].join("\n");

export const QUALIFIER_SCHEMA = z.object({
  product: z.string().trim().min(1).nullable(),
  seats: z.number().int().positive().nullable(),
  seats_source: z.enum(["written", "inferred", "none"]),
  term: z.enum(["monthly", "annual"]).nullable(),
  intent: z.string().trim().min(1),
  objection: z.string().trim().min(1).nullable(),
  needs_human: z.boolean(),
  confidence: z.number().min(0).max(1),
});

export type Qualification = z.infer<typeof QUALIFIER_SCHEMA>;

export interface QualifierTurn {
  role: "user" | "agent" | "system";
  content: string;
}

/**
 * The qualifier's half of the prompt: the conversation and the little we already know.
 *
 * `plan` and `seats` from the lead row are shown as ALREADY RECORDED rather than as truth,
 * because the qualifier's job includes noticing that the customer just corrected them — the
 * append branch of the webhook applies exactly that correction a few lines before this runs.
 */
export function qualifierUserPrompt(args: {
  company: string;
  recordedProduct: string | null;
  recordedSeats: number | null;
  history: readonly QualifierTurn[];
  incoming: string;
  maxTurns?: number;
}): string {
  const turns = args.history.slice(-(args.maxTurns ?? 12));
  const lines: string[] = [`CUSTOMER: ${args.company}`];

  lines.push(
    "",
    "ALREADY RECORDED ON THIS ENQUIRY — this is what a colleague wrote down earlier, not",
    "necessarily what is true now. If the newest message corrects it, report the correction.",
    `  product: ${args.recordedProduct ?? "nothing recorded"}`,
    `  seats: ${args.recordedSeats === null ? "nothing recorded" : String(args.recordedSeats)}`,
  );

  if (turns.length) {
    lines.push("", "CONVERSATION SO FAR, oldest first:");
    for (const t of turns) {
      const who = t.role === "user" ? "CUSTOMER" : t.role === "agent" ? "US" : "NOTE";
      lines.push(`  ${who}: ${t.content.replace(/\s+/g, " ").trim()}`);
    }
  } else {
    lines.push("", "CONVERSATION SO FAR: this is their first message.");
  }

  lines.push("", "THEIR NEWEST MESSAGE:", args.incoming.trim());
  return lines.join("\n");
}

export function parseQualification(
  raw: unknown,
): { ok: true; value: Qualification } | { ok: false; reason: string } {
  const parsed = QUALIFIER_SCHEMA.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  const first = parsed.error.issues[0];
  return {
    ok: false,
    reason: first ? `${first.path.join(".") || "root"}: ${first.message}` : "unparseable",
  };
}

/* ── Reconciling stage 1 against what we already hold ─────────────────────── */

export interface MergedQualification {
  product: string | null;
  seats: number | null;
  term: "monthly" | "annual" | null;
  /** Everything still unknown, in ask-for-this-first order. Empty means we could price. */
  missing: readonly RequiredFact[];
  /** The single thing the responder should ask for. Null when nothing is missing. */
  askFor: RequiredFact | null;
  readyToPrice: boolean;
  needsHuman: boolean;
  objection: string | null;
  /** One sentence for the operator when this blocks something. Empty when it does not. */
  blockingReason: string;
}

/**
 * What we know, taking the safer of two sources at every field.
 *
 * A recorded fact beats a read one. `leads.plan` and `leads.seats` were either typed by a
 * colleague or resolved by the dispatcher against the catalogue, and a model's re-reading of
 * the same conversation is not a reason to overwrite either. Where the lead is silent the
 * qualifier fills in — under the seat rule below.
 *
 * ─── A SEAT COUNT NOBODY TYPED MAY NOT PRICE ────────────────────────────────
 * `seats_source` must be "written" for the qualifier's own figure to count, and
 * `heardNotWritten` blocks it regardless. Those are two different doubts and both apply: the
 * first is "the model worked this number out", the second is "a machine transcribed the words
 * this number came from". Either is enough to make a total on a document something the
 * customer never agreed to, so `readyToPrice` needs both clear. See lib/voice/voice-note.ts.
 */
export function mergeQualification(
  q: Qualification,
  recorded: { plan: string | null; seats: number | null },
  opts: { heardNotWritten?: boolean } = {},
): MergedQualification {
  const product = recorded.plan?.trim() || q.product?.trim() || null;

  const qualifierSeatsUsable =
    q.seats !== null && q.seats > 0 && q.seats_source === "written" && !opts.heardNotWritten;

  const seats =
    recorded.seats !== null && recorded.seats > 0
      ? recorded.seats
      : qualifierSeatsUsable
        ? q.seats
        : null;

  const missing = REQUIRED_FACTS.filter((f) =>
    f === "product" ? !product : f === "seats" ? seats === null : !q.term,
  );

  const readyToPrice = missing.length === 0 && !q.needs_human;

  /* The reason names the FACT, not the stage. An operator reading "no seat count in writing
     yet" knows what to do; "qualifier blocked" tells them to find an engineer. */
  const blockingReason = q.needs_human
    ? "the qualifier asked for a person to take this over"
    : missing.length === 0
      ? ""
      : missing[0] === "product"
        ? "no product named yet"
        : missing[0] === "seats"
          ? q.seats !== null && !qualifierSeatsUsable
            ? opts.heardNotWritten
              ? "the seat count was heard on a voice note, not written"
              : "the seat count was worked out, not stated"
            : "no seat count yet"
          : "monthly or annual not confirmed yet";

  return {
    product,
    seats,
    term: q.term,
    missing,
    askFor: missing[0] ?? null,
    readyToPrice,
    needsHuman: q.needs_human,
    objection: q.objection,
    blockingReason,
  };
}

/* ── The one-directional gate ─────────────────────────────────────────────── */

export type AgentAction = "GENERATE_QUOTE_AND_SEND" | "REPLY" | "HANDOVER_TO_HUMAN";

/**
 * How cautious each action is. Narrowing may only ever move UP this ladder.
 *
 * This rank IS the safety property of letting one model call constrain another. Sending a
 * priced document is the least cautious thing the agent does; asking a question is safer;
 * fetching a colleague is safest. A qualifier that misreads a message can only ever push the
 * agent toward the safe end, so its worst case costs a salesperson a minute rather than
 * putting a wrong number in front of a customer.
 */
const CAUTION_RANK: Record<AgentAction, number> = {
  GENERATE_QUOTE_AND_SEND: 0,
  REPLY: 1,
  HANDOVER_TO_HUMAN: 2,
};

export interface NarrowResult {
  action: AgentAction;
  /** True when the qualifier changed what the responder asked to do. */
  narrowed: boolean;
  /** One sentence for the timeline and the log. Empty when nothing changed. */
  reason: string;
}

/**
 * `want`, unless `want` is less cautious than `asked` — in which case `asked` stands.
 *
 * ─── WHY THIS IS ITS OWN FUNCTION ───────────────────────────────────────────
 * It started as three lines inside `narrowByQualification` and a mutation test caught the
 * problem with that: deleting it entirely left all 48 tests green. Not because the tests were
 * weak, but because the branches above it never actually produce a looser result, so no input
 * could reach it. An unreachable guard whose test passes is a guard nobody has ever checked.
 *
 * It is still worth having — it is what keeps the one-directional promise true against a
 * FUTURE branch somebody adds to `narrowByQualification`, which is the whole reason this
 * module exists. So it is exported and tested on its own, where a looser input can actually
 * be handed to it.
 */
export function atLeastAsCautious(asked: AgentAction, want: AgentAction): AgentAction {
  return CAUTION_RANK[want] < CAUTION_RANK[asked] ? asked : want;
}

/**
 * Apply stage 1's verdict to stage 3's chosen action, never loosening it.
 *
 * @param asked what the responder wants to do
 * @param merged stage 1's reconciled view
 */
export function narrowByQualification(
  asked: AgentAction,
  merged: MergedQualification,
): NarrowResult {
  let want: AgentAction = asked;
  let reason = "";

  if (merged.needsHuman) {
    want = "HANDOVER_TO_HUMAN";
    reason = `Handed over — ${merged.blockingReason}.`;
  } else if (asked === "GENERATE_QUOTE_AND_SEND" && !merged.readyToPrice) {
    /* ─── WHY THIS IS A HANDOVER AND NOT A DOWNGRADE TO REPLY ─────────────────
       The obvious move is REPLY: no quote, just ask the question. It is wrong, and the reason
       is the draft rather than the action. `qualifierBriefing` already told the responder, in
       this same turn, that no quotation goes out on this message and which single fact to ask
       for. A responder that asked for GENERATE_QUOTE_AND_SEND anyway wrote its prose around a
       document — "as per the attached quotation", a total, a reference number — and sending
       that as a plain reply points the customer at a document nobody made.

       It also means the two stages disagree about the same message, and the disagreement is
       always about a fact that decides a price: the qualifier read a seat count as worked-out
       where the responder read it as stated, or saw a missing term the responder filled in.
       That is the exact ambiguity a person should settle, and it should be rare — the ordinary
       case is both stages seeing the same gap and the responder simply asking the question,
       which never reaches this branch at all. */
    want = "HANDOVER_TO_HUMAN";
    reason =
      `Handed over — ${merged.blockingReason}, but the draft was written as a quotation. ` +
      `A person should confirm the ${merged.askFor ?? "details"} before anything goes out.`;
  }

  /* The clamp, as a composed function rather than an inline branch — see its own comment for
     why. No input reaches it today; it is what holds the promise if a branch above changes. */
  const action = atLeastAsCautious(asked, want);

  return { action, narrowed: action !== asked, reason: action === asked ? "" : reason };
}

/**
 * The binding instruction stage 1 hands stage 3, as lines for its prompt.
 *
 * Phrased as facts and one instruction, not as advice. Returns an empty array when the
 * qualifier found nothing worth constraining, so the responder's prompt is unchanged in the
 * ordinary case rather than carrying an empty heading.
 */
export function qualifierBriefing(merged: MergedQualification): string[] {
  if (merged.needsHuman) {
    return [
      "THE QUALIFIER HAS ASKED FOR A PERSON",
      `Reason: ${merged.blockingReason}. Do not quote and do not promise anything.`,
      "Acknowledge their message, say a colleague is picking it up, and stop there.",
    ];
  }

  if (!merged.objection && !merged.askFor) return [];

  const lines: string[] = [
    "WHAT THE QUALIFIER ESTABLISHED (already checked — do not re-ask any of these)",
    `  product: ${merged.product ?? "not named yet"}`,
    `  seats: ${merged.seats === null ? "not confirmed in writing yet" : String(merged.seats)}`,
    `  term: ${merged.term ?? "not confirmed yet"}`,
  ];

  if (merged.objection) {
    lines.push(
      "",
      `THEY PUSHED BACK ON: ${merged.objection}`,
      "Answer that, in their own terms, before anything else.",
    );
  }

  if (merged.askFor) {
    lines.push(
      "",
      `THE ONE THING TO ASK FOR: ${merged.askFor} — ${merged.blockingReason}.`,
      "Ask for that and nothing else. A reply asking three questions gets one answer.",
      "No quotation goes out on this message; the application has already decided that.",
    );
  }

  return lines;
}
