/**
 * W6 — Add seats to a subscription, without creating a duplicate (R-053).
 *
 * Logged in as the OWNER of "E2E Test Co". Test data only.
 *   1. an active "E2E Workspace …" subscription with 5 seats (renews in ~200 days)
 *   2. UI: /subscriptions → open it → "Manage seats" → 2 → "Add 2 seats"
 *      → lands on the pro-rata add-seats quote
 *   3. the SAME subscription now has 7 seats; the quote is flagged is_add_seats
 *   4. paying that quote (Razorpay-free: record_payment, test UTR) does NOT create a
 *      second subscription, and replaying the same payment reference is a no-op
 *   5. the drawer shows "7 licensed" and the contract-change line "Seats: 5 → 7 (+2)"
 */
import {
  test, expect, skipUnlessRoles, createE2ESubscription, testUtr, runTag, expectAppPage, e2eCustomer,
} from "./fixtures/roles";
import type { Page } from "@playwright/test";

async function openSubscription(page: Page, plan: string) {
  await expectAppPage(page, "/subscriptions", /Subscriptions/);
  const row = page.getByRole("button", { name: new RegExp(`^Open ${plan} for `) }).filter({ visible: true });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
}

test.describe("W6 seats add — no duplicate (owner)", () => {
  skipUnlessRoles(["owner"]);
  test.use({ role: "owner" });
  test.describe.configure({ timeout: 150_000 });

  test("add 2 seats → same subscription grows, paying the quote makes no second subscription", async ({ page, db }) => {
    const plan = `E2E Workspace ${runTag()}`;
    const sub = await createE2ESubscription(db, { plan, seats: 5, mrr: 5000, startInDays: -30, renewInDays: 200 });
    const cust = await e2eCustomer(db);
    const countSubs = async () => {
      const { count, error } = await db.from("subscriptions")
        .select("id", { count: "exact", head: true }).eq("customer_id", cust.id);
      if (error) throw new Error(error.message);
      return count ?? 0;
    };
    const before = await countSubs();

    // ── UI: add 2 seats ──
    await openSubscription(page, plan);
    await page.getByRole("button", { name: "Manage seats" }).click();
    await expect(page.getByText("How many additional seats?")).toBeVisible();
    await page.getByRole("spinbutton").fill("2");
    await page.getByRole("button", { name: "Add 2 seats" }).click();
    await page.waitForURL(/\/quotes\/[^/]+$/, { timeout: 30_000 });
    const quoteId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop()!);

    const { data: s1 } = await db.from("subscriptions").select("seats").eq("id", sub.id).single();
    expect(s1).toMatchObject({ seats: 7 });
    const { data: q } = await db.from("quotes").select("is_add_seats, amount, seats").eq("id", quoteId).single();
    expect(q).toMatchObject({ is_add_seats: true, seats: 2 });

    // ── pay the add-seats quote: no second subscription, replay is idempotent ──
    const ref = testUtr();
    const pay = { p_quote_id: quoteId, p_amount: (q as { amount: number }).amount, p_method: "upi", p_reference: ref, p_notes: "E2E add-seats payment (test data)" };
    const first = await db.rpc("record_payment", pay);
    expect(first.error).toBeNull();
    const replay = await db.rpc("record_payment", pay);
    expect(replay.error).toBeNull();
    expect(replay.data).toMatchObject({ already_recorded: true });
    const { count: payments } = await db.from("payments")
      .select("id", { count: "exact", head: true }).eq("quote_id", quoteId).eq("status", "received");
    expect(payments, "one payment, not two").toBe(1);
    expect(await countSubs(), "paying add-seats must not create a subscription").toBe(before);
    const { data: s2 } = await db.from("subscriptions").select("seats").eq("id", sub.id).single();
    expect(s2).toMatchObject({ seats: 7 });

    // ── drawer tells the same story ──
    await openSubscription(page, plan);
    await expect(page.getByText("7 licensed").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Seats: 5 → 7 \(\+2\)/).first()).toBeVisible();
  });
});
