/**
 * The AI support agent's reasoning layer — prompt in, validated decision out.
 *
 * Everything here is PURE. No Gemini call, no database, no clock: the prompt is built from
 * arguments and the model's answer is validated against a schema. `support-agent.server.ts`
 * does the fetching and the calling. The split is the same one `sales-agent.ts` uses and for
 * the same reason — what the agent is ALLOWED to tell a customer is the part that gets argued
 * about, and arguing about it should not require a network.
 *
 * ─── THE ONE RULE THIS FILE EXISTS TO ENFORCE: NO INVENTED RECORD VALUES ────
 * A sales agent's worst mistake is a wrong price: embarrassing, and a credit note fixes it.
 * A support agent's worst mistake is a wrong DNS record, and it is a different class of
 * damage — a customer who pastes a wrong MX record into their zone stops receiving mail
 * ENTIRELY, and they do it on our written instruction. The bounce backlog is silent, so they
 * find out from a customer of their own, hours later.
 *
 * A fluent model will produce MX, SPF, DKIM and DMARC values on demand, confidently, from
 * memory of the public internet. Some will be right. Vendors change them (Google moved from
 * five ASPMX hosts to a single smtp.google.com), they differ per region (Zoho India vs
 * Zoho US), and M365's is derived from the customer's own domain name. So:
 *
 *   `verifyNoInventedRecords` refuses any draft naming a concrete record value that was not
 *   handed in as authorised, and the prompt tells the agent to send the customer to the
 *   place their OWN exact values are displayed instead of reciting any.
 *
 * That is deliberately the same shape as `verifyDraftMoney` — a hardcoded table of records in
 * this file would be a second source of truth for a value we do not own, which is exactly the
 * mistake `sales-agent.ts`'s header describes for prices. We do not have a vendor-records
 * table to read from, and inventing one would be worse than admitting we have none.
 *
 * ─── WHAT THE MODEL IS AND IS NOT TRUSTED WITH ──────────────────────────────
 * Trusted: recognising which problem this is, choosing words, deciding a person is needed.
 * Not trusted: record values, prices, dates, its own confidence, or the claim that it solved
 * something. `applyEscalationRules` can overrule its chosen action but can never relax it.
 */
import { z } from "zod";
import { verifyDraftMoney } from "./money-guard";
import { findPromises } from "./promise-check";

/**
 * Below this, the agent does not answer a customer unattended.
 *
 * 0.75, higher than the sales agent's 0.7, and the difference is the point. A half-understood
 * sales enquiry produces a clumsy reply; a half-understood support request produces
 * instructions somebody follows. The failure it catches is the question the model
 * misread and answered fluently — the one a person cannot spot by skimming.
 */
export const MIN_AUTONOMOUS_CONFIDENCE = 0.75;

/** How many past turns go into the prompt. Enough to stop re-asking; short enough to stay cheap. */
export const MAX_CONTEXT_TURNS = 12;

/** How long a customer has to respond before the SLA cron closes an answered ticket. */
export const AUTO_CLOSE_AFTER_HOURS = 48;

/** How long an escalated ticket may sit with no assignee before support is alerted. */
export const UNASSIGNED_ALERT_AFTER_MINUTES = 30;

export type SupportChannel = "email" | "whatsapp" | "portal" | "app";
export type SupportTurnRole = "user" | "agent" | "system";

export type SupportAction =
  | "AUTO_REPLY_AND_RESOLVE"
  | "REQUEST_MORE_INFO"
  | "ESCALATE_TO_HUMAN";

export type SupportSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/**
 * The support topics this agent has a runbook for.
 *
 * A closed list, and narrower than `support_tickets.category` is broad. The ticket's category
 * is a five-value vocabulary the dashboard filters on; this says WHICH RUNBOOK was used, which
 * is the only field that tells a reviewer whether the agent answered a DNS question with DNS
 * knowledge or with something it made up. `other` is a real answer, and it is the one that
 * makes the agent hand over rather than improvise.
 */
export const SUPPORT_TOPICS = [
  "dns_records",
  "workspace_admin",
  "mail_client_sync",
  "password_or_access",
  "storage_quota",
  "subscription_or_seats",
  "invoice_or_billing",
  "service_outage",
  "other",
] as const;

export type SupportTopic = (typeof SUPPORT_TOPICS)[number];

/** Ticket categories that already exist in the schema (database.types.ts:3175). */
export type TicketCategory = "billing" | "tech" | "plan_change" | "feature" | "other";

/** Ticket priorities that already exist in the schema. */
export type TicketPriority = "low" | "normal" | "high" | "urgent";

export interface SupportTurn {
  role: SupportTurnRole;
  content: string;
  channel: SupportChannel;
}

/**
 * What we know about the person writing in, gathered before the model is asked anything.
 *
 * `subscriptions` is the field that makes this agent useful rather than a chatbot: "your
 * Business Standard renews on 14 Sep and you have 12 of 15 seats used" is a fact the customer
 * cannot get from a search engine, and it is the difference between answering the question and
 * describing the product.
 */
export interface SupportCustomerFacts {
  ticketId: string | null;
  customerName: string;
  /** Email address or E.164 phone number — matching `channel`. */
  customerContact: string;
  channel: SupportChannel;
  /** Null when the sender matches no customer record. Stated plainly in the prompt. */
  customerId: string | null;
  subscriptions: readonly SupportSubscriptionFact[];
  /** The support tier the ticket was stamped with, for what we may promise about response time. */
  tier: "free" | "standard" | "enterprise" | null;
}

