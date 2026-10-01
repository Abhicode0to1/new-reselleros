/**
 * Who may do the few API actions that change money, reach many people at once, or
 * connect company-wide accounts (S19, 1 Oct 2026).
 *
 * These routes only checked "signed in + same tenant", so a `sales` or `support` user
 * could add seats (a bill), extend a subscription, approve a customer's seat request,
 * send a bulk campaign, bulk-import contacts or connect the company's ad accounts.
 *
 * Per-user connections (Gmail send, Google Contacts) stay open to everyone: the token
 * belongs to that user, and sales reps need their own Gmail.
 */
import type { UserRole } from "./roles";

export const ACTION_ROLES = {
  /** add-seats, extend, approve/decline a customer's seat request — they change the bill. */
  "seats.change": ["owner", "manager", "billing"],
  /** a campaign reaches every recipient at once. */
  "campaign.send": ["owner", "manager"],
  /** a bulk import writes the whole contact book. */
  "contacts.import": ["owner", "manager"],
  /** company-wide ad / Business Profile accounts. */
  "integration.company": ["owner", "manager"],
} as const satisfies Record<string, readonly UserRole[]>;

export type GuardedAction = keyof typeof ACTION_ROLES;

const WHAT: Record<GuardedAction, string> = {
  "seats.change": "change seats or subscription terms",
  "campaign.send": "send a campaign",
  "contacts.import": "import contacts",
  "integration.company": "connect company accounts",
};

export function mayDo(role: string | null | undefined, action: GuardedAction): boolean {
  return !!role && (ACTION_ROLES[action] as readonly string[]).includes(role);
}

/** The 403 body: says who can, so the person knows whom to ask. */
export function forbiddenMessage(action: GuardedAction): string {
  const who = ACTION_ROLES[action].map((r) => r[0].toUpperCase() + r.slice(1)).join(", ");
  return `Only ${who} can ${WHAT[action]}. Ask one of them to do it.`;
}
