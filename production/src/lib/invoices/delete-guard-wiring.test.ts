/**
 * R-014 — the app must not offer a delete the database refuses, and must not promise a
 * deletion it no longer performs.
 *
 * A source scan, not a render test. Both halves of the defect were WORDS: a menu item
 * that was always shown, and a confirmation dialog that enumerated consequences which
 * are now (correctly) impossible. Neither is visible to a unit test of any function —
 * the same shape as L98 and L85.
 *
 * The database half is proved by `supabase/tests/issued_invoice_cannot_be_deleted.test.sql`,
 * which is red-checked. This file is about what the operator sees before they get there.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/** Comments stripped: the prose explaining a removed promise must not satisfy a scan for it (L46). */
const strip = (f: string) =>
  readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const page  = strip("src/app/(app)/invoices/page.tsx");
const hooks = strip("src/lib/queries/invoices.ts");

/** SQL comments nest and use two spellings — strip both, same reason (L46). */
const sql = readFileSync("supabase/migrations/20260929130000_invoices_no_delete_once_issued.sql", "utf8");
const sqlCode = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");

describe("the menu only offers a delete that can succeed", () => {
  it("gates the destructive item on status === draft", () => {
    /* A control whose every press is a refusal teaches people to distrust the menu, and
       then somebody goes looking for another way to do it (L103). */
    expect(page).toContain('inv.status === "draft"');
    expect(page).toContain("Delete draft");
  });

  it("still shows the item for an issued invoice, disabled, pointing at the credit note", () => {
    // Hiding it entirely answers "why can I not delete this?" with silence (§24).
    expect(page).toMatch(/<DropdownMenuItem disabled/);
    expect(page).toContain("Issued — use a credit note above");
    // …and the route it names is genuinely on the same menu.
    expect(page).toContain("Issue credit note");
  });
});

describe("the confirmation no longer promises to destroy receipts", () => {
  it("does not say payments will be deleted", () => {
    /* The old copy read "N payments (₹X) recorded against this invoice will be deleted"
       and "the matched bank statement line will be un-reconciled". Both were accurate
       descriptions of the bug. */
    expect(page).not.toMatch(/payments?[^\n]{0,80}will be deleted/i);
    expect(page).not.toContain("will be un-reconciled");
  });

  it("says what actually happens to a payment instead", () => {
    expect(page).toContain("are never deleted");
    expect(page).toContain("Your bank reconciliation is left alone");
    // And where to go if the invoice genuinely must go.
    expect(page).toMatch(/Refund or remove the payments first/);
  });
});

describe("the hooks' own docstrings no longer claim a number roll-back", () => {
  it("has no 'number roll-back' left in the code", () => {
    /* `document_series.last_number` only ever rises. Calling a delete a roll-back is the
       sentence that made deleting an issued invoice sound reversible. The new docstring
       quotes the old claim in order to correct it, which is why this reads the stripped
       copy — a scan that punishes the correction is how documentation gets deleted. */
    expect(hooks).not.toContain("number roll-back");
  });

  it("no longer tells the operator a payment was reversed", () => {
    expect(hooks).not.toContain("payment reversed");
    expect(hooks).toContain("Payments recorded against it are untouched.");
  });

  it("calls both toasts a DRAFT delete", () => {
    // If the toast says "Invoice deleted" the operator will believe an issued one can go.
    expect(hooks).toContain("Draft invoice deleted — milestone re-opened");
    expect(hooks).toContain("Draft invoice deleted — quote re-opened for re-invoicing");
  });
});

describe("the migration and its test exist and agree", () => {
  it("the guard names the credit-note route in every refusal", () => {
    /* §24: a money guard that says only "not allowed" sends the operator to the database.
       Three refusals in that file — the trigger and one per RPC — and all three must
       carry the way out. */
    const refusals = sqlCode.match(/raise exception\s*\n?\s*'Invoice %/g) ?? [];
    expect(refusals.length).toBeGreaterThanOrEqual(3);
    expect((sqlCode.match(/credit note/gi) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("the trigger covers DELETE, which the freeze trigger did not", () => {
    expect(sqlCode).toContain("before delete on public.invoices");
  });

  it("the RPCs honour the same escape hatch as the trigger", () => {
    /* A hatch the trigger respects and the RPC does not works for a raw DELETE and fails
       for the sanctioned route — which is how somebody ends up deleting the row by hand,
       with no guard in the way at all. */
    expect((sqlCode.match(/app\.invoice_amend_reason/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("stops deleting project_payments", () => {
    expect(sqlCode).not.toMatch(/delete\s+from\s+public\.project_payments/);
  });
});
