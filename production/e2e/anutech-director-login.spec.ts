/**
 * Deepak Sharma — director — signs in and lands in ANUTECH DIGITAL PVT LTD as owner.
 *
 * ─── AN HONEST NOTE ABOUT WHAT PLAYWRIGHT CAN DO HERE ────────────────────────
 * The brief asks for "OAuth login verifying direct owner link". A browser test
 * cannot complete Google OAuth: the consent screen is Google's, it is bot-guarded,
 * and driving it would need real Google credentials in CI. Any spec claiming to
 * test that flow end-to-end would be testing a stub of its own making and would go
 * green while the real callback was broken. So this file does not pretend.
 *
 * What it does instead, which is the part that actually failed in production:
 *
 *   1. The OAuth ENTRY POINT exists and points at our callback (no credentials).
 *   2. The LINK itself — that `deepak@anutech.in` resolves to a users row in
 *      ANUTECH DIGITAL PVT LTD with role owner. That is a database fact and is
 *      asserted directly, which is stronger than watching a redirect.
 *   3. The callback refuses to invent a tenant for an unknown account.
 *
 * As of 14 Aug 2026 Deepak has an auth account and NO profile — he is one of the
 * thirteen stranded accounts. Test 2 is therefore EXPECTED TO FAIL until he is
 * claimed on /team. That is the point: it is the regression test for the fix, and
 * it is skipped rather than faked while the fix is pending.
 */
import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const hasAdmin = Boolean(SUPABASE_URL && SERVICE_KEY);

const ANUTECH_TENANT = "fbb976f1-9090-4f10-9726-0901bd144e42";
const DIRECTOR_EMAIL = "deepak@anutech.in";

test.describe("director sign-in — Deepak Sharma", () => {
  test("the Google sign-in button exists and targets our own callback", async ({ page }) => {
    await page.goto("/login");
    const google = page.getByRole("button", { name: /sign in with google/i });
    await expect(google).toBeVisible();

    // The redirectTo is built client-side as `${origin}/callback?next=…`. Assert
    // the callback route exists rather than trying to read a closure: a 404 here
    // is exactly the breakage that stranded users in the first place.
    const res = await page.request.get("/callback", { maxRedirects: 0 });
    // No ?code → the handler redirects to /login?error=no_code. Any 404/500 means
    // the route is gone.
    expect([301, 302, 303, 307, 308]).toContain(res.status());
    expect(res.headers()["location"] ?? "").toMatch(/\/login\?error=no_code/);
  });

  test("deepak@anutech.in is an OWNER of ANUTECH DIGITAL PVT LTD", async () => {
    test.skip(!hasAdmin, "Needs SUPABASE_SERVICE_ROLE_KEY in .env.test.");

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: profile } = await admin
      .from("users")
      .select("tenant_id, role")
      .eq("email", DIRECTOR_EMAIL)
      .maybeSingle();

    // Deliberately a hard assertion, not a soft skip. On 14 Aug 2026 this FAILS —
    // Deepak can authenticate and has no profile, so he signs in to nothing. The
    // fix is one click on /team → Claim a colleague. A test that skipped itself
    // here would let a director stay locked out silently.
    expect(
      profile,
      `${DIRECTOR_EMAIL} has no public.users row. He is a stranded auth account: ` +
      `open /team → "Claim a colleague", enter this address, role owner.`,
    ).not.toBeNull();
    expect(profile?.tenant_id).toBe(ANUTECH_TENANT);
    expect(profile?.role).toBe("owner");
  });

  test("the callback never invents a workspace for an unrecognised account", async ({ page }) => {
    test.skip(!hasAdmin, "Needs SUPABASE_SERVICE_ROLE_KEY in .env.test to count tenants.");

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const before = (await admin.from("tenants").select("id")).data?.length ?? -1;

    // A callback hit with a bogus code must fail closed, not provision anything.
    await page.goto("/callback?code=not-a-real-oauth-code");
    await expect(page).toHaveURL(/\/login\?error=auth_failed/);

    const after = (await admin.from("tenants").select("id")).data?.length ?? -2;
    expect(after).toBe(before);
  });
});