/** One live subscription, as read from `subscriptions` at call time. Money in whole rupees. */
export interface SupportSubscriptionFact {
  plan: string;
  vendor: string;
  domain: string | null;
  seats: number;
  /** Seats actually in use at the vendor, when we have synced it. */
  used: number | null;
  status: string;
  /** ISO date. What the customer is really asking when they ask "when do I pay again". */
  renewalDate: string | null;
  /** Whole rupees per month. */
  mrr: number;
}

/**
 * A record value we are allowed to state, because somebody put it in front of us.
 *
 * Empty in every code path today, and that is the honest state: this repo has no
 * vendor-records table, so the agent may state no record values at all. The parameter exists
 * so the guard has one obvious place to accept them the day a tenant records their own
 * verified values — rather than the guard being loosened when that day comes.
 */
export interface AuthorisedRecord {
  /** e.g. "MX", "TXT", "CNAME". */
  type: string;
  /** The exact value, as verified. */
  value: string;
}

export interface BuildSupportPromptArgs {
  customer: SupportCustomerFacts;
  /** Oldest first. Trimmed to MAX_CONTEXT_TURNS by this function. */
  history: readonly SupportTurn[];
  /** The newest customer message, not yet in `history`. */
  incoming: string;
  /** The reseller's trading name, for the signature. */
  sellerName: string;
  /** The address the agent signs as, e.g. "support@anutech.in". */
  supportEmail: string;
  /** Record values the agent may state verbatim. Empty means: none. */
  authorisedRecords?: readonly AuthorisedRecord[];
}

export interface BuiltSupportPrompt {
  system: string;
  user: string;
  /**
   * Every rupee figure the agent was authorised to name — the customer's own subscription
   * figures and nothing else. A support reply that quotes a price we did not hand it is
   * either an invented number or an upsell nobody approved; both are handled the same way.
   */
  allowedMoney: number[];
  /** Record values the agent may state. See AuthorisedRecord. */
  authorisedRecords: readonly AuthorisedRecord[];
  /**
   * ISO dates already on this customer's account — renewal dates, today. The agent may state
   * these; every other date is a commitment and escalates. See maskAuthorisedDates.
   */
  allowedDates: string[];
}

export interface SupportGeneratedResponse {
  email_subject: string;
  body_text: string;
  whatsapp_summary: string;
}

export interface SupportDecision {
  issue_category: SupportTopic;
  severity_level: SupportSeverity;
  /** The model's claim that it actually has the answer. Checked against the action below. */
  resolution_found: boolean;
  action_required: SupportAction;
  confidence_score: number;
  generated_response: SupportGeneratedResponse;
  /** What the agent still needs from the customer. Null unless REQUEST_MORE_INFO. */
  missing_information: string | null;
}

/* ── The master system prompt ─────────────────────────────────────────────── */

/**
 * The knowledge base, written as PROCEDURE rather than as values.
 *
 * Every entry answers "what do we ask, and where do we send them" and none of them answers
 * "what is the record". That is the whole design — see the file header. A runbook that says
 * "Admin console → Domains → Activate Gmail shows the exact MX records for your domain" is
 * correct forever and cannot break a customer's mail; a runbook containing an MX host is
 * correct until the vendor changes it and nobody here finds out.
 */
