/**
 * The note under the My/Team toggle must not claim rows are "assigned to you" when they are
 * assigned to nobody.
 *
 * This is a real bug from the live books, not a hypothetical: all 23 quotes have a NULL
 * owner, unowned rows are visible to everybody by design, so "My assigned" on /quotes showed
 * 23 quotes and the note called every one of them the reader's. It also made the toggle
 * inert — both halves showed the same rows — without saying so.
 */
import { describe, expect, it } from "vitest";
import { scopeNote, type TeamMember } from "./visibility";

const member = (id: string, managerId: string | null = null, role = "sales"): TeamMember => ({
  id, managerId, role,
});

const rep = member("rep");
const owner = member("own", null, "owner");
const boss = member("boss");
const under = member("under", "boss");

describe("scopeNote with row counts", () => {
  it("does NOT say 'assigned to you' when nothing is assigned at all", () => {
    const note = scopeNote(rep, [rep], "mine", { total: 23, unassigned: 23 });

    expect(note).not.toContain("Only records assigned to you");
    expect(note).toContain("23");
    /* Names the fix, so the inert control is explained rather than merely inert. */
    expect(note).toMatch(/Set an owner/i);
  });

  it("says the same thing in Team view, because both halves really are identical", () => {
    const team = scopeNote(boss, [boss, under], "team", { total: 23, unassigned: 23 });
    const mine = scopeNote(boss, [boss, under], "mine", { total: 23, unassigned: 23 });

    expect(team).toBe(mine);
    expect(team).toContain("both views show the same 23");
  });

  it("discloses the unassigned tail when SOME rows are assigned", () => {
    /* The live leads table: 14 rows, all owned — but the moment one is unowned the reader
       needs to know their "mine" list is not purely theirs. */
    const note = scopeNote(rep, [rep], "mine", { total: 14, unassigned: 3 });

    expect(note).toContain("Only records assigned to you.");
    expect(note).toContain("Plus 3 unassigned");
    expect(note).toContain("everyone can see");
  });

  it("appends the tail to the manager and owner notes too", () => {
    expect(scopeNote(boss, [boss, under], "team", { total: 10, unassigned: 2 }))
      .toBe("You and 1 person who reports to you. Plus 2 unassigned, which everyone can see.");
    expect(scopeNote(owner, [owner], "team", { total: 10, unassigned: 2 }))
      .toContain("Everything in this workspace — you are an owner. Plus 2 unassigned");
  });

  it("stays silent about assignment when every row has an owner", () => {
    /* No noise in the common, healthy case. */
    const note = scopeNote(rep, [rep], "mine", { total: 14, unassigned: 0 });
    expect(note).toBe("Only records assigned to you.");
  });

  it("is unchanged when a caller passes no counts", () => {
    /* Back-compatible on purpose: a new call site that forgets the prop must not crash. It
       gets the old wording, which is why the prop is documented as "pass it". */
    expect(scopeNote(rep, [rep], "mine")).toBe("Only records assigned to you.");
    expect(scopeNote(owner, [owner], "team")).toBe("Everything in this workspace — you are an owner.");
  });

  it("does not divide by an empty list", () => {
    /* An empty page must not read "both views show the same 0" — there is nothing to
       explain, and the all-unassigned branch requires total > 0. */
    const note = scopeNote(rep, [rep], "mine", { total: 0, unassigned: 0 });
    expect(note).toBe("Only records assigned to you.");
  });
});
