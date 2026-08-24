/**
 * When a support ticket should be closed for silence, and when nobody picking it up becomes
 * somebody's problem.
 *
 * Pure, so both decisions can be tested without a database or a clock. The cron that acts on
 * them is `api/cron/ai-support-sla`.
 *
 * ─── WHY THESE ARE DECISIONS AND NOT `WHERE answered_at < now() - 48h` ──────
 * The query can only ask "has it been long enough". Everything that makes an automatic close
 * wrong happened after the clock started:
 *
 *   · the customer DID reply — and a ticket closed under their reply reads as being ignored,
 *     which is the one impression a support desk cannot afford
 *   · a colleague took it over, and the machine closing their open ticket is worse than the
 *     machine doing nothing
 *   · it was escalated: an unanswered escalation is the LAST thing that should be closed for
 *     lack of a customer reply, because the silence is ours
 *
 * None of those is visible to a timestamp comparison, and each one has a different sentence
 * attached for the person who later asks why the ticket closed itself.
 */
import { AUTO_CLOSE_AFTER_HOURS, UNASSIGNED_ALERT_AFTER_MINUTES } from "./support-agent";

/** The ticket facts both decisions need, already read and typed by the caller. */
export interface SlaTicketFacts {
  ticketId: string;
  /** As stored: open | in_progress | awaiting_customer | resolved | closed. */
  status: string;
  /**
   * When the agent last put the ball in the customer's court. Null means it never did — the
   * ticket is waiting on US, and nothing here closes those.
   */
  awaitingReplySince: Date | null;
  /**
   * Newest customer message on this ticket, or null if they have not written since it opened.
   * Compared against `awaitingReplySince` rather than against "now": a message that arrived
   * BEFORE the agent answered is what the agent was answering, not a reply to it.
   */
  lastCustomerMessageAt: Date | null;
  escalated: boolean;
  escalatedAt: Date | null;
  /** Null means nobody has taken the ticket. */
  assignedAgent: string | null;
  /** When a breach alert was last sent for this ticket, so it is sent once. */
  slaAlertSentAt: Date | null;
}

export type CloseSkipReason =
  | "not_waiting_on_customer"
  | "customer_replied"
  | "already_closed"
  | "escalated"
  | "assigned_to_a_person"
  | "too_soon";

export type CloseVerdict =
  | { close: true; detail: string }
  | { close: false; reason: CloseSkipReason; detail: string };

/** Statuses that mean the ticket is already finished; closing them again is a no-op with a log row. */
const FINISHED = new Set(["closed"]);

/**
 * Statuses that mean somebody has DEALT with it, whether or not they took ownership first.
 * Used only by the unassigned-escalation alert — see shouldAlertUnassigned.
 */
const FINISHED_OR_ANSWERED = new Set(["closed", "resolved"]);

/**
 * Should this ticket be closed because the customer never came back?
 *
 * ─── THE 48 HOURS ARE NOT COUNTED FROM THE LAST UPDATE ──────────────────────
 * They are counted from `awaitingReplySince`, which the agent sets once when it answers and
 * which is cleared the moment the customer writes. Counting from `updated_at` would let any
 * edit — a rep adding a note, a category correction, the SLA cron itself — restart the clock,
 * so a ticket nobody was waiting on would stay open indefinitely while a genuinely idle one
 * closed early.
 */
export function shouldAutoClose(t: SlaTicketFacts, now: Date): CloseVerdict {
  if (FINISHED.has(t.status)) {
    return { close: false, reason: "already_closed", detail: `the ticket is already ${t.status}` };
  }

  /* Escalated tickets are never closed for customer silence. The customer is not the one who
     owes an answer, and closing it would delete the only signal that we still owe one. */
  if (t.escalated) {
    return {
      close: false,
      reason: "escalated",
      detail: "the ticket was escalated to a person, so the silence is ours and not the customer's",
    };
  }

  if (t.assignedAgent !== null) {
    return {
      close: false,
      reason: "assigned_to_a_person",
      detail: "a colleague owns this ticket — closing it automatically would talk over them",
    };
  }

  if (t.awaitingReplySince === null) {
    return {
      close: false,
      reason: "not_waiting_on_customer",
      detail: "nothing has been sent to the customer to wait on",
    };
  }

  if (t.lastCustomerMessageAt !== null && t.lastCustomerMessageAt > t.awaitingReplySince) {
    return {
      close: false,
      reason: "customer_replied",
      detail: "the customer has written since we answered, so the ticket is live again",
    };
  }

  const hours = (now.getTime() - t.awaitingReplySince.getTime()) / 3_600_000;
  if (hours < AUTO_CLOSE_AFTER_HOURS) {
    const left = Math.max(0, AUTO_CLOSE_AFTER_HOURS - hours);
    return {
      close: false,
      reason: "too_soon",
      detail: `answered ${hours.toFixed(1)}h ago — ${left.toFixed(1)}h still to run`,
    };
  }

  return {
    close: true,
    detail:
      `The customer did not reply within ${AUTO_CLOSE_AFTER_HOURS} hours of our answer, so ` +
      "this was closed automatically. Replying to the same thread reopens the conversation.",
  };
}

