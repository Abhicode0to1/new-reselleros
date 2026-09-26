/**
 * Email lookup for /api/v1 (26 Sep 2026).
 *
 * The customer lookup used `.ilike("email", email)` with the raw address as the PATTERN.
 * In a LIKE pattern `_` matches any one character and `%` any run, and PostgREST also
 * reads `*` as `%`. So `a_b@x.in` matched `axb@x.in`: a different customer of the same
 * tenant, whose bills DMS would then have shown to the wrong person. DMS refuses a
 * record whose email is not exactly the user's, but the lookup should not need that.
 *
 * Two layers, because escaping alone is not enough (PostgREST's `*` has no documented
 * escape): the pattern escapes `\`, `%` and `_`, and the caller keeps only rows whose
 * email equals the asked-for one, ignoring case. The pattern narrows the search; the
 * comparison decides it.
 */

/** A LIKE pattern that matches `value` literally, ignoring case when used with ilike. */
export function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (c) => "\\" + c);
}

/** Same address, ignoring case and surrounding space. Nothing matches a missing email. */
export function sameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? "").trim().toLowerCase();
  const y = (b ?? "").trim().toLowerCase();
  return x.length > 0 && x === y;
}
