/**
 * Who may see whose employee advance.
 *
 * ─── WHY THIS IS A SEPARATE, TESTED MODULE ──────────────────────────────────
 * `/api/my-advances` uses `createAdminClient()`, so RLS is off and this decision
 * is the ONLY thing standing between one employee and another employee's money.
 * It was six lines of substring matching inlined in a route with no test.
 *
 * ─── THE RULE, AND ITS LIMIT ────────────────────────────────────────────────
 * `expenses` has no employee link. Measured 22 Aug 2026: the only employee-ish
 * columns are `vendor_name` (text), `vendor_id` (a *vendor* FK, not a person) and
 * `prepaid_advance_id`. So an advance is tied to a person by a **typed-in name**
 * and nothing else, and every rule below is therefore a heuristic.
 *
 * The heuristic is: **the first name token must be the same.** An advance is
 * recorded under the person's given name — the one live row is `vendor_name =
 * 'Darshan'` for the user "Darshan (Sales)" — so comparing first token to first
 * token is a real rule rather than a coincidence.
 *
 * What the old substring test did instead, and why it had to go:
 *
 *   curNameLower.includes(empNameLower)
 *
 * That matches any advance whose whole name appears anywhere inside the viewer's
 * name. With the real staff list that is a live hazard, not a theoretical one:
 * an advance recorded as **"Raj"** would be shown to **"Ranjeet Raj"**, and one
 * recorded as **"Sharma"** to all five Sharmas in this tenant. Surnames are
 * shared; first names collide far less.
 *
 * It also carried a hardcoded ladder of six real first names — pawan, ranjeet,
 * abhishek, pratik, hitesh, and a clause granting anyone whose *email* contained
 * "sales" any advance named "darshan" or "sales". Against the live data that
 * ladder matched nothing at all, so removing it changes no one's view today; what
 * it removes is a standing grant written into source, which would have fired the
 * moment a second person's advance was entered.
 *
 * **This is still a stopgap.** Two employees who share a first name are
 * indistinguishable here, and no amount of string work fixes that — the real fix
 * is an id column on the advance. Until then this errs toward showing nothing:
 * an unnamed advance is visible only to the roles that see everything.
 */

/** All-access roles. An advance is company money, so these see the whole tenant's. */
export const ADVANCE_ALL_ACCESS_ROLES = ["owner", "manager", "accountant"] as const;

export function seesAllAdvances(role: string | null | undefined): boolean {
  if (!role) return false;
  return (ADVANCE_ALL_ACCESS_ROLES as readonly string[]).includes(role.trim().toLowerCase());
}

/**
 * Name → comparable word tokens. Punctuation becomes a separator, so
 * "Darshan (Sales)" and "Darshan, Sales" both give ["darshan", "sales"].
 */
export function nameTokens(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t.length > 0);
}

/** First name token, or null when there is nothing usable to compare. */
export function firstNameToken(raw: string | null | undefined): string | null {
  return nameTokens(raw)[0] ?? null;
}

/**
 * Does this advance belong to this viewer, as far as a name can tell?
 *
 * Fail-closed on both sides: a viewer with no name, or an advance recorded with
 * no name, matches nothing. `vendor_name` is deliberately the raw column here —
 * NOT the "Employee" placeholder the UI falls back to for display. Matching on
 * the placeholder would hand every unnamed advance to anyone called "Employee",
 * which is a plausible value standing in for a missing one (AGENTS.md §2).
 */
export function isOwnAdvance(
  viewerFullName: string | null | undefined,
  advanceVendorName: string | null | undefined,
): boolean {
  const viewer = firstNameToken(viewerFullName);
  const advance = firstNameToken(advanceVendorName);
  if (!viewer || !advance) return false;
  return viewer === advance;
}

/**
 * The advances one viewer may see, out of every advance in their tenant.
 *
 * Generic over the row so the route keeps its own shape and this module never
 * needs to know what an advance looks like beyond the name it is filed under.
 */
export function visibleAdvances<T>(
  rows: readonly T[],
  vendorNameOf: (row: T) => string | null | undefined,
  viewer: { role: string | null | undefined; fullName: string | null | undefined },
): T[] {
  if (seesAllAdvances(viewer.role)) return [...rows];
  return rows.filter((r) => isOwnAdvance(viewer.fullName, vendorNameOf(r)));
}
