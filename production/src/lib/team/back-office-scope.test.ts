/**
 * Back-office staff are not sales peers, and the rule has to know that.
 *
 * ─── THE MEASUREMENT THAT FORCED THIS ────────────────────────────────────────
 * The first version scoped everybody except `owner` by the reporting tree. Run against the
 * live workspace it gave:
 *     abhishek  delivery  0 of 14 leads      pawan    delivery  0 of 14
 *     pratik    support   0 of 14            ranjeet  support   0 of 14
 * Correct by the rule and useless in practice — they own no leads and have no reports, but
 * they have to open a record to service it. Four people would have found an empty page and
 * reasonably concluded the app was broken.
 *
 * So peer isolation applies to the sales motion only. These tests are the specification of
 * that, and the numbers above are why they are not negotiable.
 */
import { describe, expect, it } from "vitest";
import { canSeeRecord, scopeOf, visibleUserIds, type TeamMember } from "./visibility";

const at = (id: string, role: string, managerId: string | null = null): TeamMember => ({
  id, managerId, role,
});

const BACK_OFFICE = ["owner", "billing", "accountant", "delivery", "support"] as const;
const SALES_MOTION = ["sales", "sales_senior", "manager"] as const;

describe("back-office roles read the whole workspace", () => {
  it.each(BACK_OFFICE)("%s sees everything, with no reports and nothing owned", (role) => {
    const me = at("me", role);
    const stranger = at("other", "sales");

    expect(scopeOf(me, [me, stranger])).toBe("all");
    /* null means "no restriction" rather than a list — see visibleUserIds. */
    expect(visibleUserIds(me, [me, stranger])).toBeNull();
    expect(canSeeRecord(me, [me, stranger], "other")).toBe(true);
  });

  it("a support user can still open a lead owned by a rep they have no relation to", () => {
    /* The concrete case: pratik@anutech.in servicing one of sales@anutech.in's 11 leads. */
    const support = at("pratik", "support");
    const rep = at("sales", "sales");

    expect(canSeeRecord(support, [support, rep], "sales")).toBe(true);
  });
});

describe("the sales motion stays scoped by the tree", () => {
  it.each(SALES_MOTION)("%s is NOT exempt", (role) => {
    const me = at("me", role);
    const peer = at("peer", "sales");

    expect(scopeOf(me, [me, peer])).toBe("own");
    expect(canSeeRecord(me, [me, peer], "peer")).toBe(false);
  });

  it("Rep A still cannot see Rep B, which is the whole point", () => {
    const a = at("a", "sales", "boss");
    const b = at("b", "sales", "boss");
    const boss = at("boss", "manager");
    const all = [a, b, boss];

    expect(canSeeRecord(a, all, "b")).toBe(false);
    expect(canSeeRecord(b, all, "a")).toBe(false);
    expect(canSeeRecord(boss, all, "a")).toBe(true);
    expect(canSeeRecord(boss, all, "b")).toBe(true);
  });

  it("a manager with no reports sees only their own — ananya's live case", () => {
    /* ananya@anutech.in: titled manager, owns no leads, nobody reports to her. 0 of 14 is
       the rule working, and the note under the toggle says why. Written down because it is
       a support call waiting to happen, not because it is a bug. */
    const ananya = at("ananya", "manager");
    const others = [at("x", "sales"), at("y", "sales")];

    expect(scopeOf(ananya, [ananya, ...others])).toBe("own");
    expect(canSeeRecord(ananya, [ananya, ...others], "x")).toBe(false);
    /* Unclaimed rows remain visible to her, as to everybody. */
    expect(canSeeRecord(ananya, [ananya, ...others], null)).toBe(true);
  });
});

describe("an unknown role is treated as back-office, not as a rep", () => {
  it("fails open on visibility rather than blanking a page", () => {
    /* A role added to the enum but not to this list — or a stale row. Failing CLOSED would
       hide the workspace from somebody whose job we have not modelled yet, which looks like
       data loss. Failing open shows them what they could already see. The security boundary
       is tenant_id, which is untouched either way, and the trade is written down here so the
       next person changing PEER_SCOPED_ROLES knows it was a choice. */
    const future = at("me", "revenue_ops");
    const rep = at("rep", "sales");

    expect(scopeOf(future, [future, rep])).toBe("all");
    expect(canSeeRecord(future, [future, rep], "rep")).toBe(true);
  });
});
