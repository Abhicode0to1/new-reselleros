/**
 * Is hierarchy visibility a WALL, or only a view?
 *
 * Since 18 Aug 2026: a wall. Section 3 of 20260818150000_user_hierarchy_visibility.sql is
 * APPLIED to production and verified in a separate run — nine policies, all nine RESTRICTIVE,
 * and public.can_see_record() present. The API no longer serves a peer's leads to a rep who
 * asks for them directly.
 *
 * ─── ONE LINE, BECAUSE TWO WOULD DISAGREE ────────────────────────────────────
 * This was `enforcedInDatabase={false}` typed out at two call sites — /leads and /quotes.
 * Editing one on the day RLS went live would have left the app telling two different stories
 * about the same guarantee on two adjacent pages, and the page still saying "not enforced" is
 * the one nobody believes afterwards.
 *
 * ─── WHICH DIRECTION IS DANGEROUS ────────────────────────────────────────────
 * Both drift directions are wrong, but not equally:
 *   · true while the policies are off — the caveat disappears and a filter gets mistaken for
 *     privacy. This is the one that gets somebody hurt.
 *   · false after they are on — a caveat that undersells what is enforced. Mild.
 * hierarchy-policy.test.ts ties this constant to the `SECTION 3B APPLIED` marker in the
 * migration, so neither can happen quietly. Keyed to that marker rather than to whether the
 * SQL is commented out, because "written" and "running in production" are different facts and
 * only one of them is safe to advertise.
 *
 * ─── WHAT IS STILL *NOT* WALLED, SO NOBODY OVER-READS THIS ───────────────────
 * Leads are genuinely scoped. Quotes and customers carry the policies but every row is
 * unowned, and unowned means company data, visible to the tenant — so isolation there begins
 * the day rows get an owner, not today. invoices and subscriptions have no owner column at
 * all and are deliberately out of scope. See the migration header.
 */
export const HIERARCHY_ENFORCED_IN_DATABASE = true;
