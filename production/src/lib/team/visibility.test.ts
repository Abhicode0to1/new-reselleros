import { describe, it, expect } from "vitest";
import {
  scopeOf, visibleUserIds, canSeeRecord, filterVisible,
  showsTeamToggle, idsForMode, scopeNote, type TeamMember,
} from "./visibility";

/**
 * A shape like ANUTECH's: an owner, a manager with two reps, and a rep who reports to
 * nobody in particular.
 */
const OWNER:   TeamMember = { id: "owner-1", managerId: null,      role: "owner" };
const MANAGER: TeamMember = { id: "mgr-1",   managerId: "owner-1", role: "manager" };
const REP_A:   TeamMember = { id: "rep-a",   managerId: "mgr-1",   role: "sales" };
const REP_B:   TeamMember = { id: "rep-b",   managerId: "mgr-1",   role: "sales" };
const LONER:   TeamMember = { id: "loner",   managerId: "owner-1", role: "sales_senior" };
const ALL = [OWNER, MANAGER, REP_A, REP_B, LONER];

describe("who has which scope", () => {
  it("an owner sees everything", () => {
    expect(scopeOf(OWNER, ALL)).toBe("all");
    expect(visibleUserIds(OWNER, ALL)).toBeNull();
  });

  it("somebody with reports sees a team", () => {
    expect(scopeOf(MANAGER, ALL)).toBe("team");
  });

  /**
   * The scope comes from the TREE, not the title. A senior title with nobody reporting in
   * would otherwise get a "Team view" showing one person.
   */
  it("a senior title with no reports still only sees their own", () => {
    expect(scopeOf(LONER, ALL)).toBe("own");
    expect(visibleUserIds(LONER, ALL)).toEqual(["loner"]);
  });

  it("a rep with reports sees a team, however junior the title", () => {
    /* The mirror of the case above: responsibility follows the tree. */
    const junior: TeamMember = { id: "junior", managerId: "rep-a", role: "sales" };
    const ids = visibleUserIds(REP_A, [...ALL, junior]);
    expect(ids?.sort()).toEqual(["junior", "rep-a"]);
  });
});

/**
 * ─── THE ISOLATION THE GOAL ASKS FOR ────────────────────────────────────────
 * Rep A must not see Rep B, and their manager must see both.
 */
describe("peer isolation", () => {
  it("Rep A cannot see Rep B's records", () => {
    expect(canSeeRecord(REP_A, ALL, "rep-b")).toBe(false);
  });

  it("Rep B cannot see Rep A's records either — it is symmetric", () => {
    expect(canSeeRecord(REP_B, ALL, "rep-a")).toBe(false);
  });

  it("a rep cannot see their own MANAGER's records", () => {
    /* Visibility runs downward only. Upward would make a manager's private pipeline
       readable by everyone reporting to them. */
    expect(canSeeRecord(REP_A, ALL, "mgr-1")).toBe(false);
  });

  it("the manager sees both reps and themselves", () => {
    expect(canSeeRecord(MANAGER, ALL, "rep-a")).toBe(true);
    expect(canSeeRecord(MANAGER, ALL, "rep-b")).toBe(true);
    expect(canSeeRecord(MANAGER, ALL, "mgr-1")).toBe(true);
  });

  it("the manager cannot see a peer outside their branch", () => {
    expect(canSeeRecord(MANAGER, ALL, "loner")).toBe(false);
  });

  it("the owner sees everybody", () => {
    for (const u of ALL) expect(canSeeRecord(OWNER, ALL, u.id), u.id).toBe(true);
  });
});

/**
 * ─── THE RULE THAT STOPS THIS BEING AN OUTAGE ───────────────────────────────
 * In the live books TODAY, all 25 quotes and all 12 customers have a NULL owner. A rule of
 * "you see rows assigned to you or your team" makes every one of them invisible to
 * everybody but an owner — the books vanishing from the screen while the rows sit safely in
 * the database, which looks exactly like data loss.
 */
