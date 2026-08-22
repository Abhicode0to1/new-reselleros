/**
 * Is this string safe to navigate to as a path INSIDE this app?
 *
 * ─── WHY THIS EXISTS AS ITS OWN FILE ────────────────────────────────────────
 * There were two places deciding it and they disagreed. `lib/push/payload.ts` had a
 * private copy (used for the offer-notification URL) and the login page had none at all —
 * it assigned `window.location.href = searchParams.get("next")` directly, which is an open
 * redirect: /login?next=https://evil.com sends the operator off-site the moment they sign
 * in, on a page where they have just typed a password.
 *
 * ─── THE THREE THINGS THAT MUST BE REJECTED ─────────────────────────────────
 *   "https://evil.com"   an absolute URL — the actual hole on the login page
 *   "//evil.com"         protocol-relative; the browser reads it as a host, not a path
 *   "/\evil.com"         browsers normalise a backslash to a slash, so this becomes the
 *                        case above. The push copy did NOT cover this one; a checker that
 *                        stops at "//" looks complete and is not.
 *
 * Anything else starting with a single "/" is a path on this origin and is allowed,
 * including a query string and a fragment — losing those is how "open the payments behind
 * this number" turns into "open payments" after a login.
 */
export function isAppPath(candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  if (!candidate.startsWith("/")) return false;
  /* Reject "//host" and "/\host" — the second character decides. */
  const second = candidate[1];
  if (second === "/" || second === "\\") return false;
  /* A control character can smuggle a line break into a Location header. Cheap to refuse
     and it has no legitimate use in an internal path. */
  if (/[\x00-\x1f\x7f]/.test(candidate)) return false;
  return true;
}

/** The path, or a safe default when it is not one of ours. */
export function appPathOr(candidate: string | null | undefined, fallback = "/dashboard"): string {
  return isAppPath(candidate) ? candidate! : fallback;
}
