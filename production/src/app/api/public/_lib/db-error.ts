/**
 * What a PUBLIC route (no login) tells the caller when the database refuses (R-026, 1 Oct 2026).
 *
 * Eight public routes sent Postgres's own error text to whoever called them — "duplicate key
 * value violates unique constraint …", column and table names. That tells a stranger about the
 * schema and tells a customer nothing they can act on (CLAUDE.md §24). The raw text now goes to
 * the server log only, and the caller gets the route's own sentence.
 *
 * The exception is a message a database function raised ON PURPOSE for the person in front of
 * the screen — "Wrong PIN", "Amount must be more than zero". Those are listed per route by
 * their SQLSTATE in `passCodes` (plain `raise exception` is P0001), so a route only lets through
 * the codes its own functions use for that. Underscore folder: not a route, just shared code.
 */
type DbErrorLike = { message: string; code?: string | null } | null | undefined;

export interface PublicDbError {
  status: number;
  message: string;
}

export function publicDbError(
  route: string,
  error: DbErrorLike,
  publicMessage: string,
  opts: { status?: number; passCodes?: Record<string, number> } = {},
): PublicDbError {
  const code = error?.code ?? "";
  const detail = `${code ? `${code} ` : ""}${error?.message ?? "unknown error"}`;
  const passStatus = opts.passCodes?.[code];
  if (passStatus !== undefined && error?.message) {
    // A message written for this person: an expected refusal, not a fault (AGENTS.md L6).
    console.warn(`[api/public/${route}] refused: ${detail}`);
    return { status: passStatus, message: error.message };
  }
  console.error(`[api/public/${route}] failed: ${detail}`);
  return { status: opts.status ?? 500, message: publicMessage };
}
