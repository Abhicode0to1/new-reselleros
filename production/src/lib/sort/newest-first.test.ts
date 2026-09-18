import { describe, it, expect } from "vitest";
import { newestFirst } from "./newest-first";

const row = (name: string, created_at: string | null | undefined) => ({ name, created_at });

describe("newestFirst", () => {
  it("puts the most recently created row on top", () => {
    const rows = [
      row("Doodh Sang", "2026-09-10T09:00:00Z"),
      row("FF Impex", "2026-09-18T11:30:00Z"),
      row("Accesstel", "2026-08-01T07:15:00Z"),
    ];
    expect(newestFirst(rows).map((r) => r.name))
      .toEqual(["FF Impex", "Doodh Sang", "Accesstel"]);
  });

  it("does not mutate the array it was given", () => {
    // The pages pass the query's own cached array; sorting it in place would reorder
    // the React Query cache under every other consumer of that data.
    const rows = [row("B", "2026-01-02"), row("A", "2026-01-01")];
    const before = rows.map((r) => r.name);
    newestFirst(rows);
    expect(rows.map((r) => r.name)).toEqual(before);
  });

  it("keeps the previous order under rows created at the same moment", () => {
    // Bulk imports stamp every row identically. A stable sort means the A–Z the query
    // already applied survives underneath instead of being scrambled at random.
    const same = "2026-09-18T10:00:00Z";
    const rows = [row("Alpha", same), row("Beta", same), row("Gamma", same)];
    expect(newestFirst(rows).map((r) => r.name)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("sinks rows with no timestamp to the bottom", () => {
    // "We don't know when" is not "just now". Old imported rows are the likeliest to
    // be missing it, and they are the last thing that should occupy the top.
    const rows = [row("Unknown", null), row("New", "2026-09-18"), row("Old", "2020-01-01")];
    expect(newestFirst(rows).map((r) => r.name)).toEqual(["New", "Old", "Unknown"]);
  });

  it("treats an unparseable date as unknown, not as a tie", () => {
    // new Date("").getTime() is NaN, and every NaN comparison is false — a comparator
    // returning 0 for every pair would silently disable the whole sort.
    const rows = [row("Junk", ""), row("Older", "2026-01-01"), row("Newer", "2026-06-01")];
    expect(newestFirst(rows).map((r) => r.name)).toEqual(["Newer", "Older", "Junk"]);
  });

  it("reads a different column when the table names it differently", () => {
    // Invoices carry invoice_date, payments carry received_at.
    const invoices = [
      { id: "INV-1", invoice_date: "2026-03-01" },
      { id: "INV-2", invoice_date: "2026-09-01" },
    ];
    expect(newestFirst(invoices, (i) => i.invoice_date).map((i) => i.id))
      .toEqual(["INV-2", "INV-1"]);
  });

  it("handles an empty list", () => {
    expect(newestFirst([])).toEqual([]);
  });
});
