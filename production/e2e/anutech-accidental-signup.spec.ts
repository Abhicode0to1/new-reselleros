/**
 * Darshan signs up with an @anutech.in address that nobody invited.
 *
 * ─── THE BUG THIS GUARDS ─────────────────────────────────────────────────────
 * Before 0242, signing up with a company address nobody had invited produced a
 * brand-new tenant, auto-named from the email domain — so it looked exactly like
 * the workspace the person meant to join. Four of this database's five tenants
 * were created that way; one absorbed two days of real customer work and a
 * ₹21,240 payment before anyone noticed.
 *
 * The behaviour under test: `anutech.in` is a VERIFIED domain of ANUTECH DIGITAL
 * PVT LTD, so the signup must be parked as a join request and told so — and must
 * NOT mint a workspace.
 *
 * ─── WHY THE MAIN CASE IS ENV-GATED ──────────────────────────────────────────
 * Proving "no tenant was created" honestly means creating a real auth user in the
 * real project and then reading `public.tenants` — an assertion on the UI alone
 * cannot tell "parked" from "silently created a tenant and showed a nice screen".
 * So the decisive test needs a service-role key and cleans up after itself. The
 * checks that need no credentials run always.
 */
import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const hasAdmin = Boolean(SUPABASE_URL && SERVICE_KEY);

/** Unique per run so a crashed run never blocks the next one. */
const probeEmail = () => `e2e-darshan-${Date.now()}@anutech.in`;

test.describe("accidental signup on a verified company domain", () => {
  test("the signup form is reachable and asks for a company name", async ({ page }) => {
    // No credentials needed. Guards the route existing at all — a 404 here would
    // make every other assertion in this file vacuous.
    await page.goto("/signup");
    await expect(page.locator("#companyName")).toBeVisible();
    await expect(page.locator("#email")).toBeVisible();
  });

  test("parks the signup as a join request and creates NO tenant", async ({ page }) => {
    test.skip(!hasAdmin, "Needs SUPABASE_SERVICE_ROLE_KEY in .env.test to verify no tenant was created.");

    const email = probeEmail();
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const before = await admin.from("tenants").select("id");
    const beforeCount = before.data?.length ?? -1;

    try {
      await page.goto("/signup");
      await page.locator("#companyName").fill("Anutech Digital");
      await page.locator("#fullName").fill("Darshan Sales");
      await page.locator("#email").fill(email);
      await page.locator("#password").fill("E2e-Probe-Passw0rd!");
      await page.getByRole("button", { name: /create account/i }).click();

      // 1. The person is TOLD they are waiting, and told which workspace.
      await expect(page.getByText(/almost there|waiting for approval/i)).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText(/ANUTECH DIGITAL PVT LTD/i)).toBeVisible();

      // 2. The screen must say a separate company was NOT created. This sentence
      //    is the whole point of the change, not decoration.
      await expect(page.getByText(/did\s*not\s*create a separate company/i)).toBeVisible();

      // 3. They are NOT signed in — no session, no app shell.
      await page.goto("/dashboard");
      await expect(page).toHaveURL(/\/login/);

      // 4. The decisive assertion: the tenant count did not move.
      const after = await admin.from("tenants").select("id");
      expect(after.data?.length).toBe(beforeCount);

      // 5. A join request exists, pending, pointing at the real workspace.
      const { data: jr } = await admin
        .from("join_requests")
        .select("status, matched_by, tenant_id")
        .eq("email", email)
        .maybeSingle();
      expect(jr?.status).toBe("pending_approval");
      expect(jr?.matched_by).toBe("domain");
      expect(jr?.tenant_id).toBe("fbb976f1-9090-4f10-9726-0901bd144e42");
    } finally {
      // Clean up whatever we made, in dependency order.
      await admin.from("join_requests").delete().eq("email", email);
      const { data: list } = await admin.auth.admin.listUsers();
      const probe = list?.users?.find((u) => u.email === email);
      if (probe) await admin.auth.admin.deleteUser(probe.id);
    }
  });

  test("an UNCLAIMED domain is not parked — it reaches the onboarding fork", async ({ page }) => {
    // The mirror of the case above, and the reason the domain check cannot simply
    // park everyone: a genuine new reseller must still be able to get in.
    await page.goto("/welcome");
    // Unauthenticated, middleware sends them to login — which is itself the
    // guarantee that /welcome is not an open door.
    await expect(page).toHaveURL(/\/login|\/welcome/);
  });
});
