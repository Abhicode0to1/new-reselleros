/**
 * R-004 — the Edit project screen and the RPC agree about what is locked.
 *
 * A scan, because everything risky here is WIRING. The RPC's rules are proved by
 * `supabase/tests/update_project_details.test.sql`; what no SQL test can see is
 * whether the screen sends the right things — and the expensive mistakes are all of
 * that shape: sending an unchanged customer id and tripping the invoice guard on every
 * save, sending a schedule on a title-only edit and re-inserting milestones nobody
 * touched, or the page letting a locked milestone into the editable list.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const strip = (p: string) =>
  readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const DIALOG  = strip("src/components/features/projects/edit-project-dialog.tsx");
const PAGE    = strip("src/app/(app)/projects/[id]/page.tsx");
const QUERIES = strip("src/lib/queries/projects.ts");

describe("the page offers the edit", () => {
  it("has an Edit project button", () => {
    expect(PAGE).toContain("Edit project");
    expect(PAGE).toContain("<EditProjectDialog");
  });

  it("hands the dialog the milestones AND the payments", () => {
    /* Both, because "locked" means invoiced OR paid. With payments missing, a
       milestone somebody has already paid would appear editable and the save would be
       refused by the database with no warning on screen. */
    expect(PAGE).toContain("milestones={data.milestones}");
    expect(PAGE).toContain("payments={data.payments}");
  });
});

describe("the dialog's idea of 'locked' matches the RPC's", () => {
  it("counts a milestone as locked when it is invoiced OR paid", () => {
    expect(DIALOG).toMatch(/Boolean\(m\.invoice_id\) \|\| paidMilestoneIds\.has\(m\.id\)/);
  });

  it("only offers the unlocked ones for re-planning", () => {
    expect(DIALOG).toContain("milestones.filter((m) => !isLocked(m))");
  });

  it("requires the remaining milestones to add up to total minus locked", () => {
    expect(DIALOG).toContain("const targetSum  = totalNum - lockedSum;");
    expect(DIALOG).toContain("const scheduleOk = plannedSum === targetSum;");
  });

  it("blocks a value below what is already committed, before the round trip", () => {
    // Meeting this as a database error after typing a whole schedule is a wasted trip.
    expect(DIALOG).toContain("const belowCommitted = totalNum < lockedSum;");
    expect(DIALOG).toMatch(/!belowCommitted/);
  });
});

describe("what the dialog sends", () => {
  it("sends the customer only when it actually changed", () => {
    /* The RPC refuses a customer change once an invoice exists. Sending the unchanged
       id would trip that guard on every save of an invoiced project — the feature
       would look broken while both halves were individually correct. */
    expect(DIALOG).toContain("...(customerChanged && chosen ? { customerId, customerName: chosen.name } : {})");
  });

  it("omits the schedule when nothing about the money moved", () => {
    // Otherwise a title-only edit deletes and re-inserts milestones nobody touched.
    expect(DIALOG).toContain("...(scheduleChanged ? { milestones: milestonePayload } : {})");
  });

  it("freezes the customer picker once a tax invoice exists, and says why", () => {
    expect(DIALOG).toContain("disabled={hasInvoice}");
    expect(DIALOG).toMatch(/credit-note the invoice/i);
  });
});

describe("the mutation", () => {
  it("goes through the one RPC, not a chain of client updates", () => {
    // CLAUDE.md §17b — the total, the locked part and the re-plan must move together.
    expect(QUERIES).toContain('supabase.rpc("update_project_details"');
  });

  it("does not replace the RPC's message with a generic one", () => {
    /* Those messages name the next step ("credit-note the invoices first"). A generic
       "Could not update project" would throw that away — §24. */
    const block = QUERIES.slice(QUERIES.indexOf("useUpdateProjectDetails"));
    expect(block).toContain("if (error) throw error;");
    expect(block).not.toMatch(/throw new Error\("Could not/);
  });
});
