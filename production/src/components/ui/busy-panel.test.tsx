// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { BusyPanel } from "./busy-panel";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

const steps = ["Saving your trial request", "Emailing your confirmation link"];

describe("BusyPanel — visible progress while the server works (30 Sep 2026)", () => {
  it("renders nothing when not active", () => {
    const { container } = render(<BusyPanel active={false} title="Starting your free trial" steps={steps} />);
    expect(container.innerHTML).toBe("");
  });

  it("names the action and what is being done, as a live status for screen readers", () => {
    render(<BusyPanel active title="Starting your free trial" steps={steps} />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toContain("Starting your free trial…");
    for (const s of steps) expect(status.textContent).toContain(s);
  });

  it("counts the seconds, and says it is slow after the threshold — not before", () => {
    render(<BusyPanel active title="Starting your free trial" steps={steps} slowAfterSec={8} />);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByRole("status").textContent).toContain("3s");
    expect(screen.queryByText(/longer than usual/)).toBeNull();
    act(() => { vi.advanceTimersByTime(6000); });
    expect(screen.getByText(/longer than usual/)).toBeTruthy();
  });

  it("disappears and resets its clock when the work ends", () => {
    const { rerender, container } = render(<BusyPanel active title="T" steps={[]} />);
    act(() => { vi.advanceTimersByTime(5000); });
    rerender(<BusyPanel active={false} title="T" steps={[]} />);
    expect(container.innerHTML).toBe("");
    rerender(<BusyPanel active title="T" steps={[]} />);
    expect(screen.getByRole("status").textContent).toContain("0s");
  });
});
