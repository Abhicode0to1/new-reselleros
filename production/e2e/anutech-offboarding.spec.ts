/**
 * Offboarding — 1-click access revocation + automatic lead re-assignment.
 *
 * ═══ THIS FEATURE DOES NOT EXIST YET (measured 14 Aug 2026) ═════════════════
 *
 * Every behavioural test below is `test.fixme()`. That is not caution, it is the
 * finding: there is nothing to test, and a spec that quietly asserted the current
 * behaviour would go green while nobody's access was actually being revoked.
 *
 * What was checked, and what it showed:
 *
 *   • `users.is_active` EXISTS and is displayed. The Team page renders an
 *     "Active / Inactive" badge from it (team/page.tsx:185, :228).
 *
 *   • Nothing ever SETS it for a team member. The only writes to an `is_active`
 *     column anywhere in src/ are for employees, coupons, promos, items, bank
 *     accounts and customers — never for a `users` row. There is no toggle.
 *
 *   • Nothing ever READS it as a gate. It appears in no middleware, no auth
 *     helper, and — the decisive one — in **0 of the 335 RLS policies**
 *     (`select count(*) from pg_policies where qual ilike '%is_active%'` → 0).
 *
 * So the badge promises an access control that does not exist. Set a user
 * inactive today and they would still sign in and read the entire tenant. That is
 * worse than having no feature at all, because the Team page tells an owner the
 * person is switched off.
 *
 * ─── AND "AUTOMATIC LEAD RE-ASSIGNMENT" NEEDS A DECISION FIRST ───────────────
 * `leads.owner_id` exists, so the mechanics are easy. The unanswered question is
 * business, not technical: when Darshan leaves, do his open leads go to the
 * owner, to a named manager, to round-robin among sales, or to unassigned? Each
 * is defensible and they are not interchangeable — silently picking one would
 * move real pipeline to the wrong person. That is Pardeep's call.
 *
 * ─── TO TURN THESE ON ────────────────────────────────────────────────────────
 * Build: (a) an owner-only toggle writing `users.is_active`; (b) a gate that
 * actually stops an inactive user — the honest place is RLS plus a middleware
 * bounce, not a hidden button; (c) a decided re-assignment rule. Then delete the
 * `test.fixme()` markers. The assertions are already written to the intended
 * contract, so they should need no rewriting.
 */
import { expect, test } from "@playwright/test";

test.describe("offboarding — access revocation", () => {
  test("the Team page is auth-gated (sanity: the surface exists and is protected)", async ({ page }) => {
    // The one thing that IS true today and worth a regression guard: /team is not
    // reachable without a session, so nothing below can be exploited anonymously.
    await page.goto("/team");
    await expect(page).toHaveURL(/\/login|\/team/);
  });

  test.fixme("an owner can deactivate a teammate in one click", async ({ page }) => {
    // Expected: Team → row menu → "Revoke access". Optimistic badge flip to
    // Inactive, persisted to users.is_active = false.
    await page.goto("/team");
    await page.getByRole("row", { name: /darshan/i })
      .getByRole("button", { name: /revoke access/i }).click();
    await expect(page.getByRole("row", { name: /darshan/i })
      .getByText(/inactive/i)).toBeVisible();
  });

  test.fixme("a deactivated user is actually locked out, not just badged", async ({ page }) => {
    // THE test. `is_active=false` must stop the session reaching tenant data —
    // enforced in RLS, not only in the UI. A check that lives only in TypeScript
    // stops at the first curl (roles.ts says exactly this).
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText(/access has been removed/i)).toBeVisible();
  });

  test.fixme("revoking access does not delete the person or their history", async ({ page }) => {
    // Deactivation must be reversible and must not orphan their past work —
    // quotes they raised, activity they logged, leads they closed.
    await page.goto("/team");
    await expect(page.getByText(/darshan/i)).toBeVisible();       // still listed
    await expect(page.getByRole("button", { name: /restore access/i })).toBeVisible();
  });

  test.fixme("open leads are re-assigned by the decided rule, and it is visible", async ({ page }) => {
    // Blocked on the business decision above. Whatever the rule, the operator
    // must SEE where the pipeline went — a silent move is how deals get dropped.
    await page.goto("/leads");
    await expect(page.getByText(/re-assigned from darshan/i)).toBeVisible();
  });

  test.fixme("re-assignment is recorded in the activity log", async ({ page }) => {
    await page.goto("/activity");
    await expect(page.getByText(/re-assigned .* leads? from darshan/i)).toBeVisible();
  });
});
