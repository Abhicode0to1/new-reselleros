/**
 * W12 — Trial balance, P&L, Day Book (R-053).
 *
 * Logged in as the ACCOUNTANT of "E2E Test Co". One real tax invoice (₹2,000 + 18% GST)
 * is raised through the app's own RPC, then each book is checked against numbers the
 * spec computes itself from the DB (through RLS, as the same user):
 *   - Day Book: the invoice is a "Sales" voucher with its id and GST-inclusive amount
 *   - P&L:      Revenue for that day = Σ taxable of invoices − credit notes + debit notes
 *   - Trial Balance: Total debit = Total credit, and not zero
 */
import {
  test, expect, skipUnlessRoles, createE2EInvoice, invoiceDateOf, inr, runTag, expectAppPage,
} from "./fixtures/roles";
import type { SupabaseClient } from "@supabase/supabase-js";

async function revenueForDay(db: SupabaseClient, day: string): Promise<number> {
  const [inv, cn, dn] = await Promise.all([
    db.from("invoices").select("taxable_value").eq("invoice_date", day).in("status", ["pending", "paid", "overdue"]),
    db.from("credit_notes").select("taxable_value").eq("credit_date", day),
    db.from("debit_notes").select("taxable_value").eq("debit_date", day),
  ]);
  for (const r of [inv, cn, dn]) if (r.error) throw new Error(r.error.message);
  const s = (rows: { taxable_value: number | null }[] | null) => (rows ?? []).reduce((a, r) => a + (r.taxable_value ?? 0), 0);
  return s(inv.data) - s(cn.data) + s(dn.data);
}

test.describe("W12 books: day book, P&L, trial balance (accountant)", () => {
  skipUnlessRoles(["accountant"]);
  test.use({ role: "accountant" });
  test.describe.configure({ timeout: 120_000 });

  test("a new invoice lands in the Day Book and P&L revenue; trial balance balances", async ({ page, db }) => {
    const inv = await createE2EInvoice(db, { label: `E2E Books item ${runTag()}`, rate: 2000 });
    const day = await invoiceDateOf(db, inv.invoiceId);

    // ── Day Book ──
    await expectAppPage(page, "/accounting/day-book", /Day Book/);
    await page.getByLabel("From", { exact: true }).fill(day);
    await page.getByLabel("To", { exact: true }).fill(day);
    const voucher = page.getByRole("row").filter({ hasText: inv.invoiceId });
    await expect(voucher).toBeVisible({ timeout: 20_000 });
    await expect(voucher).toContainText("Sales");
    await expect(voucher).toContainText(inr(inv.gross)); // ₹2,360

    // ── P&L ──
    // Retried as a unit: a spec running in parallel may add an invoice on the same day.
    await expect(async () => {
      await expectAppPage(page, "/accounting/pnl", /P&L Report/);
      await page.locator("#pnl-from").fill(day);
      await page.locator("#pnl-to").fill(day);
      await expect(page.getByText(/Profit & Loss statement/).first()).toBeVisible({ timeout: 20_000 });
      const expectedRevenue = await revenueForDay(db, day);
      // Statement row = label + amount side by side (pnl/page.tsx Row).
      const revenueRow = page.locator("div.items-baseline").filter({
        has: page.getByText("Revenue", { exact: true }),
      }).first();
      await expect(revenueRow).toContainText(inr(expectedRevenue), { timeout: 10_000 });
      expect(expectedRevenue).toBeGreaterThanOrEqual(inv.taxable);
    }).toPass({ timeout: 90_000 });

    // ── Trial Balance ──
    await expectAppPage(page, "/accounting/trial-balance", /Trial Balance/);
    const total = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "Total", exact: true }) });
    await expect(total).toBeVisible({ timeout: 20_000 });
    const cells = await total.getByRole("cell").allInnerTexts();
    const money = cells.filter((c) => c.includes("₹"));
    expect(money.length, "Total row shows a debit and a credit figure").toBe(2);
    expect(money[0], "Trial balance: total debit = total credit").toBe(money[1]);
    expect(money[0]).not.toBe("₹0");
  });
});
