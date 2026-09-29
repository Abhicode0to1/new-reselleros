import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { badgesFromCounts, NAV_BADGE_KEYS } from "./nav-badge-counts";

/* S16 (28 Sep 2026): the sidebar used ~10 requests per tab per minute. The counts now come
   from one rpc, nav_badges(); supabase/tests/nav_badges.test.sql proves the SQL counts.
   This file proves the client half: the mapping, and that the hook stayed one call. */

describe("badgesFromCounts", () => {
  it("shows a badge only for counts above zero", () => {
    expect(
      badgesFromCounts({ leads: 3, enquiries: 0, deals: 1, tasks: 0, renewals: 12, invoices: 0, payments: 2, quotes: 1 }),
    ).toEqual({ leads: "3", deals: "1", renewals: "12", payments: "2", quotes: "1" });
  });

  it("a clean day is a clean sidebar", () => {
    expect(badgesFromCounts({ leads: 0, enquiries: 0, deals: 0, tasks: 0, renewals: 0, invoices: 0, payments: 0, quotes: 0 })).toEqual({});
  });

  it("tolerates a missing, null or malformed response instead of throwing in the sidebar", () => {
    expect(badgesFromCounts(null)).toEqual({});
    expect(badgesFromCounts(undefined)).toEqual({});
    expect(badgesFromCounts("x")).toEqual({});
    expect(badgesFromCounts({ leads: "4", tasks: null, deals: "abc" })).toEqual({ leads: "4" });
  });

  it("ignores keys the rpc does not own (support/whatsapp are not counted yet)", () => {
    expect(badgesFromCounts({ support: 9, whatsapp: 9, leads: 1 })).toEqual({ leads: "1" });
  });

  it("maps exactly the keys the migration returns", () => {
    const sql = readFileSync(
      join(process.cwd(), "supabase", "migrations", "20260928130000_nav_badges.sql"), "utf8",
    );
    const returned = [...sql.matchAll(/^\s*'([a-z]+)',\s/gm)].map((m) => m[1]).sort();
    expect(returned).toEqual([...NAV_BADGE_KEYS].sort());
  });
});

describe("useNavBadges stays one round trip", () => {
  const src = readFileSync(join(process.cwd(), "src", "lib", "hooks", "useNavBadges.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("calls the nav_badges rpc once and no table directly", () => {
    expect(code.match(/\.rpc\(/g)?.length).toBe(1);
    expect(code).toMatch(/\.rpc\(\s*"nav_badges"/);
    expect(code).not.toMatch(/\.from\(/);
  });

  it("does not re-fetch who is asking — role comes from useCurrentUser", () => {
    expect(code).not.toMatch(/auth\.getUser/);
    expect(code).toMatch(/useCurrentUser\(\)/);
    expect(code).toMatch(/tiersApprovableBy\(/);
  });

  it("does not poll from a hidden tab", () => {
    expect(code).toMatch(/refetchIntervalInBackground\s*:\s*false/);
  });
});
