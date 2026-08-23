/**
 * What the model is allowed to know when drafting a reply to a customer.
 *
 * ─── WHY THIS IS A MODULE AND NOT A PROMPT STRING IN A ROUTE ─────────────────
 * Asked for on 23 Aug 2026: "me chahta hu ai human ki tarah reply de jaise ek real sales
 * person ko ki enquiry ka reply dena chahiye vaise hi reply de." A real salesperson's
 * reply is good because of what they KNOW — the thread, the seat count, whether a quote
 * already went out — not because of how they write. So the interesting part is assembling
 * the facts, and that part is testable. The wording is the model's job.
 *
 * ─── EVERY LESSON FROM TODAY LANDS HERE ─────────────────────────────────────
 *  - **The quoted thread is stripped from every message** (L29). A reply carries our own
 *    previous message underneath it, containing the very figures under discussion. Handing
 *    the raw body to a model is handing it our words as if the customer had said them —
 *    the exact mistake that produced "50 users of Starter" three times.
 *  - **Figures come from the database, never the model** (`allowedAmounts`, checked by
 *    `verifyDraftMoney`). A fluent reply quoting a price nobody agreed is the worst thing
 *    this feature can produce, and it is also the easiest.
 *  - **Stale stored facts are withheld rather than stated** (L22, L30). If the customer has
 *    written more than once, `leads.seats` and `leads.plan` may be a snapshot of the first
 *    enquiry, so they are marked UNCONFIRMED instead of being handed over as truth.
 *  - **The newest inbound message is the thing being answered.** Named explicitly, because
 *    a model given a thread will otherwise summarise it.
 *
 * ─── AND IT DESCRIBES, IT DOES NOT DECIDE ───────────────────────────────────
 * Pure: no model call, no database, no send. It returns the text a prompt should carry and
 * the figures a guard should allow. Whether to send anything is the caller's problem, and
 * the answer is "not without a human" until an operator turns that on.
 */
import { stripQuoted } from "@/lib/inbound/strip-quoted";
import { rupee } from "@/lib/utils";

export interface ThreadTurn {
  direction: "inbound" | "outbound";
  /** ISO instant. Used for ordering only — the model is given position, not timestamps. */
  at: string | null;
  body: string | null;
}

export interface ReplyFacts {
  /** The tenant's own name, for the sign-off. Never a hardcoded company (L20). */
  sellerName: string | null;
  customerName: string | null;
  /** From the lead row. May be a snapshot of the FIRST enquiry — see `factsUnconfirmed`. */
  seats: number | null;
  plan: string | null;
  /**
   * True when the customer has written more than once, so the stored seats/plan may have
   * been overtaken. Comes from `factsSuperseded` in lib/leads/email-thread.ts.
   */
  factsUnconfirmed: boolean;
  /**
   * A quote already sent for this lead, if any — id and gross amount in whole rupees.
   * Lets the reply refer to "the quotation I sent" instead of promising a new one.
   */
  quote?: { id: string; amount: number } | null;
}

export interface ReplyContext {
  /** Dropped straight into the prompt. Plain text, no markup. */
  contextText: string;
  /**
   * Every rupee figure the model is permitted to write, for `verifyDraftMoney`.
   * Empty means it may write no figures at all, which is the correct default.
   */
  allowedAmounts: number[];
  /** The message being answered, already stripped. Empty when there is nothing to answer. */
  latestInbound: string;
  /** Why no draft is possible, or null. Checked before the model is called at all. */
  blocked: string | null;
}

/** How many turns of history to include. */
const MAX_TURNS = 8;

