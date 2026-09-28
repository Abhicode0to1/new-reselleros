/**
 * QA (Hitesh) — every public page opens cleanly, on desktop and on a phone.
 *
 * For each URL: no 5xx, no Next error boundary, no uncaught JS error, and on the phone
 * project no sideways scroll. Public pages only — nothing is submitted, no login.
 * Add a URL here the day a new public page ships.
 */
import { expect, test } from "@playwright/test";

const PAGES = [
  "/", "/about", "/pricing", "/privacy", "/terms", "/refund", "/why-us", "/status",
  "/buy/workspace", "/email", "/hosting", "/domains", "/ssl", "/reseller", "/reselleros",
  "/trial", "/cart", "/enquiry",
  "/login", "/signup", "/forgot-password",
];
// Not here on purpose: /assessment/[token], /project-quote/[id] — they need a real link, so
// a bare URL correctly answers 404.

for (const path of PAGES) {
  test(`Public page ${path} opens without errors`, async ({ page }, info) => {
    const jsErrors: string[] = [];
    page.on("pageerror", (e) => jsErrors.push(e.message));

    const t0 = Date.now();
    // 20s cap: a customer has left long before that. 28 Sep: /buy/workspace took 98s and
    // /enquiry 49s on the test env (every server-side DB call there waits ~25s).
    const res = await test.step(`Open ${path}`, () => page.goto(path, { waitUntil: "domcontentloaded", timeout: 20_000 }));
    await test.step("Page opens within 10 seconds", async () => {
      expect(Date.now() - t0, "milliseconds to open").toBeLessThan(10_000);
    });
    // Not "load": a slow third-party widget can hold it for 30s+ while the page is long usable.
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});

    await test.step("Server answered (no 5xx / 404)", async () => {
      expect(res, "got a response").not.toBeNull();
      expect(res!.status(), `HTTP status of ${path}`).toBeLessThan(400);
    });
    await test.step("No error screen", async () => {
      await expect(page.getByText(/Application error|Something went wrong|Internal Server Error/i)).toHaveCount(0);
    });
    await test.step("No JavaScript error", async () => {
      expect(jsErrors, "uncaught page errors").toEqual([]);
    });
    if (info.project.name === "mobile-chrome") {
      await test.step("Phone: no sideways scroll", async () => {
        const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(over, "page is wider than the phone screen by (px)").toBeLessThanOrEqual(1);
      });
    }
  });
}
