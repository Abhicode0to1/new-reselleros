// @vitest-environment jsdom
/** R-118 — a KPI / StatStrip tile with href is a real link to its records. */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { KPI } from "./kpi";
import { StatStrip } from "./stat-strip";

afterEach(cleanup);

describe("KPI href", () => {
  it("renders a link to the list when href is given", () => {
    render(<KPI label="Won this month" value="₹2.3K" href="/deals?view=won-mtd" />);
    const a = screen.getByRole("link");
    expect(a.getAttribute("href")).toBe("/deals?view=won-mtd");
    expect(a.textContent).toContain("Won this month");
  });
  it("stays a plain tile without href or onClick", () => {
    render(<KPI label="Weighted" value="₹480" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("StatStrip href", () => {
  it("renders linked stats as links and plain ones as text", () => {
    render(<StatStrip items={[
      { label: "Drafts to send", value: 3, href: "/quotes?tab=draft" },
      { label: "Customers", value: 9 },
    ]} />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("/quotes?tab=draft");
  });
});
