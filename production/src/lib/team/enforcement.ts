/**
 * Is hierarchy visibility a WALL, or only a view?
 *
 * ─── ONE LINE, BECAUSE TWO WOULD DISAGREE ────────────────────────────────────
 * This was `enforcedInDatabase={false}` typed out at two call sites — /leads and /quotes.
 * The day the RLS policies go live, somebody has to remember both. Editing one leaves the
 * app telling two different stories about the same guarantee on two adjacent pages, and the
 * page that still says "not enforced" is the one nobody believes afterwards.
 *
 * ─── WHICH DIRECTION IS DANGEROUS ────────────────────────────────────────────
 * Both drift directions are wrong, but they are not equally bad:
 *   · true while the policies are still off — the caveat disappears and a filter gets
 *     mistaken for privacy. This is the one that gets somebody hurt.
 *   · false after they are on — a caveat that undersells what is actually enforced. Mild.
 * hierarchy-policy.test.ts ties this constant to the migration file so neither can happen
 * quietly: flipping this without uncommenting Section 3b fails the suite, and vice versa.
 *
 * ─── WHEN TO FLIP IT ─────────────────────────────────────────────────────────
 * After Section 3b of 20260818150000_user_hierarchy_visibility.sql is APPLIED — not when it
 * is written, not when it is reviewed. Applied, and verified in a separate run. The reason
 * it is still false is in that file's §3 header: enabling it today takes four of ten people
 * to zero leads, which is a decision about who should see the pipeline, not a migration.
 */
export const HIERARCHY_ENFORCED_IN_DATABASE = false;
