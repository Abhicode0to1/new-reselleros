// @vitest-environment jsdom
/** TabBar turns into one dropdown only when its tabs do not fit (2 Oct 2026). */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TabBar } from "./tabs";

const ITEMS = [
  { id: "all", label: "All", count: 7 },
  { id: "active", label: "Active", count: 7 },
  { id: "expiring", label: "Expiring", count: 0 },
];

/* jsdom lays nothing out: give the bar a width and the hidden measuring row a natural width. */
function setWidths(bar: number, row: number) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("aria-hidden") ? 0 : bar;
  });
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("aria-hidden") ? row : bar;
  });
}

beforeEach(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} disconnect() {} };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("TabBar overflow", () => {
  it("stays a tab row when the tabs fit", () => {
    setWidths(800, 400);
    render(<TabBar value="all" onChange={() => {}} items={ITEMS} />);
    expect(screen.getByRole("tablist")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("becomes one dropdown, with every tab and its count, when they do not", () => {
    setWidths(300, 900);
    const onChange = vi.fn();
    render(<TabBar value="all" onChange={onChange} items={ITEMS} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(screen.queryByRole("tablist")).toBeNull();
    expect([...select.options].map((o) => o.textContent)).toEqual(["All (7)", "Active (7)", "Expiring (0)"]);
    fireEvent.change(select, { target: { value: "expiring" } });
    expect(onChange).toHaveBeenCalledWith("expiring");
  });
});