export type AlertSkipReason =
  | "not_escalated"
  | "already_handled"
  | "already_assigned"
  | "already_alerted"
  | "no_escalation_time"
  | "too_soon";

export type AlertVerdict =
  | { alert: true; waitedMinutes: number; detail: string }
  | { alert: false; reason: AlertSkipReason; detail: string };

/**
 * Should somebody be told that an escalated ticket is still sitting there?
 *
 * ─── ONCE, NOT EVERY SWEEP ──────────────────────────────────────────────────
 * `slaAlertSentAt` is what makes this fire once. An alarm that repeats on every run for a
 * ticket nobody has picked up is an alarm people learn to filter, and then it is not there on
 * the day it matters — AGENTS.md L37, written about a reminder that fired on the wrong day.
 *
 * The cost is stated honestly: a ticket that stays unassigned for a week is alerted once. That
 * is the right trade for an alert whose job is to interrupt, and the support dashboard already
 * shows the queue for the standing view.
 */
export function shouldAlertUnassigned(t: SlaTicketFacts, now: Date): AlertVerdict {
  if (!t.escalated) {
    return { alert: false, reason: "not_escalated", detail: "the ticket was not escalated" };
  }

  /* Measured on a probe, 24 Aug 2026: this function did not look at `status` at all, and
     neither did the query feeding it. So an escalated ticket that somebody CLOSED or RESOLVED
     without first assigning it to themselves — the ordinary way a rep deals with one, answer
     it and close it — would be alerted on every sweep for the rest of time.

     That is the failure the once-only stamp exists to prevent, arriving through the other
     door: an alarm that keeps firing about a ticket nobody needs to look at is one people
     learn to filter, and then it is not there for the ticket that does. Checked here rather
     than only in the query, because the decision has to be right on its own — the query is an
     optimisation and a second reader will not know it was load-bearing. */
  if (FINISHED_OR_ANSWERED.has(t.status)) {
    return {
      alert: false,
      reason: "already_handled",
      detail: `the ticket is ${t.status} — somebody dealt with it without assigning it`,
    };
  }

  if (t.assignedAgent !== null) {
    return {
      alert: false,
      reason: "already_assigned",
      detail: "somebody has taken this ticket",
    };
  }

  if (t.slaAlertSentAt !== null) {
    return {
      alert: false,
      reason: "already_alerted",
      detail: "an alert for this ticket has already gone out",
    };
  }

  /* Escalated with no timestamp should not happen — the dispatcher writes both together. It is
     reported rather than treated as "escalated a long time ago", because guessing here would
     turn a data fault into an alert storm the first time it occurs. */
  if (t.escalatedAt === null) {
    return {
      alert: false,
      reason: "no_escalation_time",
      detail:
        "the ticket is flagged as escalated but carries no escalation time, so how long it " +
        "has waited cannot be known — check support_tickets.ai_escalated_at for this row",
    };
  }

  const minutes = (now.getTime() - t.escalatedAt.getTime()) / 60_000;
  if (minutes < UNASSIGNED_ALERT_AFTER_MINUTES) {
    return {
      alert: false,
      reason: "too_soon",
      detail: `escalated ${minutes.toFixed(0)} min ago — the alert is due at ${UNASSIGNED_ALERT_AFTER_MINUTES} min`,
    };
  }

  return {
    alert: true,
    waitedMinutes: Math.round(minutes),
    detail:
      `Escalated ${Math.round(minutes)} minutes ago and still nobody's ticket. Assign it on ` +
      "the Support screen, or reply to the customer directly.",
  };
}
