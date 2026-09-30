// @vitest-environment jsdom
//
// R-056: on a phone /leads always shows the list — page.tsx forces
// `effectiveView = isMobile ? "list" : view` because the board needs width. The Kanban
// button stayed live anyway: tapping it called setView("kanban"), nothing changed on
// screen, and nothing said why. A control that silently does nothing teaches people that
// controls do nothing. On mobile it is now marked unavailable and says why; on desktop it
// is exactly what it was.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const toastInfo = vi.fn();
vi.mock("sonner", () => ({ toast: { info: (...a: unknown[]) => toastInfo(...a), success: vi.fn() } }));
vi.mock("@/lib/queries/team", () => ({ useTeamMembers: () => ({ data: [] }) }));
vi.mock("@/lib/queries/leads", () => ({ fetchLeadsForExport: vi.fn() }));
vi.mock("@/components/shared/team-view-toggle", () => ({ TeamViewToggle: () => null }));
vi.mock("@/components/features/leads/leads-smart-views", () => ({ LeadsSmartViews: () => null }));

import { LeadsToolbar, type LeadsToolbarProps } from "./leads-toolbar";

afterEach(() => {
  cleanup();
  toastInfo.mockReset();
});

function props(over: Partial<LeadsToolbarProps> = {}): LeadsToolbarProps {
  const noop = () => {};
  return {
    pool: { total: 3, unassigned: 0 } as LeadsToolbarProps["pool"],
    leadMeMember: null,
    leadTeam: [],
    leadTeamMode: "mine" as LeadsToolbarProps["leadTeamMode"],
    setLeadTeamMode: noop,
    search: "",
    setSearch: noop,
    viewCounts: {} as LeadsToolbarProps["viewCounts"],
    everythingCount: 3,
    currentUser: undefined,
    duplicateCountForTab: 0,
    junkCount: 0,
    junkSuspectCount: 0,
    smartView: "all" as LeadsToolbarProps["smartView"],
    selectSmartView: noop,
    folderRows: [],
    folder: "all",
    selectFolder: noop,
    effectiveView: "list",
    setView: vi.fn(),
    activeFilterCount: 0,
    filterStages: [],
    stageFilter: [],
    setStageFilter: noop,
    priorityFilter: [],
    setPriorityFilter: noop,
    ownerFilter: [],
    setOwnerFilter: noop,
    isSales: false,
    kpiOpen: false,
    setKpiOpen: noop,
    setCsvImportOpen: noop,
    setCampaignOpen: noop,
    setGoogleImportOpen: noop,
    setShareOpen: noop,
    ...over,
  };
}

const kanbanButton = () => screen.getByRole("button", { name: /kanban/i });

describe("R-056: the Kanban toggle on a phone", () => {
  it("is marked unavailable, says why, and cannot switch the view", () => {
    const setView = vi.fn();
    render(<LeadsToolbar {...props({ isMobile: true, setView })} />);
    const btn = kanbanButton();
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.getAttribute("title")).toBe("Kanban badi screen par milta hai");
    fireEvent.click(btn);
    expect(setView).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith("Kanban badi screen par milta hai");
  });

  it("stays a normal toggle on desktop", () => {
    const setView = vi.fn();
    render(<LeadsToolbar {...props({ setView })} />);
    const btn = kanbanButton();
    expect(btn.getAttribute("aria-disabled")).toBeNull();
    expect(btn.getAttribute("title")).toBe("Kanban view — best for stage flow");
    fireEvent.click(btn);
    expect(setView).toHaveBeenCalledWith("kanban");
    expect(toastInfo).not.toHaveBeenCalled();
  });
});
