/**
 * W8 — Overdue invoice → dunning (R-053).
 *
 * Logged in as the MANAGER of "E2E Test Co". No real email or WhatsApp is sent.
 *   1. an invoice whose due date is already 10 days past (quote payment terms −10 days,
 *      then generate_invoice — the app's own path; due_date is frozen once issued)
 *   2. /invoices lists it; the Accounting overview's "Unpaid Invoices" folder says
 *      invoices are past due
 *   3. the dunning engine (/api/cron/invoice-dunning in DRY-RUN mode: decides, sends
 *      nothing, logs nothing) picks this invoice with ~10 days overdue and a chase step,
 *      and invoice_dunning_log stays empty for it. There is no dunning-log screen in the
 *      app yet, so the log is checked in the table.
 *
 * Step 3 needs the target's cron secret (E2E_CRON_SECRET, or CRON_SECRET; local
 * `dev:local` uses its fixed local value). Without it that step is recorded as an
 * annotation, not skipped, and steps 1–2 still run.
 */
import {
  test, expect, skipUnlessRoles, createE2EQuote, runTag, expectAppPage,
} from "./fixtures/roles";

test.describe("W8 overdue invoice → dunning (manager)", () => {
  skipUnlessRoles(["manager"]);
  test.use({ role: "manager" });
  test.describe.configure({ timeout: 120_000 });

  test("an invoice 10 days past due is flagged and picked by the dunning engine (dry run)", async ({ page, db, request }) => {
    const q = await createE2EQuote(db, { label: `E2E Overdue item ${runTag()}`, rate: 4000, paymentTermsDays: -10 });
    const gen = await db.rpc("generate_invoice", { p_quote_id: q.quoteId });
    expect(gen.error).toBeNull();
    const invoiceId = (Array.isArray(gen.data) ? gen.data[0] : gen.data).invoice_id as string;
    const { data: inv } = await db.from("invoices").select("status, due_date, invoice_date").eq("id", invoiceId).single();
    const { status, due_date, invoice_date } = inv as { status: string; due_date: string; invoice_date: string };
    expect(["pending", "overdue"]).toContain(status);
    const daysLate = Math.round((Date.parse(invoice_date) - Date.parse(due_date)) / 86_400_000);
    expect(daysLate).toBe(10);

    // ── 2. screens ──
    await expectAppPage(page, "/invoices", /Invoices/);
    await page.getByPlaceholder(/Invoice #, customer/).fill(invoiceId);
    await expect(page.getByRole("button", { name: `Open invoice ${invoiceId}` }).filter({ visible: true }))
      .toBeVisible({ timeout: 20_000 });

    await expectAppPage(page, "/accounting", /Overview/);
    await expect(page.getByText("Unpaid Invoices").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/past due/).first()).toBeVisible({ timeout: 20_000 });

    // ── 3. dunning engine, dry run ──
    const secret = process.env.E2E_CRON_SECRET || process.env.CRON_SECRET;
    if (!secret) {
      test.info().annotations.push({
        type: "not-checked",
        description: "dunning dry-run not called: set E2E_CRON_SECRET for the target to cover it",
      });
      return;
    }
    const res = await request.get("/api/cron/invoice-dunning?dry=1", {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as {
      dry_run: boolean;
      details: { invoice_id: string; step: string; action: string; days_overdue: number }[];
    };
    expect(body.dry_run).toBe(true);
    const mine = body.details.find((d) => d.invoice_id === invoiceId);
    expect(mine, `dunning engine did not consider ${invoiceId}`).toBeTruthy();
    expect(mine!.days_overdue).toBeGreaterThanOrEqual(9);
    expect(mine!.days_overdue).toBeLessThanOrEqual(11);
    expect(mine!.step).not.toBe("none");

    const { data: logs, error } = await db.from("invoice_dunning_log").select("id").eq("invoice_id", invoiceId);
    expect(error).toBeNull();
    expect(logs, "a dry run must not write the dunning log").toHaveLength(0);
  });
});
