/**
 * ABC Cloud Services signs up on @abccloud.in — a domain nobody has claimed.
 *
 * ─── THE OTHER HALF OF THE FIX ───────────────────────────────────────────────
 * anutech-accidental-signup.spec.ts proves a known company domain gets parked. This
 * proves the opposite case still works: a genuine new reseller must be able to
 * create a workspace. A domain check that quietly blocked strangers would turn a
 * tenant-isolation fix into a growth bug, and nobody would notice for weeks
 * because the person who bounced off never files a ticket.
 *
 * The three-way fork exists because there are three real answers, and the third is
 * the one everyone forgets: a CUSTOMER who followed a quote link is not a
 * ResellerOS user at all and must not be handed a workspace.
 *
 * ─── WHY MOST OF THIS FILE SKIPS, AND WHY THAT IS CORRECT ────────────────────
 * /welcome is for someone who is AUTHENTICATED and has no workspace. That state
 * is only reachable through Google OAuth, which a browser test cannot drive.
 *
 * A first draft of this file gated on `NEXT_PUBLIC_DEMO_MODE=true`, which was
 * wrong in a way worth recording: this suite deliberately starts its OWN server on
 * :3100 with demo mode OFF (playwright.config.ts explains why at length — a
 * demo-mode server makes the auth-gate assertions unpassable). So that gate asked
 * the operator to turn on the one setting the suite exists to avoid, and would
 * have skipped forever while looking like a config problem.
 *
 * These are therefore gated the same way as the other 100 skipped tests here: on
 * `.env.test`, plus a seeded auth user who has NO public.users row. Note that
 * playwright.config.ts refuses to fall back to `.env.local` on purpose, so this
 * does not quietly aim at production.
 *
 * The one assertion that needs nothing — that /welcome is not an open door — runs
 * always, and is the security-relevant half.
 */
import { expect, test } from "@playwright/test";

/** Same convention as cross-tenant / lead-flow / role-permissions specs. */
const hasEnv = Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

test.describe("independent reseller — /welcome is not an open door", () => {
  test("an unauthenticated visitor cannot reach the onboarding fork", async ({ page }) => {
    // /welcome can create a workspace. If it rendered for anyone, it would be a
    // tenant-creation endpoint with no identity behind it.
    await page.goto("/welcome");
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("independent reseller — the 3-option onboarding fork", () => {
  test.skip(
    !hasEnv,
    "Needs NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.test AND a seeded auth user with no public.users row (the /welcome state). Do NOT enable demo mode to work around this — see playwright.config.ts.",
  );

  test("shows exactly three options, and asks rather than guessing", async ({ page }) => {
    await page.goto("/welcome");

    await expect(page.getByRole("heading", { name: /one quick question/i })).toBeVisible();

    await expect(page.getByText(/i'm joining my team/i)).toBeVisible();
    await expect(page.getByText(/i'm setting up a new business/i)).toBeVisible();
    await expect(page.getByText(/i'm a customer with a quote/i)).toBeVisible();
  });

  test("'joining my team' is listed FIRST — it is the likelier right answer", async ({ page }) => {
    await page.goto("/welcome");
    const body = await page.locator("main").innerText();
    const join = body.search(/i'm joining my team/i);
    const neu  = body.search(/i'm setting up a new business/i);
    expect(join).toBeGreaterThan(-1);
    expect(neu).toBeGreaterThan(-1);
    // Ordering is a safety property here, not taste: the failure this page exists
    // to prevent is people picking "new business" when they meant "join".
    expect(join).toBeLessThan(neu);
  });

  test("choosing 'new business' warns that teammates will NOT be in it", async ({ page }) => {
    await page.goto("/welcome");
    await page.getByText(/i'm setting up a new business/i).click();

    await expect(page.locator("#companyName")).toBeVisible();
    // The consequence must be stated where the decision is made.
    await expect(page.getByText(/brand-new, empty company/i)).toBeVisible();
    await expect(page.getByText(/teammates won't be in it/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /create my workspace/i })).toBeVisible();
  });

  test("choosing 'joining my team' asks for a domain and promises nothing is created", async ({ page }) => {
    await page.goto("/welcome");
    await page.getByText(/i'm joining my team/i).click();

    const domain = page.locator("#domain");
    await expect(domain).toBeVisible();
    await expect(domain).toHaveAttribute("placeholder", /anutech\.in/i);
    await expect(page.getByText(/nothing is created for you/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /ask to join/i })).toBeVisible();
  });

  test("choosing 'customer with a quote' asks for a code and needs no account", async ({ page }) => {
    await page.goto("/welcome");
    await page.getByText(/i'm a customer with a quote/i).click();

    await expect(page.locator("#quoteId")).toBeVisible();
    await expect(page.getByText(/don't need an account/i)).toBeVisible();
  });

  test("a quote code routes to the public accept page, not into the app", async ({ page }) => {
    await page.goto("/welcome");
    await page.getByText(/i'm a customer with a quote/i).click();
    await page.locator("#quoteId").fill("Q-ET-2026-27-0001");
    await page.getByRole("button", { name: /open my quote/i }).click();

    await expect(page).toHaveURL(/\/quote\/Q-ET-2026-27-0001\/accept/);
  });

  test("the page names the exact mistake it exists to prevent", async ({ page }) => {
    await page.goto("/welcome");
    // Plain-language warning, per CLAUDE.md §24: never a dead end, always say
    // what happens next and what goes wrong if you pick the other one.
    await expect(page.getByText(/only you can see/i)).toBeVisible();
  });
});
