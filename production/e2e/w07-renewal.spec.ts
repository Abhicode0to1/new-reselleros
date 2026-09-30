/**
 * W7 — Renewal: reminder window → renewal quote → pay → new renewal date (R-053).
 *
 * Logged in as the OWNER of "E2E Test Co". Test data only; payment is a test UPI
 * reference (no Razorpay call, no money moves).
 *   1. an active "E2E Renewal …" subscription that renews in 5 days → it is in the
 *      "Urgent · ≤7d" bucket on /renewals (the window the reminder cadence works on)
 *   2. UI: "Generate quote" → lands on the renewal quote (is_renewal)
 *   3. UI: "Record payment" → full amount, UPI ref → "Confirm payment"
 *   4. the subscription's renewal_date moved forward by its 12-month term, state
 *      "renewed", and the renewal quote link is cleared
 */
import {
  test, expect, skipUnlessRoles, createE2ESubscription, testUtr, runTag, expectAppPage,
} from "./fixtures/roles";

function addMonths(isoDay: string, months: number): string {
  const [y, m, d] = isoDay.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  return dt.toISOString().slice(0, 10);
}

test.describe("W7 renewal → quote → pay → new date (owner)", () => {
  skipUnlessRoles(["owner"]);
  test.use({ role: "owner" });
  test.describe.configure({ timeout: 150_000 });

  test("renewal due in 5 days is renewed for a year after payment", async ({ page, db }) => {
    const plan = `E2E Renewal ${runTag()}`;
    const sub = await createE2ESubscription(db, { plan, seats: 3, mrr: 1500, startInDays: -360, renewInDays: 5 });

    // ── 1. it is in the urgent renewal window ──
    await expectAppPage(page, "/renewals", /Renewals/);
    const row = page.locator("tr").filter({ hasText: plan }).filter({ visible: true });
    await expect(row).toBeVisible({ timeout: 20_000 });

    // ── 2. generate the renewal quote ──
    await row.getByRole("button", { name: /^Generate( quote)?$/ }).click();
    await page.waitForURL(/\/quotes\/[^/]+$/, { timeout: 30_000 });
    const quoteId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop()!);
    const { data: q } = await db.from("quotes").select("is_renewal, amount").eq("id", quoteId).single();
    expect(q).toMatchObject({ is_renewal: true });
    const { data: linked } = await db.from("subscriptions").select("renewal_quote_id").eq("id", sub.id).single();
    expect(linked).toMatchObject({ renewal_quote_id: quoteId });

    // ── 3. record the payment in the UI ──
    await page.getByRole("button", { name: "Record payment", exact: true }).first().click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText(/Record (payment received|additional payment)/)).toBeVisible();
    await expect(sheet.locator("#amount")).toHaveValue(String((q as { amount: number }).amount));
    await sheet.locator("#reference").fill(testUtr());
    await sheet.getByRole("button", { name: "Confirm payment" }).click();
    await expect(page.getByText(/Renewal payment received/).first()).toBeVisible({ timeout: 30_000 });

    // ── 4. new renewal date ──
    const { data: after } = await db.from("subscriptions")
      .select("renewal_date, renewal_state, renewal_quote_id, status").eq("id", sub.id).single();
    expect(after).toMatchObject({
      renewal_date: addMonths(sub.renewalDate, 12),
      renewal_state: "renewed",
      renewal_quote_id: null,
      status: "active",
    });
  });
});