export const SUPPORT_KNOWLEDGE_BASE = [
  "DNS AND MAIL DELIVERY (MX, SPF, DKIM, DMARC)",
  "- Establish the domain, the registrar or DNS host, and which vendor's mail they are moving",
  "  to. Without all three you cannot help and must ask.",
  "- NEVER state an MX host, an SPF include, a DKIM key or a DMARC policy string yourself.",
  "  Send them to where their OWN values are displayed:",
  "    Google Workspace — Admin console → Account → Domains → Manage domains → Activate Gmail",
  "    Microsoft 365    — Microsoft 365 admin centre → Settings → Domains → select the domain",
  "    Zoho Mail        — Zoho Mail Admin Console → Domains → the domain → DNS/Email Configuration",
  "  Those screens show the exact records for THAT domain and region. Anything you recite from",
  "  memory may be stale or for the wrong region, and a wrong MX record stops their mail",
  "  completely.",
  "- Useful things you MAY say: DNS changes can take up to 48 hours to propagate; only ONE",
  "  SPF TXT record may exist per domain (two is the most common cause of failures, and the",
  "  fix is to merge them); DKIM must be generated in the vendor console before the record",
  "  exists to publish; a DMARC policy of p=none is the safe starting point while monitoring.",
  "- If they have already pasted records and mail is broken, this is not a self-service fix.",
  "  Escalate.",
  "",
  "GOOGLE WORKSPACE ADMIN CONSOLE",
  "- Where things are: Users (add/suspend/rename, reset a password), Billing → Subscriptions",
  "  (licence count), Apps → Google Workspace (turn a service on or off), Reports → Audit.",
  "- A user who cannot sign in is usually suspended, out of licences, or hitting 2-Step",
  "  Verification. Ask which of the three the console shows before advising anything.",
  "- Adding a user needs a free licence. If licences are exhausted, that is a seat purchase and",
  "  therefore a commercial conversation — say a colleague will confirm the cost. Never quote",
  "  a price for extra seats yourself.",
  "",
  "OUTLOOK / IMAP / MOBILE SYNC",
  "- Ask for the client and version, the account type (IMAP or Exchange/ActiveSync), and the",
  "  exact error text. 'Outlook is not working' has a dozen causes and no useful answer.",
  "- For Google Workspace with 2-Step Verification, a plain password fails in an IMAP client",
  "  and an APP PASSWORD is required — this is the single most common cause and worth checking",
  "  first.",
  "- Server names, ports and SSL settings differ per vendor and per account type. Point them at",
  "  the vendor's own setup page rather than dictating settings from memory.",
  "- Repeated password prompts after a working period usually mean the password changed or the",
  "  session was revoked; re-authenticate before changing any setting.",
  "",
  "PASSWORD RESET AND ACCOUNT ACCESS",
  "- The admin resets a user's password in their own console. Explain the path; never handle a",
  "  password yourself.",
  "- NEVER ask for, accept, or repeat a password, a one-time code, a recovery code or an API",
  "  key. If the customer has sent one, do not quote it back, tell them to change it, and",
  "  escalate so a person can confirm.",
  "- If the ADMIN account itself is locked out, that is vendor account recovery and needs a",
  "  person. Escalate.",
  "",
  "STORAGE FULL",
  "- Which product, whose mailbox or Drive, and what the console reports as used vs available.",
  "- Genuine options are: free space (large mail attachments and Trash first — Trash still",
  "  counts until emptied), move data to a shared drive, or buy more storage. The third is a",
  "  purchase, so state that a colleague will confirm the cost and never name a figure.",
  "- A mailbox at 100% stops RECEIVING mail. Treat that as HIGH, not LOW.",
  "",
  "SUBSCRIPTION, SEATS, RENEWAL AND INVOICES",
  "- The subscription facts given to you below are from our own records and you may state them",
  "  plainly: plan, seat count, seats in use, renewal date, status.",
  "- Invoices and receipts are in the customer portal. If they cannot find or download one, say",
  "  a colleague will send it — do not describe a screen you cannot see.",
  "- Any question about what something COSTS, a discount, a refund, or a credit note is a",
  "  commercial matter. Escalate rather than answering.",
  "",
  "SERVICE OUTAGE",
  "- 'Nothing works for anyone', 'all mail is down', 'the whole office cannot send' is an",
  "  outage until proven otherwise. It is CRITICAL, it is never resolved by a reply, and it",
  "  goes to a person immediately.",
].join("\n");

export const SUPPORT_AGENT_SYSTEM_PROMPT = [
  "You are AnuSupport AI, the technical support assistant for an Indian cloud-solutions",
  "reseller. Customers write to you about Google Workspace, Microsoft 365 and Zoho that they",
  "bought from us. You write as a colleague on the support desk, in plain professional Indian",
  "business English. Never mention that you are an AI.",
  "",
  "THE RULES YOU MUST NOT BEND:",
  "- Never state a DNS record value — no MX host, no SPF include, no DKIM key, no DMARC",
  "  string, no server name, no port — unless it appears verbatim in AUTHORISED RECORDS below.",
  "  If that section is empty, you may state none. Send the customer to the console screen",
  "  where their own values are shown. A wrong record stops a business's mail.",
  "- Never name a price, a discount, a refund or a credit. The only rupee figures you may use",
  "  are the ones in THIS CUSTOMER'S SUBSCRIPTIONS below.",
  "- Never ask for or repeat a password, a one-time code, a recovery code or an API key.",
  "- Never promise a date, a fix time, an uptime figure or a guarantee.",
  "- Never claim you have done something in the customer's account. You cannot log into it.",
  "",
  "CHOOSING action_required:",
  "- AUTO_REPLY_AND_RESOLVE — you have the actual answer and the customer can act on it",
  "  without anything from us. Only choose this if resolution_found is true.",
  "- REQUEST_MORE_INFO — the problem is plausibly solvable but you are missing a fact the",
  "  runbook says you need. Ask for exactly that, and put it in missing_information.",
  "- ESCALATE_TO_HUMAN — an outage, an angry customer, anything commercial (price, refund,",
  "  credit, extra seats), a locked-out administrator, mail already broken by a DNS change, or",
  "  a message you do not properly understand. Choosing this is a correct answer, not a",
  "  failure.",
  "",
  "severity_level is about the customer's BUSINESS, not about how hard the question is:",
  "  CRITICAL — mail or a service is down; nobody can work",
  "  HIGH     — one person cannot work, or a mailbox has stopped receiving",
  "  MEDIUM   — something is broken but there is a workaround",
  "  LOW      — a question, a how-to, a request for information",
  "",
  "confidence_score is YOUR honest 0-1 read of how well you understood this message and how",
  "safe your answer is to send with nobody checking it. Be harsh. A low score costs one",
  "engineer-minute; a confident wrong answer costs a customer's morning.",
  "",
  "You will be told the conversation so far. Never ask the customer to repeat a check or a",
  "detail they have already given you in it.",
  "",
  "Reply with ONE JSON object and nothing else:",
  '{"issue_category":"dns_records"|"workspace_admin"|"mail_client_sync"|"password_or_access"',
  '|"storage_quota"|"subscription_or_seats"|"invoice_or_billing"|"service_outage"|"other",',
  '"severity_level":"LOW"|"MEDIUM"|"HIGH"|"CRITICAL","resolution_found":boolean,',
  '"action_required":"AUTO_REPLY_AND_RESOLVE"|"REQUEST_MORE_INFO"|"ESCALATE_TO_HUMAN",',
  '"confidence_score":number,"generated_response":{"email_subject":string,"body_text":string,',
  '"whatsapp_summary":string},"missing_information":string|null}',
  "",
  "body_text is the email body, plain text, signed off with the sender name given to you.",
  "whatsapp_summary is the SAME answer in at most 600 characters, no salutation block. Keep",
  "any numbered steps as steps — a customer follows them on a phone.",
  "",
  "KNOWLEDGE BASE — the procedures you work from:",
  SUPPORT_KNOWLEDGE_BASE,
].join("\n");

