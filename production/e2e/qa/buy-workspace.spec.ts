/**
 * QA (Hitesh) — /buy/workspace price calculator.
 *
 * Automates the "Pre-check — prices" block of docs/MANUAL-TEST-SCRIPT.md plus the edge
 * cases a tester tries by hand (0, negative, over the 10,000 cap). Public page, no login,
 * nothing is submitted — safe against the online test environment.
 *
 * Titles are written as the bug card would read, because e2e/qa/run.mjs turns a failing
 * test straight into a draft card: "<title>" → Bug: <title>, steps from test.step names.
 */
import { expect, test, type Page } from "@playwright/test";

const rupees = (s: string) => Number(s.replace(/[^\d]/g, ""));

async function open(page: Page) {
  await test.step("Open /buy/workspace", async () => {
    await page.goto("/buy/workspace", { waitUntil: "domcontentloaded", timeout: 20_000 });
    await expect(page.locator("#seats")).toBeVisible();
  });
}

/** Per-user monthly price (excl GST) as printed on the plan button. */
async function planPrice(page: Page, plan: "Starter" | "Standard") {
  const btn = page.getByRole("button", { name: new RegExp(`^${plan}`) }).first();
  const m = /₹([\d,]+)\/user/.exec((await btn.innerText()) || "");
  expect(m, `${plan} button shows a ₹/user price`).not.toBeNull();
  return rupees(m![1]);
}

async function setSeats(page: Page, n: string) {
  await test.step(`Type ${n} in "For how many users?"`, async () => {
    await page.locator("#seats").fill(n);
    await page.locator("#seats").press("Tab");
  });
}

/** Headline yearly total; null when a site promo shows a struck-through price instead. */
async function yearlyTotal(page: Page) {
  const block = page.getByText("/year incl 18% GST").first().locator("..");
  if (await block.locator(".line-through").count()) return null;
  return rupees((await block.innerText()).split("/year")[0]);
}

test.describe("QA · Buy Workspace calculator", () => {
  test("Starter and Standard show their per-user price", async ({ page }) => {
    await open(page);
    expect(await planPrice(page, "Starter")).toBe(270);
    expect(await planPrice(page, "Standard")).toBe(864);
  });

  for (const [plan, seats] of [["Standard", 10], ["Standard", 25], ["Starter", 7]] as const) {
    test(`${plan} × ${seats} users total = price × users × 12 + 18% GST`, async ({ page }) => {
      await open(page);
      await test.step(`Choose ${plan}`, () => page.getByRole("button", { name: new RegExp(`^${plan}`) }).first().click());
      await setSeats(page, String(seats));
      const price = await planPrice(page, plan);
      const shown = await yearlyTotal(page);
      test.skip(shown === null, "A site promo is running — headline total is discounted");
      expect(shown).toBe(Math.round(price * seats * 12 * 1.18));
    });
  }

  for (const bad of ["0", "-5"]) {
    test(`Users box does not accept ${bad}`, async ({ page }) => {
      await open(page);
      await setSeats(page, bad);
      await expect(page.locator("#seats")).toHaveValue("1");
    });
  }

  test("Over 10,000 users the page tells the customer about the limit", async ({ page }) => {
    await open(page);
    await setSeats(page, "99999");
    await expect(page.locator("#seats")).toHaveValue("10000");
    // Found by hand on 28 Sep: the value is silently clamped. Kept as an expected failure
    // until the page says so; flip to a plain assertion once Pawan adds the message.
    test.fail(true, "Known: no message about the 10,000 limit (QA demo, 28 Sep 2026)");
    await expect(page.getByText(/10,?000/).filter({ hasNotText: "₹" }).first()).toBeVisible({ timeout: 2_000 });
  });
});
