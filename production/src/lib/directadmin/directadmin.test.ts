import { describe, it, expect } from "vitest";
import { parseDA, toMB } from "./index";

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
