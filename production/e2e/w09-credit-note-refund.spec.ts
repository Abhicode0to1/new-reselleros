/**
 * W9 — Credit note / refund (R-053).
 *
 * Logged in as the OWNER of "E2E Test Co". Test data only ("E2E …" names, .test emails).
 *
 * Credit note (driven in the UI):
 *   invoice ₹10,000 + 18% → /invoices → More actions → Issue credit note ₹1,180
 *   → credit_notes row: taxable 1,000 + tax 180; invoice net payable 11,800 → 10,620,
 *     the row shows "Net due ₹10,620"; crediting more than what is left is refused.
 * Refund (driven in the UI):
 *   a quote paid but NOT invoiced → /payments → Payment actions → Refund payment
 *   → payment status 'refunded' with an RFV voucher number.
 *   A payment on an INVOICED quote cannot be refunded directly (credit note first).
 */
import {
  test, expect, skipUnlessRoles, createE2EInvoice, createE2EQuote, testUtr, inr, runTag, expectAppPage,
} from "./fixtures/roles";

test.describe("W9 credit note / refund (owner)", () => {
  skipUnlessRoles(["owner"]);
  test.use({ role: "owner" });
  test.describe.configure({ timeout: 120_000 });

  test("credit note on an invoice reduces what is due and nets the GST", async ({ page, db }) => {
    const inv = await createE2EInvoice(db, { label: `E2E CN item ${runTag()}`, rate: 10_000 });

    await expectAppPage(page, "/invoices", /Invoices/);
    await page.getByPlaceholder(/Invoice #, customer/).fill(inv.invoiceId);
    const row = page.getByRole("button", { name: `Open invoice ${inv.invoiceId}` }).filter({ visible: true });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Issue credit note" }).click();

    await page.locator("#note_amount").fill("1180");
    await page.locator("#note_reason_code").selectOption("overbilling");
    await page.locator("#note_reason").fill("E2E credit note — automated test");
    await page.getByRole("button", { name: /^Issue credit note ·/ }).click();
    await expect(page.getByText(/Credit note .+ issued/).first()).toBeVisible({ timeout: 20_000 });

    const { data: notes, error } = await db
      .from("credit_notes").select("id, amount, taxable_value, tax_amount").eq("invoice_id", inv.invoiceId);
    expect(error).toBeNull();
    expect(notes).toHaveLength(1);
    expect(notes![0]).toMatchObject({ amount: 1180, taxable_value: 1000, tax_amount: 180 });

    const { data: after } = await db.from("invoices").select("net_payable").eq("id", inv.invoiceId).single();
    expect((after as { net_payable: number }).net_payable).toBe(inv.gross - 1180);
    await expect(row).toContainText(`Net due ${inr(inv.gross - 1180)}`, { timeout: 20_000 });

    // Cannot credit more than what is left on the invoice.
    const over = await db.rpc("issue_credit_note", {
      p_invoice_id: inv.invoiceId, p_gross_amount: inv.gross, p_reason_code: "other",
      p_reason: "E2E over-credit must be refused", p_notes: null,
    });
    expect(over.error?.message ?? "").toMatch(/exceeds/i);
  });

  test("refund of a payment on a quote that has no invoice yet", async ({ page, db }) => {
    const q = await createE2EQuote(db, { label: `E2E Refund item ${runTag()}`, rate: 500, oneOff: true });
    const pay = await db.rpc("record_payment", {
      p_quote_id: q.quoteId, p_amount: q.gross, p_method: "upi", p_reference: testUtr(),
      p_notes: "E2E payment to be refunded (test data)",
    });
    expect(pay.error).toBeNull();
    const paymentId = (pay.data as { payment_id: string }).payment_id;

    await expectAppPage(page, "/payments", /Payments/);
    const payRow = page.getByRole("button", { name: `Open quote ${q.quoteId}` }).filter({ visible: true }).first();
    await expect(payRow).toBeVisible({ timeout: 20_000 });
    page.once("dialog", (d) => d.accept("E2E refund — automated test"));
    await payRow.getByRole("button", { name: "Payment actions" }).click();
    await page.getByRole("menuitem", { name: "Refund payment" }).click();
    await page.getByRole("button", { name: "Book refund" }).click();
    await expect(page.getByText(/Refund booked/).first()).toBeVisible({ timeout: 20_000 });

    const { data: p } = await db.from("payments").select("status, refund_voucher_no").eq("id", paymentId).single();
    expect(p).toMatchObject({ status: "refunded" });
    expect((p as { refund_voucher_no: string | null }).refund_voucher_no).toBeTruthy();
  });

  test("a payment against an invoiced quote cannot be refunded directly", async ({ db }) => {
    const inv = await createE2EInvoice(db, { label: `E2E Invoiced refund ${runTag()}`, rate: 300 });
    const pay = await db.rpc("record_payment", {
      p_quote_id: inv.quoteId, p_amount: inv.gross, p_method: "upi", p_reference: testUtr(),
      p_notes: "E2E payment on an invoiced quote (test data)",
    });
    expect(pay.error).toBeNull();
    const refund = await db.rpc("refund_payment", {
      p_payment_id: (pay.data as { payment_id: string }).payment_id,
      p_reason: "E2E should be blocked",
    });
    expect(refund.error?.message ?? "").toMatch(/CREDIT NOTE/);
  });
});
