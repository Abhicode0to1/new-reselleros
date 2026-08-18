/**
 * Who the "Reports to" dropdown may offer.
 *
 * The interesting cases are all about loops. A cycle in manager_id cannot be prevented by a
 * CHECK constraint beyond the one-row case, so the picker is where it has to be stopped —
 * and a cycle does not announce itself. Both walks survive it, so nothing hangs and nothing
 * errors; the org chart just quietly stops describing the company.
 */
import { describe, expect, it } from "vitest";
import { eligibleManagers, scopeOf, visibleUserIds, type TeamMember } from "./visibility";

const member = (id: string, managerId: string | null = null, role = "sales"): TeamMember => ({
  id, managerId, role,
});

describe("eligibleManagers", () => {
  it("never offers the person themselves", () => {
    const a = member("a");
    const b = member("b");
    const ids = eligibleManagers(a, [a, b]).map((m) => m.id);

    expect(ids).not.toContain("a");
    expect(ids).toEqual(["b"]);
  });

  it("never offers a direct report — that is the obvious loop", () => {
    const boss = member("boss");
    const rep = member("rep", "boss");
    const other = member("other");

    /* Offering `rep` as boss's manager would make boss→rep→boss. */
    expect(eligibleManagers(boss, [boss, rep, other]).map((m) => m.id)).toEqual(["other"]);
  });

  it("never offers a grandchild either — the loop that gets missed", () => {
    /* A one-level check would let this through: boss → mid → junior, then boss reports to
       junior. Nothing errors, and the chart is nonsense. */
    const boss = member("boss");
    const mid = member("mid", "boss");
    const junior = member("junior", "mid");
    const outsider = member("outsider");

    const ids = eligibleManagers(boss, [boss, mid, junior, outsider]).map((m) => m.id);
    expect(ids).toEqual(["outsider"]);
    expect(ids).not.toContain("junior");
  });

  it("still offers people sideways and above", () => {
    const top = member("top");
    const mid = member("mid", "top");
    const peer = member("peer", "top");
    const junior = member("junior", "mid");

    /* mid may be re-pointed at top (unchanged), at peer (a sideways move), or at nobody.
       Only its own subtree — mid and junior — is off limits. */
    const ids = eligibleManagers(mid, [top, mid, peer, junior]).map((m) => m.id);
    expect(ids.sort()).toEqual(["peer", "top"]);
  });

  it("terminates on a tree that is ALREADY a cycle", () => {
    /* Somebody hand-edited the column, or an older build let it through. The picker must
       still render — this is exactly the moment an admin is trying to fix it, and a page
       that hangs takes away the only tool for doing so. */
    const a = member("a", "b");
    const b = member("b", "a");
    const c = member("c");

    expect(eligibleManagers(a, [a, b, c]).map((m) => m.id)).toEqual(["c"]);
    expect(eligibleManagers(b, [a, b, c]).map((m) => m.id)).toEqual(["c"]);
  });

  it("offers everybody else when the tree is empty — the state of the live data", () => {
    /* Only two users have ever had a manager_id, and both were test values now removed. So
       the common case is a flat list, and every colleague is a valid choice. */
    const all = [member("a"), member("b"), member("c")];
    expect(eligibleManagers(all[0], all).map((m) => m.id)).toEqual(["b", "c"]);
  });
});

describe("subtree extraction did not change visibility behaviour", () => {
  /* eligibleManagers and visibleUserIds now share one walk. These pin the visibility side
     so a future change to the shared helper cannot quietly widen who sees what. */
  it("an owner is still unrestricted", () => {
    const owner = member("o", null, "owner");
    expect(visibleUserIds(owner, [owner])).toBeNull();
    expect(scopeOf(owner, [owner])).toBe("all");
  });

  it("a manager still sees two levels down", () => {
    const boss = member("boss");
    const mid = member("mid", "boss");
    const junior = member("junior", "mid");

    expect(visibleUserIds(boss, [boss, mid, junior])?.sort()).toEqual(["boss", "junior", "mid"]);
    expect(visibleUserIds(junior, [boss, mid, junior])).toEqual(["junior"]);
  });
});