/* ── Prompt assembly ─────────────────────────────────────────────────────── */

function rupees(n: number): string {
  return `Rs ${n.toLocaleString("en-IN")}`;
}

/** One subscription as the model sees it. Facts only; no arithmetic asked of it. */
function describeSubscription(s: SupportSubscriptionFact): string {
  const parts = [
    `${s.plan} (${s.vendor})`,
    s.domain ? `domain ${s.domain}` : null,
    `${s.seats} seat(s)`,
    s.used === null ? "seats in use not synced" : `${s.used} in use`,
    `status ${s.status}`,
    s.renewalDate ? `renews ${s.renewalDate}` : "no renewal date recorded",
    `${rupees(s.mrr)} per month`,
  ];
  return `- ${parts.filter((p) => p !== null).join(" · ")}`;
}

export function buildSupportAgentPrompt(args: BuildSupportPromptArgs): BuiltSupportPrompt {
  const { customer, incoming, sellerName, supportEmail } = args;
  const authorisedRecords = args.authorisedRecords ?? [];

  const history = args.history.slice(-MAX_CONTEXT_TURNS);

  const transcript =
    history.length === 0
      ? "(this is their first message on this ticket)"
      : history
          .map((t) => {
            const who = t.role === "user" ? "CUSTOMER" : t.role === "agent" ? "US" : "NOTE";
            return `${who} (${t.channel}): ${t.content}`;
          })
          .join("\n\n");

  const subs =
    customer.subscriptions.length === 0
      ? customer.customerId
        ? "(this customer has no live subscription on record — do not assume which product they mean, ask)"
        : "(the sender does not match any customer in our records — do not assume they are a customer, and do not state any account facts)"
      : customer.subscriptions.map(describeSubscription).join("\n");

  const records =
    authorisedRecords.length === 0
      ? "(none — you may not state any DNS record, server name or port value)"
      : authorisedRecords.map((r) => `- ${r.type}: ${r.value}`).join("\n");

  const user = [
    `SUPPORT DESK: ${sellerName}, signing as ${supportEmail}`,
    "",
    "WHO IS WRITING",
    `Name: ${customer.customerName || "(not given)"}`,
    `Reply channel: ${customer.channel}`,
    `Known customer: ${customer.customerId ? "yes" : "no"}`,
    `Support tier: ${customer.tier ?? "not recorded"}`,
    customer.ticketId ? `Ticket: ${customer.ticketId}` : "No ticket has been opened yet.",
    "",
    "THIS CUSTOMER'S SUBSCRIPTIONS (the only account facts and rupee figures you may state)",
    subs,
    "",
    "AUTHORISED RECORDS (the only record values you may state verbatim)",
    records,
    "",
    "CONVERSATION SO FAR (oldest first)",
    transcript,
    "",
    "THEIR NEW MESSAGE",
    incoming.trim(),
  ].join("\n");

  return {
    system: SUPPORT_AGENT_SYSTEM_PROMPT,
    user,
    allowedMoney: customer.subscriptions.map((s) => s.mrr),
    authorisedRecords,
    /* The renewal dates we just showed the model. Nothing else — an empty list means every
       date in the draft is treated as a promise, which is the strict direction. */
    allowedDates: customer.subscriptions.flatMap((s) => (s.renewalDate ? [s.renewalDate] : [])),
  };
}

/* ── Validating what came back ───────────────────────────────────────────── */

/**
 * Strict on the four fields that drive behaviour, forgiving on the ones a person reads.
 *
 * `confidence_score` is clamped rather than rejected: a model answering 1.2 has still told us
 * "very sure", and discarding that replaces a usable signal with a retry. An unrecognised
 * `issue_category` is NOT coerced to `other` — a category we did not define means the model
 * ignored the contract, and the rest of its answer deserves the same suspicion.
 */
export const SUPPORT_AGENT_SCHEMA = z.object({
  issue_category: z.enum(SUPPORT_TOPICS),
  severity_level: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  resolution_found: z.coerce.boolean(),
  action_required: z.enum([
    "AUTO_REPLY_AND_RESOLVE",
    "REQUEST_MORE_INFO",
    "ESCALATE_TO_HUMAN",
  ]),
  confidence_score: z.coerce
    .number()
    .finite()
    .transform((n) => Math.min(1, Math.max(0, n))),
  generated_response: z.object({
    email_subject: z.string().trim().min(1).max(200),
    body_text: z.string().trim().min(1).max(8000),
    whatsapp_summary: z.string().trim().min(1).max(1200),
  }),
  missing_information: z.string().trim().min(1).max(600).nullable().default(null),
});

export type SupportParseResult =
  | { ok: true; decision: SupportDecision }
  | { ok: false; reason: string };

