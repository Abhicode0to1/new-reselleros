/**
 * What may a route say back to the browser about a database failure? — R-025 (Pardeep,
 * 29 Sep 2026), second half.
 *
 * Several routes did `return NextResponse.json({ error: err.message }, { status: 500 })`,
 * which hands the caller whatever Postgres said. Sometimes that is exactly right and
 * sometimes it is a leak, and the two are not distinguishable at the call site — which
 * is why the decision is here.
 *
 * ── The line, and it is a real one ──────────────────────────────────────────────
 * **P0001 is OUR sentence.** It is `raise exception` inside one of this project's own
 * SECURITY DEFINER functions, and those messages are deliberately written as next
 * steps ("… credit-note that invoice before deleting" — CLAUDE.md §24, AGENTS.md §7).
 * Swallowing them would turn every guard in the money spine into a bare "something went
 * wrong", which is the dead end §24 exists to forbid. So P0001 passes through.
 *
 * **Everything else is the ENGINE talking.** `23505 duplicate key value violates unique
 * constraint "quotes_pkey"`, `42703 column "foo" does not exist`, `42P01 relation … does
 * not exist`, a statement timeout. None of it means anything to the operator, all of it
 * names our tables, columns, constraints and functions, and a 42xxx in particular is the
 * shape of a probe's reward: it tells whoever is poking exactly what the schema is
 * called. That gets a written sentence and a code to quote; the detail goes to the
 * server log, where it is actually useful.
 *
 * This is NOT a catch-all (AGENTS.md L6): it classifies, and the caller still chooses
 * the status. A config problem is not a 500 and a leak is not a feature.
 */

export interface DbErrorLike {
  message?: string | null;
  code?:    string | null;
  details?: string | null;
  hint?:    string | null;
}

/** A `raise exception` from one of our own RPCs — authored copy, safe and useful. */
export function isAuthoredDbMessage(err: DbErrorLike | null | undefined): boolean {
  return err?.code === "P0001";
}

/**
 * The sentence to put in the response body.
 *
 * `fallback` is what the caller wants said when the engine's own words cannot be shown.
 * It must be a §24 sentence — what happened, and what to do — not "Internal error".
 */
export function safeDbMessage(
  err: DbErrorLike | null | undefined,
  fallback: string,
): string {
  if (isAuthoredDbMessage(err) && err?.message) return err.message;
  /* The code is included on purpose: it is not sensitive on its own, it is the one
     thing that makes a support conversation short, and it stops the operator inventing
     a description of a failure they cannot see. */
  return err?.code ? `${fallback} (${err.code})` : fallback;
}

/**
 * Log the whole thing server-side. Call this beside every `safeDbMessage`, or the detail
 * that was withheld from the customer is withheld from us as well — which is how a leak
 * gets "fixed" into a silent failure (AGENTS.md §2, L92).
 */
export function logDbError(where: string, err: DbErrorLike | null | undefined): void {
  console.error(
    `[${where}] db error`,
    { code: err?.code, message: err?.message, details: err?.details, hint: err?.hint },
  );
}
