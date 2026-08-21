// @vitest-environment jsdom
//
// WHAT THIS PROTECTS, AND WHY IT EXISTS
//   This chip is fed `leadsForTab` — `workspaceLeads.filter(isOpenLead)` — so it has never
//   held a won or lost lead. It was nonetheless labelled "All", with the hint "Everything
//   except junk".
//
//   On 21 Aug 2026 that cost real confusion. ANUTECH has 19 leads; the strip read 17; the
//   owner asked where the other two had gone. Nothing was broken: both were `won`, sitting
//   in the Won folder, which the chip strip had scrolled out of view. The database was
//   right, the filter was right, and one word was wrong — which is the harder kind of bug,
//   because every number on the screen was accurate.
//
//   So the wording is pinned here. A future edit shortening it back to "All" turns red.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { LeadsSmartViews } from "./leads-smart-views";
import type { Lead } from "@/lib/supabase/database.types";

afterEach(cleanup);

/** Only the fields these counts read. */
const lead = (over: Partial<Lead> = {}): Lead =>
  ({
    id: "lead-1",
    company: "Bright Systems",
    stage: "contact",
    is_junk: false,
    owner_id: "user-1",
    created_at: "2026-08-01T00:00:00Z",
    follow_up_date: null,
    expected_close_date: null,
    priority: null,
    value: 0,
    ...over,
  }) as Lead;

describe("the leads scope chip never claims to hold more than it does", () => {
  it('says "All open", not "All"', () => {
    render(<LeadsSmartViews leads={[lead()]} active="all" onChange={() => {}} />);
    /* Exact text, because "All" is what it used to say and what a tidy-up would shorten it
       back to. The count lives in a separate element, so the label stands alone. */
    expect(screen.getByText("All open")).toBeTruthy();
    expect(screen.queryByText(/^All$/)).toBeNull();
  });

  it("tells the reader where the leads it excludes actually are", () => {
    /* The hint lives inside the dropdown, which Radix does not render until it opens — so
       the menu is opened here rather than the assertion being weakened to something the
       closed trigger happens to expose. Keyboard, because user-event is not a dependency
       of this project and Radix opens a menu on Enter. */
    render(<LeadsSmartViews leads={[lead()]} active="all" onChange={() => {}} />);
    const trigger = screen.getByRole("button");
    fireEvent.keyDown(trigger, { key: "Enter" });

    /* A count that excludes something must say WHAT — otherwise the reader's only options
       are to trust it or to go looking, and on 21 Aug the answer was "go looking". */
    const hint = screen.getByText(/Every open lead/);
    expect(hint.textContent).toMatch(/won/i);
    expect(hint.textContent).toMatch(/lost/i);
    expect(hint.textContent).toMatch(/folder/i);
  });

  it("counts what it says: open leads, minus junk", () => {
    render(
      <LeadsSmartViews
        leads={[lead({ id: "a" }), lead({ id: "b" }), lead({ id: "c", is_junk: true })]}
        active="all"
        onChange={() => {}}
      />,
    );
    // Two countable, one junk. Junk has its own view and is never folded into a total.
    expect(screen.getByText("2")).toBeTruthy();
  });
});
