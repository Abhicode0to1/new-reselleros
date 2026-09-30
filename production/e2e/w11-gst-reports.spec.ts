/**
 * W11 — GST reports: GSTR-1 / GSTR-3B / HSN reconcile with the invoices (R-053).
 *
 * Logged in as the ACCOUNTANT of "E2E Test Co". The spec raises one real tax invoice
 * (create_direct_invoice → generate_invoice, 18% intra-state) and then checks that
 * /accounting/gst tells the same story as the invoices table:
 *   1. the new invoice is a GSTR-1 source row: taxable ₹1,000 · CGST 9% + SGST 9% · GST ₹180
 *   2. the table footer equals Σ invoices − Σ credit notes + Σ debit notes of that day,
 *      computed independently from the DB (through RLS, as the same user)
 *   3. the downloaded GSTR-1 JSON's HSN section adds up to the same taxable and tax
 *   4. the GSTR-3B worksheet card renders for the period
 * Plus: the sales role cannot open GST reports at all.
 *
 * The period is pinned to the invoice's own invoice_date (From = To), so the test does
 * not depend on the time of day or on other data in the month.
 */
import fs from "node:fs";
import {
  test, expect, skipUnlessRoles, createE2EInvoice, invoiceDateOf, inr, runTag,
} from "./fixtures/roles";
import type { SupabaseClient } from "@supabase/supabase-js";

async function expectedTotals(db: SupabaseClient, day: string) {
  const [inv, cn, dn] = await Promise.all([
    db.from("invoices").select("taxable_value, tax_amount, amount, tax_rate")
      .eq("invoice_date", day).in("status", ["pending", "paid", "overdue"]),
    db.from("credit_notes").select("taxable_value, tax_amount").eq("credit_date", day),
    db.from("debit_notes").select("taxable_value, tax_amount").eq("debit_date", day),
  ]);
  for (const r of [inv, cn, dn]) if (r.error) throw new Error(r.error.message);
  type Row = { taxable_value: number | null; tax_amount: number | null; amount?: number | null; tax_rate?: number | null };
  const taxableOf = (r: Row) =>
    r.taxable_value ?? Math.round(((r.amount ?? 0) * 100) / (100 + (r.tax_rate ?? 18)));
  const taxOf = (r: Row) => r.tax_amount ?? (r.amount ?? 0) - taxableOf(r);
  const sum = (rows: Row[] | null, f: (r: Row) => number) => (rows ?? []).reduce((s, r) => s + f(r), 0);
  const rows = (inv.data?.length ?? 0) + (cn.data?.length ?? 0) + (dn.data?.length ?? 0);
  return {
    rows,
    taxable: sum(inv.data, taxableOf) - sum(cn.data, taxableOf) + sum(dn.data, taxableOf),
    gst: sum(inv.data, taxOf) - sum(cn.data, taxOf) + sum(dn.data, taxOf),
  };
}

test.describe("W11 GST reports reconcile with invoices (accountant)", () => {
  skipUnlessRoles(["accountant"]);
  test.use({ role: "accountant" });
  test.describe.configure({ timeout: 120_000 });

  test("new invoice → GSTR-1 row, footer = DB totals, HSN JSON = footer, 3B worksheet", async ({ page, db }) => {
    const label = `E2E GST item ${runTag()}`;
    const inv = await createE2EInvoice(db, { label, rate: 1000 });
    const day = await invoiceDateOf(db, inv.invoiceId);

    await page.goto("/accounting/gst");
    await expect(page.getByRole("heading", { name: "GST Reports" })).toBeVisible({ timeout: 20_000 });
    await page.getByLabel("From date").fill(day);
    await page.getByLabel("To date").fill(day);

    // 1 — the invoice is a GSTR-1 source row with the right split.
    const output = page.getByRole("table").filter({
      has: page.getByRole("columnheader", { name: "Invoice #" }),
    });
    const row = output.getByRole("row").filter({ hasText: inv.invoiceId });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText(inr(1000));
    await expect(row).toContainText("CGST 9% + SGST 9%");
    await expect(row).toContainText(inr(180));
    await expect(row).toContainText(inr(1180));

    // 2 + 3 — footer and the GSTR-1 JSON's HSN section both equal the DB, computed
    // independently. Retried as a unit: another spec running in parallel may raise an
    // invoice on the same day between the page load and the DB read.
    const footer = output.getByRole("row").filter({ hasText: /^\s*Total \(\d+\)/ });
    let attempt = 0;
    await expect(async () => {
      if (attempt++ > 0) {
        await page.reload();
        await page.getByLabel("From date").fill(day);
        await page.getByLabel("To date").fill(day);
      }
      const exp = await expectedTotals(db, day);
      await expect(footer).toContainText(`Total (${exp.rows})`, { timeout: 10_000 });
      await expect(footer).toContainText(inr(exp.taxable));
      await expect(footer).toContainText(inr(exp.gst));

      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("button", { name: /Download GSTR-1 JSON/ }).click(),
      ]);
      const json = JSON.parse(fs.readFileSync((await download.path())!, "utf8")) as {
        hsn?: { data?: { txval: number; iamt: number; camt: number; samt: number }[] };
      };
      const hsn = json.hsn?.data ?? [];
      expect(hsn.length, "GSTR-1 JSON has an HSN section").toBeGreaterThan(0);
      const hsnTaxable = hsn.reduce((s, r) => s + r.txval, 0);
      const hsnTax = hsn.reduce((s, r) => s + r.iamt + r.camt + r.samt, 0);
      expect(Math.round(hsnTaxable), "HSN taxable = invoices table taxable").toBe(exp.taxable);
      expect(Math.round(hsnTax), "HSN tax = invoices table GST").toBe(exp.gst);
      expect(await expectedTotals(db, day), "DB unchanged during the check").toEqual(exp);
    }).toPass({ timeout: 90_000 });

    // 4 — GSTR-3B worksheet renders for the period.
    await expect(page.getByText(/GSTR-3B worksheet/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Download worksheet/ })).toBeVisible();
  });
});

test.describe("W11 GST reports are not for sales", () => {
  skipUnlessRoles(["sales"]);
  test.use({ role: "sales" });
  test.describe.configure({ timeout: 120_000 });

  test("sales opening /accounting/gst is sent back to /leads", async ({ page }) => {
    await page.goto("/accounting/gst");
    await expect(page).toHaveURL(/\/leads/, { timeout: 15_000 });
  });
});