export function buildReplyContext(args: {
  thread: readonly ThreadTurn[];
  facts: ReplyFacts;
}): ReplyContext {
  const { facts } = args;

  /* Stripped FIRST, and per message. A thread of eight replies contains seven copies of
     the conversation; without this the model reads the same sentence eight times and
     weights it accordingly. */
  const turns = args.thread
    .map((t) => ({ direction: t.direction, text: stripQuoted(t.body).text }))
    .filter((t) => t.text.length > 0);

  const inbound = turns.filter((t) => t.direction === "inbound");
  const latestInbound = inbound.length > 0 ? inbound[inbound.length - 1].text : "";

  if (!latestInbound) {
    /* Nothing from the customer that is not a quote of us. Drafting a "reply" to our own
       message is how an AI feature starts talking to itself. */
    return {
      contextText: "",
      allowedAmounts: [],
      latestInbound: "",
      blocked: "There is no message from the customer to reply to — the thread has nothing but our own mail.",
    };
  }

  const lines: string[] = [];

  lines.push(`You are replying on behalf of ${facts.sellerName?.trim() || "this reseller"}.`);
  if (facts.customerName?.trim()) lines.push(`The customer is ${facts.customerName.trim()}.`);

  /* The requirement. Stated as CONFIRMED or UNCONFIRMED, never just stated — three
     attempts at this bug were spent restating a snapshot as though it were current. */
  const req: string[] = [];
  if (facts.seats) req.push(`${facts.seats} users`);
  if (facts.plan?.trim()) req.push(facts.plan.trim());
  if (req.length > 0) {
    lines.push(
      facts.factsUnconfirmed
        ? `On record: ${req.join(" of ")} — but the customer has written more than once, so this may be OUT OF DATE. Do NOT state these figures back to them. Ask, or answer without naming numbers.`
        : `On record, confirmed: ${req.join(" of ")}. You may refer to this.`,
    );
  } else {
    lines.push("No seat count or product is on record yet. Do not invent either.");
  }

  const allowed: number[] = [];
  if (facts.quote && facts.quote.amount > 0) {
    lines.push(`A quotation has already been sent: ${facts.quote.id}, total ${rupee(facts.quote.amount)}. Refer to it rather than promising a new one, unless they asked for a change.`);
    allowed.push(Math.round(facts.quote.amount));
  } else {
    lines.push("No quotation has been sent yet.");
  }

  /* The instruction that matters most, and it is repeated because a model given a
     conversation about prices will produce a price. */
  lines.push(
    allowed.length > 0
      ? `The ONLY rupee figure you may write is ${rupee(allowed[0])}. Any other amount, discount or per-seat rate is forbidden — say you will send the revised quotation instead.`
      : "You may NOT write any rupee figure, discount or per-seat rate. If they asked about price, say the quotation is being prepared.",
  );

  lines.push("");
  lines.push(`CONVERSATION (oldest first, last ${MAX_TURNS} turns):`);
  for (const t of turns.slice(-MAX_TURNS)) {
    lines.push(`${t.direction === "inbound" ? "CUSTOMER" : "US"}: ${t.text}`);
  }

  lines.push("");
  lines.push("ANSWER THIS, their most recent message:");
  lines.push(latestInbound);

  return {
    contextText: lines.join("\n"),
    allowedAmounts: allowed,
    latestInbound,
    blocked: null,
  };
}

/**
 * The system instruction — how a salesperson writes, separated from what they know.
 *
 * Deliberately not templated per intent. A list of canned shapes is what
 * `lib/inbound/reply-pills.ts` already is, and its whole limitation is that a template
 * restates a snapshot instead of reading the message. What a model adds is reading; the
 * rules here are the guard rails around that, not a script.
 */
export const REPLY_SYSTEM_PROMPT = [
  "You are an experienced B2B salesperson at an Indian cloud-software reseller (Google Workspace, Microsoft 365, Zoho).",
  "Write the reply this customer's last message deserves, as a person would — not a template.",
  "",
  "RULES, in order of importance:",
  "1. Answer what they actually asked, in the first line. If they corrected something, acknowledge the correction specifically.",
  "2. Never write a rupee figure, discount, per-seat rate or date that was not given to you in the context. If you need one you do not have, say you are preparing it.",
  "3. End with exactly one clear next step — the revised quotation, a call, or a question you need answered. Not two, not none.",
  "4. Short. Four to six lines. Indian business English, warm but not effusive. No bullet lists.",
  "5. Never promise a delivery time, a discount, or a technical capability that is not in the context.",
  "6. Sign off with the seller name given, nothing else. No fabricated titles, no partner claims.",
  "",
  'Return ONLY JSON: {"subject": string, "message": string}.',
].join("\n");
