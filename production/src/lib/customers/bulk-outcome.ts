/**
 * What to tell the operator after a bulk action that partly worked.
 *
 * ─── PARTIAL SUCCESS IS THE NORMAL CASE, NOT THE EDGE CASE ──────────────────
 * A bulk action here is N independent writes, not one transaction. Bulk delete is the
 * clearest example: `delete_customer` refuses any customer that has a subscription,
 * payment, invoice, quote or project (migration 0174 — the server is the authority, not
 * this client), so selecting twelve customers and pressing Delete routinely deletes four
 * and refuses eight. That is the guard working.
 *
 * The dangerous report is "Deleted 12 customers" when four went. The second most
 * dangerous is a bare "Some failed", which tells the operator to go and count rows
 * themselves. So this returns both numbers and NAMES the ones that did not happen —
 * §24: what happened, why, and what to do next.
 *
 * Pure and separate from the page because the interesting behaviour is entirely in the
 * counting, and a toast is a poor place to discover an off-by-one.
 */

export interface BulkFailure {
  /** What the operator sees in the list — the customer's name, never an id. */
  name: string;
  /** Why this one did not happen. Comes from the server guard where there is one. */
  reason: string;
}

export interface BulkOutcome {
  /** How many writes succeeded. */
  done: number;
  /** The ones that did not, with their reasons. */
  failed: BulkFailure[];
}

export interface BulkOutcomeMessage {
  /** "success" only when everything worked. A partial run is a WARNING, not a success. */
  tone: "success" | "warning" | "error";
  title: string;
  /** Names and reasons, ready to render. Empty when nothing failed. */
  description?: string;
}

/** At most this many names are listed before the message collapses to a count. */
export const MAX_NAMED_FAILURES = 3;

/**
 * Turn the results of a bulk run into one honest message.
 *
 * `verbPast` is the completed verb — "Deleted", "Archived", "Moved". It is passed in
 * rather than derived so the caller keeps control of the wording; a shared verb table
 * would be a lookup nobody could read at the call site.
 */
export function bulkOutcomeMessage(
  outcome: BulkOutcome,
  verbPast: string,
  noun: string = "customer",
): BulkOutcomeMessage {
  const { done, failed } = outcome;
  const n = (count: number) => `${count} ${noun}${count === 1 ? "" : "s"}`;

  /* Nothing worked. Loudest case, and the reason matters most here because it is the
     only information the operator has. */
  if (done === 0 && failed.length > 0) {
    return {
      tone: "error",
      title: `Could not ${verbPast.toLowerCase().replace(/e?d$/, "")} ${n(failed.length)}`,
      description: describeFailures(failed),
    };
  }

  if (failed.length === 0) {
    return { tone: "success", title: `${verbPast} ${n(done)}` };
  }

  /* The case this module exists for: some went, some did not. Both numbers in the
     title, because a count of successes alone reads as complete. */
  return {
    tone: "warning",
    title: `${verbPast} ${n(done)} · ${failed.length} refused`,
    description: describeFailures(failed),
  };
}

/**
 * Names first, then the reason.
 *
 * Only the first few are named. Twenty names in a toast is a wall nobody reads, and the
 * count is what tells the operator whether to go and look properly.
 */
function describeFailures(failed: readonly BulkFailure[]): string {
  const named = failed.slice(0, MAX_NAMED_FAILURES).map((f) => f.name);
  const rest = failed.length - named.length;
  const who = rest > 0 ? `${named.join(", ")} and ${rest} more` : named.join(", ");

  /* One shared reason is stated once. Different reasons cannot be summarised without
     lying, so the operator is pointed at the rows instead. */
  const reasons = new Set(failed.map((f) => f.reason));
  const why = reasons.size === 1 ? ` — ${[...reasons][0]}` : " — open each one to see why.";
  return `${who}${why}`;
}
