// @vitest-environment jsdom
//
// R-024 — a long list paints one page at a time; sort and select stay honest.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";

vi.mock("@/components/providers/confirm-provider", () => ({ useAskText: () => async () => null }));

import { DataTable, type DataTableColumn } from "./data-table";

type Row = { id: string; amount: number };
const rows: Row[] = Array.from({ length: 120 }, (_, i) => ({ id: `INV-${String(i + 1).padStart(3, "0")}`, amount: i + 1 }));
const columns: DataTableColumn<Row>[] = [
  { id: "id", header: "Invoice", cell: (r) => r.id },
  { id: "amount", header: "Amount", cell: (r) => String(r.amount), sortValue: (r) => r.amount },
];

afterEach(cleanup);

function table(props: Partial<React.ComponentProps<typeof DataTable<Row>>> = {}) {
  return render(
    <DataTable<Row>
      rows={rows}
      columns={columns}
      getRowId={(r) => r.id}
      noun="invoice"
      mobileCard={(r) => <span>{r.id}</span>}
      pageSize={50}
      {...props}
    />,
  );
}
const tableRows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1); // minus header

describe("DataTable paging (R-024)", () => {
  it("paints 50 of 120, then 50 more, then the last 20 — and says how many are left", () => {
    table();
    expect(tableRows()).toHaveLength(50);
    expect(screen.getByText(/Showing 50 of 120 invoices/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load 50 more" }));
    expect(tableRows()).toHaveLength(100);
    fireEvent.click(screen.getByRole("button", { name: "Load 20 more" }));
    expect(tableRows()).toHaveLength(120);
    expect(screen.queryByRole("button", { name: /Load .* more/ })).toBeNull();
  });

  it("sorting runs over ALL rows, not just the painted page", () => {
    table();
    fireEvent.click(screen.getByRole("button", { name: /Amount/ }));   // asc
    fireEvent.click(screen.getByRole("button", { name: /Amount/ }));   // desc
    expect(within(tableRows()[0]).getByText("INV-120")).toBeTruthy();   // the largest, from page 3
    expect(tableRows()).toHaveLength(50);                                // and back to one page
  });

  it("a deep-linked row beyond the first page is put on screen", () => {
    table({ revealId: "INV-090" });
    expect(screen.getByText("INV-090", { selector: "td" })).toBeTruthy();
    expect(tableRows()).toHaveLength(90);
  });

  it("select-all ticks only the rows on screen", () => {
    const onSelectedChange = vi.fn();
    table({ selected: new Set(), onSelectedChange });
    fireEvent.click(within(screen.getByRole("table")).getByRole("checkbox", { name: "Select all" }));
    expect((onSelectedChange.mock.calls[0][0] as Set<string>).size).toBe(50);
  });
});
