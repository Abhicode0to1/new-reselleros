/**
 * A bulk action that partly worked must SAY so.
 *
 * The failure this pins: reporting "Deleted 12 customers" when the server refused eight
 * of them. Bulk delete is N independent calls and `delete_customer` refuses anyone
 * carrying a subscription, payment, invoice, quote or project — so a partial run is the
 * NORMAL outcome here, not an edge case, and a success message over it would send the
 * operator away believing the list is clean.
 */
import { describe, it, expect } from "vitest";
import { bulkOutcomeMessage, MAX_NAMED_FAILURES } from "./bulk-outcome";

const fail = (name: string, reason = "has invoices") => ({ name, reason });

describe("bulkOutcomeMessage", () => {
  it("reports a clean run as a success, with no description to read", () => {
    const m = bulkOutcomeMessage({ done: 4, failed: [] }, "Archived");
    expect(m).toEqual({ tone: "success", title: "Archived 4 customers" });
  });

  it("says BOTH numbers when some were refused — and is a warning, not a success", () => {
    /* The defect. "Deleted 4 customers" alone reads as the whole job being done. */
    const m = bulkOutcomeMessage({ done: 4, failed: [fail("Acme"), fail("Beta")] }, "Deleted");
    expect(m.tone).toBe("warning");
    expect(m.title).toBe("Deleted 4 customers · 2 refused");
  });

  it("is an ERROR when nothing at all worked", () => {
    const m = bulkOutcomeMessage({ done: 0, failed: [fail("Acme")] }, "Deleted");
    expect(m.tone).toBe("error");
    expect(m.title).toContain("Could not");
  });

  it("NAMES the refused ones — a count alone makes the operator go hunting", () => {
    const m = bulkOutcomeMessage({ done: 1, failed: [fail("Acme"), fail("Beta")] }, "Deleted");
    expect(m.description).toContain("Acme");
    expect(m.description).toContain("Beta");
  });

  it("states a shared reason ONCE", () => {
    const m = bulkOutcomeMessage(
      { done: 0, failed: [fail("Acme", "has invoices"), fail("Beta", "has invoices")] }, "Deleted");
    /* Not "has invoices, has invoices". */
    expect(m.description!.match(/has invoices/g)).toHaveLength(1);
  });

  it("refuses to summarise DIFFERENT reasons — points at the rows instead", () => {
    /* Picking one of several reasons and printing it as though it applied to all is the
       kind of small lie that costs an afternoon. */
    const m = bulkOutcomeMessage(
      { done: 0, failed: [fail("Acme", "has invoices"), fail("Beta", "has a subscription")] }, "Deleted");
    expect(m.description).toContain("open each one to see why");
    expect(m.description).not.toContain("has invoices");
  });

  it("caps the names and counts the rest", () => {
    const many = ["A", "B", "C", "D", "E"].map((n) => fail(n));
    const m = bulkOutcomeMessage({ done: 0, failed: many }, "Deleted");
    expect(MAX_NAMED_FAILURES).toBe(3);
    expect(m.description).toContain("A, B, C and 2 more");
    expect(m.description).not.toContain("D");
  });

  it("gets the singular right — '1 customer', never '1 customers'", () => {
    expect(bulkOutcomeMessage({ done: 1, failed: [] }, "Archived").title).toBe("Archived 1 customer");
    expect(bulkOutcomeMessage({ done: 0, failed: [fail("Acme")] }, "Deleted").title)
      .toContain("1 customer");
  });

  it("takes a different noun, so the same helper serves other lists", () => {
    expect(bulkOutcomeMessage({ done: 2, failed: [] }, "Archived", "supplier").title)
      .toBe("Archived 2 suppliers");
  });

  it("reports an empty run as a clean zero rather than inventing a failure", () => {
    const m = bulkOutcomeMessage({ done: 0, failed: [] }, "Archived");
    expect(m.tone).toBe("success");
    expect(m.title).toBe("Archived 0 customers");
  });
});
