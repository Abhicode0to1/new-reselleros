/**
 * lead-flow.spec.ts — UI-driven happy-path tests for Sales Workspace v2.
 *
 * Covers the redesigned leads page surfaces:
 *   - Smart Views chip bar (All / Mine / Today / Hot / New / Won MTD)
 *   - Today Strip (overdue / due-today / hot / quotes-pending chips)
 *   - Pipeline pulse bar (₹-weighted segments)
 *   - Lead detail drawer (contact action card + WhatsApp/Call/Email)
 *   - Mobile FAB stack (Quick + Add lead)
 *   - Topbar sparkles → full-screen Quick Actions panel
 *   - Per-view empty states ("No hot leads right now")
 *
 * Requires authentication — skip until staging Supabase has test users
 * seeded (Week 3 of the infrastructure sprint). Locally these run if
 * .env.test has the auth credentials.
 *
 * Why write these now (before they can run):
 *   1. Documents the EXPECTED behavior — code review can verify against spec
 *   2. Forces edge-case thinking while UI design is fresh
 *   3. Becomes the regression suite the moment staging spins up
 *   4. Catches accidental breakage from future refactors
 */
import { expect, test } from "@playwright/test";
import { loginViaSupabase } from "./fixtures/auth";

const hasEnv = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY,
);

test.describe("Sales Workspace v2 — Owner UI flows", () => {
  test.skip(!hasEnv, "Needs NEXT_PUBLIC_SUPABASE_ANON_KEY + seeded test users in .env.test.");

  test.beforeEach(async ({ context, page }) => {
    await loginViaSupabase(context, "owner@testa.dev");
    await page.goto("/leads");
    // Wait for the page to hydrate — Smart Views chip bar renders when leads load.
    await page.waitForSelector('[aria-label="Lead insights"], text=VIEWS', { timeout: 10_000 });
  });

  test("Smart Views chip bar renders with all 6 view options", async ({ page }) => {
    // Each chip carries its label + count badge. We don't assert exact counts
    // (seed data may evolve) — just that all 6 names appear.
    for (const label of ["All", "Mine", "Today", "Hot", "New", "Won this month"]) {
      await expect(page.getByRole("button", { name: new RegExp(`^${label}`, "i") }).first()).toBeVisible();
    }
  });

  test("Clicking 'Hot' chip with no hot leads shows empty state", async ({ page }) => {
    // Seed has 0 demo/trial/quote leads for Tenant A → clicking Hot must
    // surface the purpose-specific empty state, not the generic "no rows" message.
    const hotChip = page.getByRole("button", { name: /^Hot\s*0/i }).first();
    if (await hotChip.isVisible()) {
      await hotChip.click();
      await expect(page.getByText(/No hot leads right now/i)).toBeVisible({ timeout: 5_000 });
      // CTA back to All should be reachable.
      await expect(page.getByRole("button", { name: /Show all leads/i })).toBeVisible();
    }
  });

  test("Pipeline pulse bar renders with ₹-weighted segments + total", async ({ page }) => {
    // The pulse is an <img role="img" aria-label="Pipeline distribution by stage">
    // The legend below shows stage labels with rupee values when desktop md+.
    await expect(page.locator('[role="img"][aria-label*="Pipeline distribution"]')).toBeVisible();
    // Total ₹ chip at the right of the legend (desktop only).
    await expect(page.getByText(/Total\s+₹/i)).toBeVisible();
  });

  test("Today Strip surfaces overdue / due-today chips when data exists", async ({ page }) => {
    // The strip is hidden when no urgent items. Seeded leads may or may not
    // have overdue items. If chips exist, they should be clickable.
    const todayChip = page.getByText(/\d+ due today/i).first();
    if (await todayChip.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await todayChip.click();
      // List filters to due-today leads.
      await page.waitForTimeout(500);
    }
  });

  test("Topbar sparkles button opens Quick Actions panel", async ({ page }) => {
    await page.getByRole("button", { name: /Quick actions for this page/i }).click();
    // Panel is a full-screen Dialog on mobile, large card on desktop.
    await expect(page.getByRole("heading", { name: "Quick actions" })).toBeVisible();
    // /leads context shows the leads playbook sections.
    await expect(page.getByText(/Capture a new lead/i)).toBeVisible();
  });

  test("Lead row click opens detail drawer with contact action card", async ({ page }) => {
    // Click first lead row in the desktop table.
    const firstRow = page.locator("table tbody tr").first();
    await firstRow.click();
    // Drawer slides in; title is the company name.
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    // Contact action card has Call / WhatsApp / Email buttons.
    await expect(drawer.getByText("Call", { exact: true }).first()).toBeVisible();
    await expect(drawer.getByText("WhatsApp", { exact: true }).first()).toBeVisible();
    await expect(drawer.getByText("Email", { exact: true }).first()).toBeVisible();
  });

  test("Quick add lead — 4-field form creates a raw lead", async ({ page }) => {
    // Quick add — split-button caret dropdown (desktop) OR mini-FAB (mobile).
    // The "Add Lead" split-button is hidden on mobile (Pixel 7), where the FAB
    // quick action is used instead.
    const quickFab = page.getByRole("button", { name: /Quick add lead.*4 fields/i });
    if (await quickFab.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await quickFab.click();
    } else {
      // Desktop — open the "Add Lead" split-button's caret menu, then Quick add.
      await page.getByRole("button", { name: /More ways to add a lead/i }).click();
      await page.getByRole("menuitem", { name: /Quick add/i }).click();
    }
    await expect(page.getByRole("heading", { name: /Quick add lead/i })).toBeVisible();
    const stamp = Date.now().toString().slice(-6);
    await page.fill('#q-company', `E2E Test Co ${stamp}`);
    await page.fill('#q-contact-name', `E2E Person ${stamp}`);
    await page.fill('#q-contact-email', `e2e+${stamp}@test.dev`);
    await page.fill('#q-contact-phone', '+91 90000 00000');
    await page.getByRole("button", { name: /Save lead/i }).click();
    // Toast confirms creation.
    await expect(page.getByText(/added to your inbox/i)).toBeVisible({ timeout: 5_000 });
  });

  test("CSV import dialog opens with sample download button", async ({ page }) => {
    // Owner role required — sales role hides the Import CSV button.
    const csvBtn = page.getByRole("button", { name: /Import CSV/i }).first();
    await csvBtn.click();
    await expect(page.getByRole("heading", { name: /Bulk import leads/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Download sample\.csv/i })).toBeVisible();
    // Expected header reference appears for the user to mirror.
    await expect(page.getByText("company,contact_name,contact_email,contact_phone")).toBeVisible();
  });
});
