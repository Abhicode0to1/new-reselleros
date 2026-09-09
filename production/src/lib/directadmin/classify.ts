/**
 * What a DirectAdmin refusal actually MEANS.
 *
 * Ported from the DMS engine's `lib/integrations/directadmin/classify.ts` on
 * 9 Sep 2026 — the best-judged module in that codebase, and ported closely
 * because its central insight is right: DA answers every kind of "no" the same
 * way, with HTTP 200 and a sentence of English, so the sentence is the only
 * place the difference lives. A caller that cannot tell "this user is gone" from
 * "DA is having a bad minute" will either mark a live account orphaned or retry
 * a permanent failure forever.
 *
 * ─── WHY THE FRAGMENTS ARE A LIST AND NOT A REGEX ────────────────────────────
 * They are DA's own wording, and it varies by version and by which internal
 * check refused. DMS built these lists from production logs and called them
 * "conservative; expand as new variants are seen" — which is the right posture:
 * an unmatched fragment falls through to `hard`, so a missing entry makes a
 * failure LOUD rather than silently mis-sorted.
 *
 * ─── WHAT CHANGED IN THE PORT ────────────────────────────────────────────────
 *
 * 1. FIVE NEAR-IDENTICAL CLASSIFIERS BECAME ONE. DMS had
 *    classify{CreateUser,SuspendUser,UnsuspendUser,GetUserConfig,DeleteUser,
 *    ChangePackage}Error, each an if-chain over the same fragment lists, kept
 *    separate "so the synthesised default reason mentions the right operation in
 *    logs". The operation name is now an argument, which buys the same log line
 *    without six places to update when a fragment is added. `consider` keeps each
 *    operation from returning a kind that is meaningless for it — a suspend
 *    cannot fail with `package_not_found`.
 *
 * 2. "UNREACHABLE" WAS `status === 503` AND NOTHING ELSE. A 502 or 504 from DA's
 *    front end is the same backend outage, and a timeout or DNS failure never had
 *    a status at all — DMS's axios wrapper turned all of those into `hard`, so a
 *    sweep that hit a slow DA would mark accounts permanently failed. The
 *    transport discriminator from `admin-request.ts` decides this now, not a
 *    single magic number.
 *
 * 3. AN HTML LOGIN PAGE IS NEVER A PER-USER FACT. DMS matched fragments against
 *    whatever string it had, and DA's login page HTML contains no fragment, so it
 *    landed in `hard` with the HTML as the "reason". It is a configuration
 *    problem — the wrong key, or this server's IP missing from DA's allowlist —
 *    and it is now its own kind, because retrying it per-user on a schedule is
 *    pure noise and the fix is nowhere near the account.
 */

/**
 * "The username we tried is taken." Only `create` can produce this, and the
 * caller's move is to try a different candidate rather than to fail.
 */
export const USERNAME_TAKEN_FRAGMENTS = ["already exists"] as const;

/**
 * "That user is not on this server" — deleted out of band, or never created.
 * Terminal: no retry can fix it, and it is the signal that a local row has gone
 * stale. DMS's list, from its production logs.
 */
export const USER_NOT_FOUND_FRAGMENTS = [
  "unable to find user",
  "no such user",
  "user does not exist",
  "user not found",
  "unknown user",
  "cannot find user",
] as const;

/**
 * "That package is not on this server." A seeding or configuration error, not a
 * customer fact — worth failing loudly rather than retrying.
 */
export const PACKAGE_NOT_FOUND_FRAGMENTS = [
  "package does not exist",
  "no such package",
  "package not found",
  "unable to find the package",
  "cannot find package",
  "invalid package",
] as const;

export function matchesAny(haystack: string | undefined, needles: readonly string[]): boolean {
  if (!haystack) return false;
  const lower = haystack.toLowerCase();
  return needles.some((n) => lower.includes(n));
}

export type DaFailureKind =
  | "username_taken"
  | "user_not_found"
  | "package_not_found"
  /** DA never answered, or its backend is down. Retry later. */
  | "unreachable"
  /** Wrong key, or this IP is not on DA's allowlist. Not per-user; not retryable. */
  | "not_authorised"
  /** DA said no for a reason we do not recognise. Deliberately loud. */
  | "hard";

/** What `admin-request.ts` (or `user-auth.ts`) reported, narrowed to a failure. */
export interface DaFailureInput {
  reason: string;
  transport: "network" | "http" | "envelope" | "login_page";
  status?: number;
}

/**
 * DA's front end answering while its backend is down. 503 is the common one and
 * the only one DMS handled; 502 and 504 are the same outage seen through a
 * different proxy state, and treating them as permanent is how a sweep turns a
 * ten-minute outage into a column of orphaned accounts.
 */
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

/**
 * Sorted by precedence, not alphabetically — the order is load-bearing.
 * `user_not_found` outranks `package_not_found` because DA can return both
 * fragments in one response when the USERNAME is the wrong part, and reporting
 * "no such package" then would send whoever reads it to the wrong place. DMS
 * documented this and it is kept.
 */
const SPECIFIC_KINDS: ReadonlyArray<{ kind: DaFailureKind; fragments: readonly string[] }> = [
  { kind: "user_not_found", fragments: USER_NOT_FOUND_FRAGMENTS },
  { kind: "package_not_found", fragments: PACKAGE_NOT_FOUND_FRAGMENTS },
  { kind: "username_taken", fragments: USERNAME_TAKEN_FRAGMENTS },
];

export interface DaFailure {
  kind: DaFailureKind;
  reason: string;
}

/**
 * Sort one DirectAdmin failure into something a caller can act on.
 *
 * `op` names the operation for the log line only. `consider` lists the specific
 * kinds this operation can meaningfully produce; anything outside it falls
 * through to `hard`, so a suspend never comes back claiming a package problem.
 * Default is the pair every user-scoped operation shares.
 */
export function classifyDaFailure(
  op: string,
  fail: DaFailureInput,
  consider: readonly DaFailureKind[] = ["user_not_found"],
): DaFailure {
  const reason = fail.reason || `DA ${op} failed`;

  /* Transport first: a network failure or a login page has no per-user meaning,
     and matching English fragments against DA's HTML would be a coin toss. */
  if (fail.transport === "network") return { kind: "unreachable", reason };
  if (fail.transport === "login_page") return { kind: "not_authorised", reason };
  if (fail.transport === "http") {
    return RETRYABLE_STATUSES.has(fail.status ?? 0)
      ? { kind: "unreachable", reason }
      : { kind: "hard", reason };
  }

  /* transport === "envelope": DA understood the request and refused it in
     English, so the wording is the only evidence there is. */
  for (const { kind, fragments } of SPECIFIC_KINDS) {
    if (consider.includes(kind) && matchesAny(reason, fragments)) return { kind, reason };
  }
  return { kind: "hard", reason };
}
