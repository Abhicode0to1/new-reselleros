/**
 * W13 — Salary / payroll run (R-053).
 *
 * Logged in as the OWNER of "E2E Test Co" (payroll is in the owner/manager menu).
 * Driven in the UI end to end:
 *   1. /accounting/employees → "Add employee": "E2E Employee …", monthly gross ₹30,000
 *   2. /accounting/payroll (default month = last month) → "Pay salary" → pay from the
 *      seeded "E2E Bank Current A/c" → "Pay ₹…"
 *   3. the salary_payments row exists with the net the dialog showed, the row shows
 *      "Awaiting reconcile", and the Salary Register for that month lists the employee.
 */
import { test, expect, skipUnlessRoles, runTag, expectAppPage, inr } from "./fixtures/roles";
import { E2E_BANK_NAME } from "./fixtures/e2e-roles.mjs";

test.describe("W13 payroll run (owner)", () => {
  skipUnlessRoles(["owner"]);
  test.use({ role: "owner" });
  test.describe.configure({ timeout: 150_000 });

  test("add an employee, pay last month's salary, see it in the salary register", async ({ page, db }) => {
    const name = `E2E Employee ${runTag()}`;

    // ── 1. employee ──
    await expectAppPage(page, "/accounting/employees", /Employees/);
    await page.getByRole("button", { name: "Add employee" }).filter({ visible: true }).first().click();
    await page.locator("#payroll-full-name").fill(name);
    await page.getByRole("button", { name: /CTC & Salary Breakdown/ }).click();
    await page.locator("#payroll-monthly-gross-salary-base").fill("30000");
    await page.getByRole("dialog").getByRole("button", { name: /^Save/ }).click();
    await expect(page.getByText("Employee saved").first()).toBeVisible({ timeout: 20_000 });

    const { data: emp } = await db.from("employees").select("id, monthly_gross").eq("name", name).single();
    expect(emp).toMatchObject({ monthly_gross: 30000 });
    const employeeId = (emp as { id: string }).id;

    // ── 2. pay salary ──
    await expectAppPage(page, "/accounting/payroll", /Payroll/);
    const period = await page.locator("#payroll-month").inputValue(); // YYYY-MM
    const row = page.getByRole("row").filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.getByRole("button", { name: "Pay salary" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(`Pay salary — ${name}`)).toBeVisible();
    await dialog.locator("#payroll-pay-from").selectOption({ label: E2E_BANK_NAME });
    const payButton = dialog.getByRole("button", { name: /^Pay ₹/ });
    const payLabel = (await payButton.innerText()).trim(); // "Pay ₹30,000"
    await payButton.click();
    await expect(page.getByText("Salary paid").first()).toBeVisible({ timeout: 20_000 });

    // ── 3. books + screens ──
    const { data: sal, error } = await db.from("salary_payments")
      .select("net, gross, period, paid_status").eq("employee_id", employeeId);
    expect(error).toBeNull();
    expect(sal).toHaveLength(1);
    const s = sal![0] as { net: number; gross: number; period: string };
    expect(s.gross).toBe(30000);
    expect(s.period).toBe(period);
    expect(payLabel).toBe(`Pay ${inr(s.net)}`);
    await expect(row).toContainText("Awaiting reconcile", { timeout: 20_000 });

    await expectAppPage(page, "/accounting/salary-register", /Salary Register/);
    await page.locator("#salary-register-month").fill(period);
    // Register rows are clickable <tr role="button"> (they open the payslip), not role=row.
    const regRow = page.locator("tbody tr").filter({ hasText: new RegExp(name.replace(/ /g, "\\s+"), "i") });
    await expect(regRow).toBeVisible({ timeout: 20_000 });
    await expect(regRow).toContainText(inr(s.net));
  });
});
