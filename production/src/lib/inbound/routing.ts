/**
 * Which inbox did this land in, and what should happen to it.
 *
 * ─── WHY THE RECIPIENT, NOT THE CONTENT ─────────────────────────────────────
 * The pipeline already asks Gemini what a message is ABOUT. That is the right
 * tool for "is this an enquiry, and what company is it from" and the wrong tool
 * for "should this open a support ticket": a customer writing to support@ about a
 * renewal price is a support request even though it reads like a sales enquiry,
 * and a model will disagree some fraction of the time. The address the sender
 * chose is a fact, it is free, and it is the sender's own statement of intent.
 * Route on the fact; use the model inside the branch.
 *
 * Pure and dependency-free, so every rule below is testable without a database,
 * a webhook, or an API key — the same reason `domain.ts` is split this way.
 */

/** What the pipeline should do with a message. */
export type InboundRoute = "sales" | "support" | "billing" | "ignored";

/** Local-parts we act on, and what each one means. */
const MAILBOX_ROUTES: Record<string, InboundRoute> = {
  sales:       "sales",
  enquiry:     "sales",
  enquiries:   "sales",
  info:        "sales",
  support:     "support",
  help:        "support",
  helpdesk:    "support",
  billing:     "billing",
  accounts:    "billing",
  invoices:    "billing",
};

/**
 * Addresses that must never create anything.
 *
 * `noreply`/`no-reply` matter more than they look: bounce notices and
 * auto-replies arrive from them constantly, and a pipeline that turns them into
 * leads produces a CRM full of "Mail Delivery Subsystem". `postmaster`,
 * `mailer-daemon` and `abuse` are the same class — mail ABOUT mail.
 */
const IGNORED_LOCAL_PARTS = new Set([
  "noreply", "no-reply", "donotreply", "do-not-reply",
  "postmaster", "mailer-daemon", "abuse", "bounce", "bounces",
]);

/** The local-part of an address, lower-cased. "" when unparseable. */
export function localPart(address: string | null | undefined): string {
  const at = (address ?? "").trim().toLowerCase();
  if (!at) return "";
  // A display name may wrap the address: `Sales <sales@anutech.in>`.
  const angled = /<([^>]+)>/.exec(at);
  const bare   = (angled ? angled[1] : at).trim();
  const i = bare.lastIndexOf("@");
  if (i <= 0) return "";
  // Strip a plus-tag: sales+website@ is still sales@.
  return bare.slice(0, i).split("+")[0];
}

/** The domain of an address, lower-cased. "" when unparseable. */
export function addressDomain(address: string | null | undefined): string {
  const at = (address ?? "").trim().toLowerCase();
  const angled = /<([^>]+)>/.exec(at);
  const bare   = (angled ? angled[1] : at).trim();
  const i = bare.lastIndexOf("@");
  if (i <= 0 || i === bare.length - 1) return "";
  const domain = bare.slice(i + 1);
  return domain.includes(".") ? domain : "";
}

export interface RouteDecision {
  route:     InboundRoute;
  /** The mailbox the decision was made from, for the stored audit trail. */
  mailbox:   string;
  /** Plain-language reason, logged so a misrouted message can be explained. */
  reason:    string;
}

/**
 * @param toAddress  the recipient (the ingest address the mail was sent to)
 * @param fromAddress the sender — only consulted to suppress machine mail
 *
 * Unknown mailboxes fall to `sales`, deliberately: this pipeline replaced a
 * human reading an inbox, and the cost of a stray lead someone deletes is far
 * lower than the cost of an enquiry that silently vanished because a new alias
 * was not in the table. Silence is the expensive failure here.
 */
export function decideInboundRoute(
  toAddress: string | null | undefined,
  fromAddress?: string | null,
): RouteDecision {
  const from = localPart(fromAddress);
  if (from && IGNORED_LOCAL_PARTS.has(from)) {
    return { route: "ignored", mailbox: localPart(toAddress), reason: `sender ${from}@ is a machine address` };
  }

  const mailbox = localPart(toAddress);
  if (!mailbox) {
    return { route: "sales", mailbox: "", reason: "no usable recipient — defaulting to sales rather than dropping it" };
  }
  if (IGNORED_LOCAL_PARTS.has(mailbox)) {
    return { route: "ignored", mailbox, reason: `${mailbox}@ is a no-reply address` };
  }

  const known = MAILBOX_ROUTES[mailbox];
  if (known) return { route: known, mailbox, reason: `${mailbox}@ routes to ${known}` };

  return { route: "sales", mailbox, reason: `${mailbox}@ is not a mapped inbox — defaulting to sales` };
}

/**
 * Ticket id for a message that opened a support ticket.
 *
 * The same shape the customer portal already generates. It is duplicated in two
 * portal pages; this is a third copy rather than a refactor of those, on purpose
 * — changing how live customer-facing ids are minted is not something to do as a
 * side effect of building email routing.
 */
export function newTicketId(): string {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand  = Math.floor(Math.random() * 256).toString(16).padStart(2, "0").toUpperCase();
  return `TKT-${stamp}-${rand}`;
}
