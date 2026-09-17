import type { Route } from "next";

/**
 * A link to /portal/support/new that arrives with the ticket already written.
 *
 * ─── WHY THIS IS SHARED ─────────────────────────────────────────────────────
 * The portal now opens tickets from seven places — register a name, renew one,
 * recover a lapsed one, reset a control-panel password, chase a stalled setup,
 * ask why an account was paused, ask for an extension. Each one knows exactly
 * which domain or account it is about, and each was building the same URL by
 * hand. Three copies had already appeared before this file existed.
 *
 * ─── THE CAPS ARE THE POINT ─────────────────────────────────────────────────
 * The form trims and caps what it reads from the query string, because a query
 * string is not to be trusted. If a link can carry more than the form keeps, the
 * customer lands on a ticket whose last sentence has silently vanished — the
 * exact failure the prefill was supposed to prevent.
 *
 * So the limits live HERE, the form imports them from here, and this builder
 * applies them itself. A link cannot outrun the form it points at.
 *
 * Truncation is marked rather than silent. A body that has to be cut ends in an
 * ellipsis, so the customer can see that something was dropped and retype it,
 * instead of sending a sentence that stops mid-word.
 */

/** Matches the `subject` field's own zod rule at the far end. */
export const TICKET_SUBJECT_MAX = 200;
/** Generous: the textarea holds nine rows and a person may add to it. */
export const TICKET_BODY_MAX = 2000;

function clamp(value: string, max: number): string {
  const v = value.trim();
  if (v.length <= max) return v;
  /* Cut at the last space before the limit where there is one, so the visible
     text ends at a word rather than inside one. */
  const cut = v.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

/**
 * Build the link. `body` is optional — some asks are a subject and nothing more.
 *
 * `as Route` is needed because next.config sets `experimental.typedRoutes`,
 * which can check a literal template at a call site but not a string returned
 * from a function.
 */
export function ticketHref(subject: string, body?: string): Route {
  const params = new URLSearchParams();
  const s = clamp(subject, TICKET_SUBJECT_MAX);
  if (s) params.set("subject", s);
  const b = body ? clamp(body, TICKET_BODY_MAX) : "";
  if (b) params.set("body", b);
  const qs = params.toString();
  return (qs ? `/portal/support/new?${qs}` : "/portal/support/new") as Route;
}