/**
 * Turn whatever the model returned into a decision, or say why not.
 *
 * `reason` is a sentence rather than a code, and that is why this returns a result instead of
 * throwing: the string ends up on the ticket, where "the model replied with no body text" is
 * actionable and "validation failed" is not.
 */
export function parseSupportDecision(raw: unknown): SupportParseResult {
  const parsed = SUPPORT_AGENT_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join(".") || "the response";
    return {
      ok: false,
      reason: `The AI's answer was not usable: ${where} — ${first?.message ?? "unknown problem"}.`,
    };
  }
  return { ok: true, decision: parsed.data };
}

/* ── The record-value guard ──────────────────────────────────────────────── */

/**
 * Patterns that only appear in text that is telling somebody what to put in a DNS zone or a
 * mail client. Each one is a shape, not a value, so this cannot go stale the way a list of
 * hosts would.
 *
 * `SPF_INCLUDE` deliberately matches any `include:` mechanism rather than a known set: an
 * unauthorised include is the same problem whoever it points at, and a list of "safe" includes
 * would be one more thing to keep current.
 */
const RECORD_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  // A mail host: aspmx.l.google.com, smtp.google.com, contoso-com.mail.protection.outlook.com,
  // mx.zoho.in — anything that looks like a hostname on a known mail-delivery domain.
  {
    label: "a mail server hostname",
    re: /\b[a-z0-9][a-z0-9.-]*\.(?:google\.com|googlemail\.com|outlook\.com|protection\.outlook\.com|zoho\.(?:com|in|eu)|zohomail\.(?:com|in))\b/gi,
  },
  // An SPF record or any include mechanism inside one.
  { label: "an SPF record", re: /\bv=spf1[^\n"]*/gi },
  { label: "an SPF include", re: /\binclude:[a-z0-9._-]+/gi },
  // A DKIM or DMARC record body.
  { label: "a DKIM record", re: /\bv=DKIM1\b[^\n"]*/gi },
  { label: "a DMARC record", re: /\bv=DMARC1\b[^\n"]*/gi },
  // A mail client server/port instruction: "imap.gmail.com port 993", "port 587".
  { label: "a mail client port", re: /\bport\s*[:=]?\s*(?:25|110|143|465|587|993|995)\b/gi },
];

/**
 * Hostnames that are WEB CONSOLES, never mail-delivery targets.
 *
 * ─── MEASURED ON THE FIRST REAL MESSAGE THIS AGENT EVER ANSWERED ────────────
 * A probe asked "which MX records do I need". The agent did exactly what the knowledge base
 * tells it to — sent the customer to their own console rather than reciting a record — and the
 * guard refused the draft for naming `admin.google.com`.
 *
 * That is the console URL. It is the answer, not the mistake. The hostname pattern above
 * matches anything under google.com, and the KB's own instruction ("Admin console → Account →
 * Domains → Activate Gmail") invites the model to name the place. So the guard was refusing the
 * one reply it was written to encourage — the failure this file's header warns about, in this
 * file, found by a probe rather than by a test.
 *
 * The list is deliberately the consoles the KB actually names, plus the two account pages its
 * runbooks need (app passwords live on myaccount). None of them can be an MX target for any
 * real setup, so exempting them cannot let a mail-breaking value through. A mail host that
 * merely LOOKS like a console — `mail.zoho.com`, `mail.google.com` — is NOT here, because that
 * is where a wrong value would do the damage.
 */
const CONSOLE_HOSTS = new Set([
  "admin.google.com",
  "support.google.com",
  "workspace.google.com",
  "accounts.google.com",
  "myaccount.google.com",
  "mailadmin.zoho.com",
  "help.zoho.com",
]);

export interface RecordGuardResult {
  ok: boolean;
  /** What was found and not authorised, verbatim, for the operator's sentence. */
  violations: string[];
}

/**
 * Refuse a draft that states a record value nobody authorised.
 *
 * ─── WHY A FULL-STRING MATCH AND NOT A FUZZY ONE ────────────────────────────
 * A value counts as authorised only when it appears in `authorised` exactly (case-insensitive,
 * trimmed). Near-matching would defeat the entire guard: `aspmx2.l.google.com` differs from
 * `aspmx.l.google.com` by one character and is a different host, and a customer who publishes
 * the wrong one of those has broken their mail just as thoroughly as one who published
 * nonsense.
 *
 * The mention of a CONSOLE PATH is not a record value and must not trip this — "Admin console
 * → Domains → Activate Gmail" is the answer we want the agent giving, so the patterns above
 * match record syntax and hostnames, never navigation.
 */
export function verifyNoInventedRecords(
  text: string,
  authorised: readonly AuthorisedRecord[],
): RecordGuardResult {
  const ok = new Set(authorised.map((a) => a.value.trim().toLowerCase()));
  const violations: string[] = [];

  for (const { re } of RECORD_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const found = m[0].trim();
      const lower = found.toLowerCase();
      /* A console URL is the answer we want, not a record value — see CONSOLE_HOSTS. */
      if (CONSOLE_HOSTS.has(lower)) continue;
      if (!ok.has(lower)) violations.push(found);
    }
  }

  // De-duplicated: the same host named three times is one mistake, and three copies of it in
  // the operator's sentence buries the rest of the reason.
  const unique = [...new Set(violations)];
  return { ok: unique.length === 0, violations: unique };
}

/* ── The credential guard ────────────────────────────────────────────────── */

/**
 * Refuse a draft that asks the customer for a secret.
 *
 * This is not a hypothetical politeness rule. A support desk asking for a password by email
 * is the exact shape of a phishing message, and a customer who complies has handed their
 * administrator credentials to whoever reads that mailbox next. It would also train them to
 * comply the next time somebody who is NOT us asks.
 *
 * Matched on the ASK, not on the words: "your password" appears in every legitimate reset
 * instruction ("the admin can reset your password in the console"), so a keyword match would
 * fire on the correct answer and the guard would be switched off within a week — which is the
 * failure `money-guard.ts` warns about. So the pattern requires a request verb near the secret.
 */
const CREDENTIAL_REQUEST = new RegExp(
  String.raw`\b(?:send|share|provide|give|tell|reply\s+with|confirm|forward|paste|enter\s+it|let\s+us\s+know)\b` +
    String.raw`(?:\W+\w+){0,6}?\W+` +
    String.raw`(?:your\s+|the\s+|admin\s+|current\s+)*` +
    String.raw`(?:password|passwd|otp|one[-\s]?time\s+(?:code|password|pin)|2fa\s+code|verification\s+code|recovery\s+code|api\s+key|access\s+token|secret\s+key)\b`,
  "i",
);

/** True when the draft asks the customer to hand over a secret. */
export function asksForCredentials(text: string): boolean {
  return CREDENTIAL_REQUEST.test(text);
}

/* ── The outage backstop ─────────────────────────────────────────────────── */

/**
 * Words that mean "the business has stopped", used as a floor under the model's severity read.
 *
 * The model sets `severity_level`, and mostly gets it right. This exists for the case that
 * costs something: an outage described calmly ("since this morning nobody in the office is
 * receiving mail") read as MEDIUM and answered with a troubleshooting checklist, while
 * fifteen people cannot work. A person who saw that message would not need convincing.
 *
 * Scope is deliberately narrow — EVERYONE affected, or a service DOWN. "I cannot send mail"
 * is one user and is not this; escalating every individual fault would empty the feature out.
 */
const OUTAGE_PATTERNS: readonly RegExp[] = [
  /\b(?:all|every|whole|entire)\s+(?:of\s+)?(?:the\s+)?(?:office|company|team|staff|users?|employees?|domain)\b/i,
  /\b(?:nobody|no\s+one|none\s+of\s+us|everyone)\b(?:\W+\w+){0,6}?\W+\b(?:receiv|send|sending|access|log\s*in|login|sign\s*in|work)/i,
  /\b(?:mail|email|server|service|outlook|gmail|workspace)\b(?:\W+\w+){0,3}?\W+\b(?:is|are|has\s+been)\s+(?:completely\s+|totally\s+)?(?:down|dead|not\s+working|unavailable)\b/i,
  /\b(?:complete|total)\s+(?:outage|failure|downtime)\b/i,
  /\bnothing\s+(?:is\s+)?work(?:s|ing)\b/i,
];

/** True when the customer's own words describe an outage rather than a fault. */
export function looksLikeOutage(customerMessage: string): boolean {
  return OUTAGE_PATTERNS.some((re) => re.test(customerMessage));
}

/* ── One narrow exemption, and the measurement behind it ─────────────────── */

/**
 * Hide the phrases where "free" is a VERB before the promise check reads them.
 *
 * ─── WHY THIS EXISTS, AND WHY IT IS THREE PHRASES AND NOT A DROPPED RULE ────
 * `findPromises`' discount rule matches a bare "free" — deliberately, because "first month
 * free" has to keep holding, and its own comment explains that dropping the word entirely
 * would make the rule fire on nothing. It already carves out "feel free to call me" for the
 * same reason.
 *
 * Support prose has a second idiom that rule cannot see: the answer to "my mailbox is full"
 * IS "free up space" — it is the correct advice, it appears in the knowledge base above, and
 * unexempted it would escalate every single storage ticket. That is the "guard switched off
 * within a week" failure `money-guard.ts` warns about: a rule that fires on the right answer
 * gets deleted, and then it is not there for the wrong one.
 *
 * So the exemption is by PHRASE, not by dropping the rule, and it is deliberately tiny.
 * "free of charge", "free for the first month" and every other giveaway still hold — there is
 * a test for exactly that, because the boundary is the whole point.
 */
export function maskSupportIdioms(text: string): string {
  return text.replace(/\bfree(?:s|d|ing)?\s+(?:up\b|space\b|storage\b)/gi, "reclaim");
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/**
 * Every way a model is likely to write ONE date we already hold on the customer's record.
 *
 * Generated from the ISO value rather than pattern-matched, because the question being asked is
 * not "is this a date" — `findPromises` answers that — but "is it THIS date". A regex loose
 * enough to recognise any date would authorise every date.
 */
function dateVariants(iso: string): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return [];

  const [, y, mm, dd] = m;
  const month = MONTHS[Number(mm) - 1];
  if (!month) return [];

  const d = String(Number(dd));
  const short = month.slice(0, 3);
  const suffix =
    d.endsWith("1") && d !== "11" ? "st" :
    d.endsWith("2") && d !== "12" ? "nd" :
    d.endsWith("3") && d !== "13" ? "rd" : "th";

  /* Longest first. "14 September 2026" contains "14 September", so masking the short form
     first would leave "2026" behind as a fragment — harmless here, but the ordering is what
     keeps that true if a rule for bare years is ever added. */
  return [
    `${y}-${mm}-${dd}`,
    `${d} ${month} ${y}`,
    `${d}${suffix} ${month} ${y}`,
    `${month} ${d}, ${y}`,
    `${d} ${short} ${y}`,
    `${d} ${month}`,
    `${d}${suffix} ${month}`,
    `${d} ${short}`,
    `${d}${suffix} ${short}`,
    `${month} ${d}`,
    `${short} ${d}`,
    `${dd}/${mm}/${y}`,
    `${d}/${Number(mm)}/${y}`,
    `${dd}-${mm}-${y}`,
    `${dd}/${mm}`,
  ];
}

/**
 * Hide the dates that are FACTS ON THIS CUSTOMER'S ACCOUNT before the promise check runs.
 *
 * ─── WHY THIS IS THE SAME SHAPE AS THE MONEY ALLOW-LIST ─────────────────────
 * `findPromises`' date rule is right: "we will have this fixed by Friday" is a commitment
 * somebody can miss, and it must escalate. But "your Business Standard renews on 14 Sep" is
 * not a commitment — it is a row in `subscriptions`, the prompt explicitly authorises stating
 * it, and "when does my plan renew" is one of the commonest support questions there is.
 * Unexempted, the rule escalates every correct answer to it, and then somebody deletes the
 * rule — which is the failure `money-guard.ts` was written about.
 *
 * So dates get exactly the treatment money gets: the ones we handed the model are allowed, and
 * every other date still holds. A date NOT on the account — "by Friday", or somebody else's
 * renewal — is untouched and escalates.
 */
export function maskAuthorisedDates(text: string, isoDates: readonly string[]): string {
  let out = text;
  for (const iso of isoDates) {
    for (const variant of dateVariants(iso)) {
      /* Case-INSENSITIVE, because "14 sep" and "14 Sep" are the same fact and a model writes
         either. Metacharacters are escaped rather than trusted: a date variant carries `/` and
         `-`, and an unescaped `-` inside a future bracketed form would silently become a range. */
      const escaped = variant.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
      out = out.replace(new RegExp(escaped, "gi"), "that date");
    }
  }
  return out;
}

/* ── The rules that can overrule the model ───────────────────────────────── */

export interface EscalationInput {
  decision: SupportDecision;
  /** The customer's message, for the outage backstop. */
  incoming: string;
  /** Rupee figures the prompt authorised. */
  allowedMoney: readonly number[];
  /** Record values the prompt authorised. */
  authorisedRecords: readonly AuthorisedRecord[];
  /** ISO dates already on the account, which the agent is allowed to state. */
  allowedDates?: readonly string[];
}

export interface EscalationResult {
  decision: SupportDecision;
  /** True when this function changed the action the model asked for. */
  overruled: boolean;
  /** One sentence for the support rep and the log. Empty when nothing was overruled. */
  reason: string;
}

/**
 * Apply the rules the model does not get a vote on.
 *
 * ─── IT CAN ONLY EVER MAKE THE ACTION STRICTER ──────────────────────────────
 * AUTO_REPLY_AND_RESOLVE and REQUEST_MORE_INFO can become ESCALATE_TO_HUMAN. Nothing here can
 * turn an escalation back into a reply. The direction is deliberate and worth stating because
 * the opposite is the easy bug: a later rule that "recovers" an escalation because some other
 * check passed would quietly undo the model's own decision to be careful, which is the one
 * judgement it is best placed to make.
 *
 * ─── WHY THE GUARDS RUN HERE AND NOT AT SEND TIME ───────────────────────────
 * A draft carrying an invented MX record must never become a held draft that a tired rep taps
 * "send" on. Catching it at decision time means the wrong value is never written anywhere
 * anybody can approve.
 */
export function applyEscalationRules(input: EscalationInput): EscalationResult {
  const { decision, incoming, allowedMoney, authorisedRecords } = input;
  const allowedDates = input.allowedDates ?? [];

  const escalate = (reason: string, severity?: SupportSeverity): EscalationResult => ({
    decision: {
      ...decision,
      action_required: "ESCALATE_TO_HUMAN",
      severity_level: severity ?? decision.severity_level,
      /* An escalation has not resolved anything, whatever the model claimed. Leaving this
         true would let the ticket be closed on the strength of an answer nobody sent. */
      resolution_found: false,
    },
    overruled: true,
    reason,
  });

  /* The outage backstop runs FIRST and runs even when the model already chose to escalate,
     because it changes the SEVERITY as well as the action — and severity is what decides
     whether this ticket is looked at now or after lunch. */
  const outageInWords = looksLikeOutage(incoming);
  if (outageInWords && decision.severity_level !== "CRITICAL") {
    return escalate(
      "The customer describes a whole-office or service-wide failure, which is treated as an " +
        "outage however the AI read it — a person needs to look at this now.",
      "CRITICAL",
    );
  }

  if (decision.severity_level === "CRITICAL") {
    if (decision.action_required === "ESCALATE_TO_HUMAN") {
      return { decision, overruled: false, reason: "" };
    }
    return escalate(
      "This was read as CRITICAL — a service is down for the customer — and a reply from an " +
        "automated agent is not an answer to that.",
    );
  }

  if (decision.action_required === "ESCALATE_TO_HUMAN") {
    return { decision, overruled: false, reason: "" };
  }

  if (decision.confidence_score < MIN_AUTONOMOUS_CONFIDENCE) {
    return escalate(
      `The AI rated its own understanding ${decision.confidence_score.toFixed(2)}, below the ` +
        `${MIN_AUTONOMOUS_CONFIDENCE} needed to answer a support question unattended.`,
    );
  }

  /* "I have solved it" and "I do not have the answer" cannot both be true. The model can hold
     this pair inconsistently — it is the shape of a fluent non-answer — and the resolve path
     would close the ticket on it. */
  if (decision.action_required === "AUTO_REPLY_AND_RESOLVE" && !decision.resolution_found) {
    return escalate(
      "The AI chose to answer and close the ticket while reporting that it had not actually " +
        "found the resolution — so the ticket would have been closed on a non-answer.",
    );
  }

  /* Both customer-visible surfaces, separately. The WhatsApp summary is a different piece of
     text the model wrote separately, so a record can be absent from one and present in the
     other — and the summary is the one a customer reads on a phone and acts on immediately. */
  const surfaces = [
    ["email", decision.generated_response.body_text],
    ["WhatsApp summary", decision.generated_response.whatsapp_summary],
  ] as const;

  for (const [label, text] of surfaces) {
    const records = verifyNoInventedRecords(text, authorisedRecords);
    if (!records.ok) {
      return escalate(
        `The draft's ${label} states technical values we did not verify ` +
          `(${records.violations.slice(0, 3).join(", ")}). A wrong DNS record or port stops a ` +
          "customer's mail, so the customer must be sent to their own console instead.",
      );
    }

    if (asksForCredentials(text)) {
      return escalate(
        `The draft's ${label} asks the customer for a password or a code. We never ask for ` +
          "credentials — a support mail that does is indistinguishable from phishing.",
      );
    }

    const money = verifyDraftMoney(text, allowedMoney);
    if (!money.ok) {
      return escalate(
        `The draft's ${label} names a figure that is not on this customer's account ` +
          `(${money.violations.join(", ")}). Anything commercial is a person's conversation.`,
      );
    }
  }

  /* ─── Promise check, MINUS the money and percent rules ─────────────────────
     `findPromises` was built for the acknowledgement path, where the safe answer promises
     NOTHING — so it runs verifyDraftMoney with an EMPTY allow-list and flags every currency
     figure and every percentage. Applied unchanged here it would fire on legitimate support
     text: "your mailbox is at 95%" is a diagnosis, not a concession, and the customer's own
     subscription figures are authorised and already checked three lines up.

     So money and percent are dropped HERE, narrowly, because something stricter already
     covers money on this path. The three that survive are the ones no runbook can excuse: a
     DATE we would have to meet ("this will be fixed by Monday"), a DISCOUNT nobody approved,
     and a GUARANTEE we never gave. `sales-agent.ts` makes the same three-of-five cut for the
     same reason. */
  const RELEVANT_PROMISE_KINDS = new Set(["date", "discount", "guarantee"]);
  const promises = findPromises(
    maskAuthorisedDates(maskSupportIdioms(decision.generated_response.body_text), allowedDates),
  ).findings.filter((f) => RELEVANT_PROMISE_KINDS.has(f.kind));
  if (promises.length > 0) {
    const what = promises
      .map((f) => `"${f.matched}"`)
      .slice(0, 3)
      .join("; ");
    return escalate(
      `The draft commits us to something nobody authorised — it says ${what}. A promise in ` +
        "our name needs a person behind it.",
    );
  }

  return { decision, overruled: false, reason: "" };
}

/* ── Mapping the decision onto the columns the dashboard already reads ────── */

/**
 * The agent's severity, as the ticket's own priority vocabulary.
 *
 * A mapping function rather than a shared enum, because the two vocabularies belong to
 * different owners: `severity_level` is the agent's read of the customer's day, and `priority`
 * is a column the support dashboard sorts and filters on and which a human overrides. Tying
 * them to one type would mean a future support-desk priority change rewriting the agent's
 * prompt contract.
 */
export function priorityForSeverity(severity: SupportSeverity): TicketPriority {
  switch (severity) {
    case "CRITICAL":
      return "urgent";
    case "HIGH":
      return "high";
    case "MEDIUM":
      return "normal";
    case "LOW":
      return "low";
  }
}

/**
 * The agent's topic, as the ticket's five-value category.
 *
 * Lossy on purpose, and the loss is recorded rather than discarded: the fine-grained topic
 * goes on the transcript row's `intent`, so "which runbook answered this" survives while the
 * dashboard keeps a vocabulary it can filter on. `plan_change` and `feature` are never chosen
 * by the agent — a plan change is a commercial conversation it escalates, and a feature
 * request is not a support incident — so a ticket carrying either was categorised by a person.
 */
export function categoryForTopic(topic: SupportTopic): TicketCategory {
  switch (topic) {
    case "invoice_or_billing":
      return "billing";
    case "subscription_or_seats":
      return "billing";
    case "dns_records":
    case "workspace_admin":
    case "mail_client_sync":
    case "password_or_access":
    case "storage_quota":
    case "service_outage":
      return "tech";
    case "other":
      return "other";
  }
}

/** What this turn did, for the transcript's `resolution_status`. */
export function resolutionStatusFor(
  action: SupportAction,
): "resolved" | "more_info_needed" | "escalated" {
  switch (action) {
    case "AUTO_REPLY_AND_RESOLVE":
      return "resolved";
    case "REQUEST_MORE_INFO":
      return "more_info_needed";
    case "ESCALATE_TO_HUMAN":
      return "escalated";
  }
}
