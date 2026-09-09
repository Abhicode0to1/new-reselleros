import { describe, it, expect } from "vitest";
import { parseDA, toMB, parseUserUsage, parseAllUserUsage } from "./index";

/**
 * DirectAdmin's classic responses are URL-encoded query strings with a couple
 * of hostile edge cases — an HTML login page when the IP isn't allowed, and an
 * `error=1` envelope on a 200. Parsing those wrong is how a real failure gets
 * read as data, so the parser is pinned here.
 */
describe("parseDA — DirectAdmin's query-string responses", () => {
  it("parses a package list (list[]=A&list[]=B) into an array", () => {
    expect(parseDA("list[]=Starter&list[]=Standard&list[]=Plus")).toEqual({
      "list[]": ["Starter", "Standard", "Plus"],
    });
  });
  it("parses scalar package details", () => {
    expect(parseDA("quota=10000&bandwidth=100000")).toEqual({
      quota: "10000",
      bandwidth: "100000",
    });
  });
  it("returns null for an HTML login page — DA's answer to a blocked IP / bad creds", () => {
    expect(parseDA("<!DOCTYPE html><html><body>Login</body></html>")).toBeNull();
    expect(parseDA("   <html>...")).toBeNull();
  });
  it("returns null for DA's error envelope, never treats it as data", () => {
    expect(parseDA("error=1&text=That%20IP%20does%20not%20exist%20in%20your%20list")).toBeNull();
  });
});

describe("toMB — quota/bandwidth values", () => {
  it("reads a plain number of MB", () => {
    expect(toMB("10000")).toBe(10000);
  });
  it("maps 'unlimited' to -1 (the site's convention), any case", () => {
    expect(toMB("unlimited")).toBe(-1);
    expect(toMB("Unlimited")).toBe(-1);
  });
  it("returns null for missing or non-numeric — never a made-up 0", () => {
    expect(toMB(undefined)).toBeNull();
    expect(toMB("abc")).toBeNull();
  });
});

describe("parseUserUsage — what an account is CONSUMING, not what it was granted", () => {
  it("reads disk and bandwidth used", () => {
    const u = parseUserUsage({ quota: "412", bandwidth: "9051" });
    expect(u.diskUsedMB).toBe(412);
    expect(u.bandwidthUsedMB).toBe(9051);
  });

  it("does NOT confuse itself with a quota — the field names are identical", () => {
    /* DA calls the USED figure `quota`, and hosting_accounts.disk_quota_mb is the
       LIMIT. This test exists so the next person renaming things has to read that
       sentence: 412 here means 412 used, never 412 allowed. */
    const u = parseUserUsage({ quota: "412", bandwidth: "0" });
    expect(u.diskUsedMB).toBe(412);
    expect(u.bandwidthUsedMB).toBe(0);
  });

  it("keeps the site's unlimited convention", () => {
    expect(parseUserUsage({ quota: "unlimited" }).diskUsedMB).toBe(-1);
  });

  it("returns null for anything DA did not say, never a made-up 0", () => {
    const u = parseUserUsage({});
    expect(u).toEqual({
      diskUsedMB: null, bandwidthUsedMB: null, domains: null,
      emails: null, databases: null, suspended: null,
    });
  });

  it("counts domains from either field name DA uses", () => {
    expect(parseUserUsage({ vdomains: "3" }).domains).toBe(3);
    expect(parseUserUsage({ domains: "5" }).domains).toBe(5);
  });

  it("reads the suspended flag in DA's several spellings", () => {
    for (const yes of ["yes", "YES", "true", "1", "on"]) {
      expect(parseUserUsage({ suspended: yes }).suspended).toBe(true);
    }
    expect(parseUserUsage({ suspended: "no" }).suspended).toBe(false);
    expect(parseUserUsage({}).suspended).toBeNull();
  });
});

describe("parseAllUserUsage — DA nests a query string inside a query string", () => {
  it("unwraps the inner encoding for every user", () => {
    /* The outer keys are usernames and each VALUE is itself URL-encoded. Parsing
       only the outer layer leaves a string where a record was expected, which
       reads as "no usage data" rather than as a bug. */
    const outer = {
      acmecorp1: "quota=412&bandwidth=9051&vdomains=1",
      acmetrial: "quota=8&bandwidth=120&suspended=yes",
    };
    const all = parseAllUserUsage(outer);
    expect(Object.keys(all).sort()).toEqual(["acmecorp1", "acmetrial"]);
    expect(all.acmecorp1.diskUsedMB).toBe(412);
    expect(all.acmecorp1.domains).toBe(1);
    expect(all.acmetrial.suspended).toBe(true);
  });

  it("drops DA's envelope keys rather than inventing a user called 'error'", () => {
    const all = parseAllUserUsage({ error: "0", text: "ok", details: "", u1: "quota=1" });
    expect(Object.keys(all)).toEqual(["u1"]);
  });

  it("skips a user whose inner payload is unreadable instead of guessing zeroes", () => {
    const all = parseAllUserUsage({ good: "quota=5", blank: "", broken: "<html>login</html>" });
    expect(Object.keys(all)).toEqual(["good"]);
  });

  it("returns an empty map, not a throw, when DA sends nothing useful", () => {
    expect(parseAllUserUsage({})).toEqual({});
  });
});