describe("an unowned record belongs to the company", () => {
  it("is visible to everyone, including the most junior rep", () => {
    for (const nothing of [null, undefined, ""]) {
      expect(canSeeRecord(REP_A, ALL, nothing), String(nothing)).toBe(true);
    }
  });

  it("survives filtering for a rep with the narrowest scope", () => {
    const rows = [
      { id: "q1", owner: null },
      { id: "q2", owner: "rep-b" },
      { id: "q3", owner: "rep-a" },
    ];
    const seen = filterVisible(REP_A, ALL, rows, (r) => r.owner);
    expect(seen.map((r) => r.id)).toEqual(["q1", "q3"]);
  });
});

describe("filtering a list", () => {
  const rows = [
    { id: "1", owner: "rep-a" },
    { id: "2", owner: "rep-b" },
    { id: "3", owner: "mgr-1" },
    { id: "4", owner: "loner" },
  ];

  it("a rep gets only their own", () => {
    expect(filterVisible(REP_A, ALL, rows, (r) => r.owner).map((r) => r.id)).toEqual(["1"]);
  });

  it("a manager gets their branch", () => {
    expect(filterVisible(MANAGER, ALL, rows, (r) => r.owner).map((r) => r.id)).toEqual(["1", "2", "3"]);
  });

  it("an owner gets everything, unchanged", () => {
    expect(filterVisible(OWNER, ALL, rows, (r) => r.owner)).toHaveLength(4);
  });
});

/**
 * manager_id is a self-referencing column an admin edits by hand, so A→B→A is one mis-click
 * away. Without a guard the walk never returns and the page hangs with no error — far
 * harder to diagnose than a wrong list.
 */
describe("a cycle in the reporting tree does not hang", () => {
  it("survives two people managing each other", () => {
    const a: TeamMember = { id: "a", managerId: "b", role: "sales" };
    const b: TeamMember = { id: "b", managerId: "a", role: "sales" };
    const ids = visibleUserIds(a, [a, b]);
    expect(ids?.sort()).toEqual(["a", "b"]);
  });

  it("survives somebody managing themselves", () => {
    const self: TeamMember = { id: "s", managerId: "s", role: "sales" };
    expect(visibleUserIds(self, [self])).toEqual(["s"]);
  });

  it("survives a three-person loop", () => {
    const x: TeamMember = { id: "x", managerId: "z", role: "sales" };
    const y: TeamMember = { id: "y", managerId: "x", role: "sales" };
    const z: TeamMember = { id: "z", managerId: "y", role: "sales" };
    expect(visibleUserIds(x, [x, y, z])?.sort()).toEqual(["x", "y", "z"]);
  });
});

describe("the My / Team toggle", () => {
  it("is hidden when both halves would show the same rows", () => {
    /* A control that does nothing teaches people that controls do nothing. */
    expect(showsTeamToggle(REP_A, ALL)).toBe(false);
    expect(showsTeamToggle(LONER, ALL)).toBe(false);
  });

  it("is shown to a manager and to an owner", () => {
    expect(showsTeamToggle(MANAGER, ALL)).toBe(true);
    expect(showsTeamToggle(OWNER, ALL)).toBe(true);
  });

  it("'Mine' means mine even for an owner", () => {
    /* The point of the toggle is to NARROW; an owner picking "My assigned" is asking what
       is on their own plate. */
    expect(idsForMode(OWNER, ALL, "mine")).toEqual(["owner-1"]);
    expect(idsForMode(OWNER, ALL, "team")).toBeNull();
  });

  it("'Team' for a manager is their branch", () => {
    expect(idsForMode(MANAGER, ALL, "team")?.sort()).toEqual(["mgr-1", "rep-a", "rep-b"]);
  });
});

describe("the note under the toggle", () => {
  it("counts the people in scope, because 'Team view' does not say whose", () => {
    expect(scopeNote(MANAGER, ALL, "team")).toBe("You and 2 people who report to you.");
  });

  it("uses the singular for one report", () => {
    const solo = [OWNER, MANAGER, REP_A];
    expect(scopeNote(MANAGER, solo, "team")).toBe("You and 1 person who reports to you.");
  });

  it("says plainly that an owner sees everything", () => {
    expect(scopeNote(OWNER, ALL, "team")).toMatch(/Everything in this workspace/);
  });

  it("does not promise a team to somebody who has none", () => {
    expect(scopeNote(LONER, ALL, "team")).toMatch(/nobody reports to you yet/);
  });
});
