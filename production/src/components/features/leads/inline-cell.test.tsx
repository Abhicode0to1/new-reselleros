// @vitest-environment jsdom
//
// Component test for the inline cell. Per-file jsdom so the rest of the suite
// stays in the fast `node` environment (see the note in vitest.config.ts).
//
// This exists because the cell edits DEAL VALUE, which feeds the Open Pipeline
// KPI. The parsing is covered in inline-edit.test.ts; what's tested here is the
// interaction contract that decides *whether a write happens at all*:
// cancel must cancel, an invalid entry must not save, and a no-op must not write.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { InlineCell } from "./inline-cell";
import { parseRupeeInput } from "@/lib/leads/inline-edit";

afterEach(cleanup);

function renderValueCell(value: number | null, onSave = vi.fn()) {
  render(
    <InlineCell<number | null>
      value={value}
      ariaLabel="Deal value for Acme"
      display={<span>{value == null ? "—" : `₹${value}`}</span>}
      toInput={(v) => (v == null ? "" : String(v))}
      parse={parseRupeeInput}
      onSave={onSave}
    />,
  );
  return onSave;
}

const openEditor = () => {
  fireEvent.click(screen.getByRole("button", { name: /click to edit/i }));
  return screen.getByRole("textbox", { name: "Deal value for Acme" }) as HTMLInputElement;
};

describe("InlineCell — interaction contract", () => {
  it("shows the display value until clicked", () => {
    renderValueCell(50_000);
    expect(screen.getByText("₹50000")).toBeDefined();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("opens seeded with the current value", () => {
    renderValueCell(50_000);
    expect(openEditor().value).toBe("50000");
  });

  it("Enter saves the parsed value", () => {
    const onSave = renderValueCell(50_000);
    const input = openEditor();
    fireEvent.change(input, { target: { value: "1.5L" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSave).toHaveBeenCalledWith(150_000);
  });

  it("Esc cancels — and beats the blur that fires with it", () => {
    // The bug this guards: blur fires before Esc is handled, so a naive
    // implementation saves the very edit the user just abandoned.
    const onSave = renderValueCell(50_000);
    const input = openEditor();
    fireEvent.change(input, { target: { value: "999999" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText("₹50000")).toBeDefined();
  });

  it("blur saves, like every spreadsheet people already use", () => {
    const onSave = renderValueCell(50_000);
    const input = openEditor();
    fireEvent.change(input, { target: { value: "60000" } });
    fireEvent.blur(input);
    expect(onSave).toHaveBeenCalledWith(60_000);
  });

  it("an INVALID entry writes nothing and keeps the cell open with the reason", () => {
    const onSave = renderValueCell(50_000);
    const input = openEditor();
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/Enter a number/i);
    expect(screen.getByRole("textbox", { name: "Deal value for Acme" })).toBeDefined();
  });

  it("does not write when the value is unchanged", () => {
    // Opening a cell and tabbing straight out must not touch the pipeline.
    const onSave = renderValueCell(50_000);
    const input = openEditor();
    fireEvent.blur(input);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("clearing saves null, not 0 — an unpriced deal isn't a ₹0 deal", () => {
    const onSave = renderValueCell(50_000);
    const input = openEditor();
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it("is inert when disabled", () => {
    const onSave = vi.fn();
    render(
      <InlineCell<number | null>
        value={50_000} disabled ariaLabel="Deal value for Acme"
        display={<span>₹50000</span>} toInput={(v) => String(v ?? "")}
        parse={parseRupeeInput} onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /click to edit/i }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });
});
