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

/* ─────────────────────────────────────────────────────────────────────────────
   "Waiting on you" — the queue the flag never had.

   The AI sales agent sets requires_human_attention, writes a reason a rep can act on, and
   stamps the time. Until 24 Aug 2026 NOTHING read any of it: the only route to a lead the
   agent had stopped on was opening that one lead and reading its timeline. The flag
   existed; the queue did not.

   Shown only when it holds something, like Duplicates and Junk. An empty accusing chip is
   one people learn to skip, and then it is not there on the day it has three in it.
   ───────────────────────────────────────────────────────────────────────────── */

describe("the Waiting on you view", () => {
  const open = (over: Partial<Lead> = {}) => lead({ stage: "contact", ...over });

  it("does not appear at all when nothing is waiting", () => {
    render(
      <LeadsSmartViews leads={[open(), open({ id: "l2" })]} active="all" onChange={() => {}} />,
    );
    fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });
    /* PROVE THE MENU OPENED FIRST. Without this the assertion below passes when the
       dropdown never rendered at all — which is exactly what happened on the first run of
       this test, because Radix opens on Enter and not on click. A negative assertion against
       a component that is not on screen is not a test. */
    expect(screen.getByText(/Every open lead/)).toBeTruthy();
    expect(screen.queryByText("Waiting on you")).toBeNull();
  });

  it("appears with the count once the agent has stopped on something", () => {
    render(
      <LeadsSmartViews
        leads={[
          open({ id: "l1", requires_human_attention: true }),
          open({ id: "l2", requires_human_attention: true }),
          open({ id: "l3" }),
        ]}
        active="all"
        onChange={() => {}}
      />,
    );
    fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });
    const row = screen.getByText("Waiting on you").closest("[role^=menuitem]");
    /* The count is the point — a view whose number you have to click to learn is the bug
       this component's own header was written about. Read off the ROW, because a bare "2"
       matches several places on this screen. */
    expect(row?.textContent).toMatch(/2/);
  });

  it("counts only OPEN leads — a won or lost handover is history", () => {
    /* Leaving closed deals in the queue is how a queue stops being read. `leads` arrives
       pre-filtered to open by the page, and this pins that the count agrees. */
    render(
      <LeadsSmartViews
        leads={[open({ id: "l1", requires_human_attention: true })]}
        active="all"
        onChange={() => {}}
      />,
    );
    fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });
    const row = screen.getByText("Waiting on you").closest("[role^=menuitem]");
    expect(row?.textContent).toMatch(/1/);
  });

  it("tells a screen reader WHICH view is in force, not just which row has a tick", () => {
    /* ─── A GLYPH IS NOT A STATE ─────────────────────────────────────────────
       The chosen row was marked by a check icon and nothing else, so the whole menu
       announced as seven identical `menuitem`s and the rep's own current filter was
       unreadable without sight. One of these rows is ALWAYS in force, which is
       `menuitemradio` + `aria-checked` — there is no DropdownMenuRadioItem in this
       app's dropdown-menu.tsx, so the role is set at the call site.

       Asserted through getByRole so the ROLE is pinned too: the sibling tests reach
       the row with a `[role^=menuitem]` prefix match, which would keep passing if the
       role silently went back to plain `menuitem`. */
    render(
      <LeadsSmartViews
        leads={[open({ id: "l1", requires_human_attention: true })]}
        active="waiting"
        onChange={() => {}}
      />,
    );
    fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });

    const chosen = screen.getByRole("menuitemradio", { name: /Waiting on you/ });
    expect(chosen.getAttribute("aria-checked")).toBe("true");

    /* And the ones NOT in force say so, rather than omitting the attribute — an absent
       aria-checked on a radio role is "not applicable", which reads as a broken group. */
    const others = screen
      .getAllByRole("menuitemradio")
      .filter((el) => el !== chosen);
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((el) => el.getAttribute("aria-checked") === "false")).toBe(true);
  });

  it("says what the view holds, in words a rep can act on", () => {
    render(
      <LeadsSmartViews
        leads={[open({ id: "l1", requires_human_attention: true })]}
        active="all"
        onChange={() => {}}
      />,
    );
    fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });
    expect(screen.getByText(/stopped and asked for a person/i)).toBeTruthy();
  });
});
