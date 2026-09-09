import { describe, it, expect } from "vitest";
import {
  ssoRequestBody,
  extractSsoUrl,
  SSO_DENIED_COMMANDS,
  SSO_TTL_SECONDS,
} from "./sso";

/**
 * What this function returns is a live credential into a customer's hosting
 * panel, so the tests are about the parts that would be dangerous to get wrong
 * and invisible if they were: the deny list, the single use, the expiry, and
 * refusing to treat a non-URL as a link.
 *
 * `daOneTimeLoginUrl` itself reads credentials into module constants at import
 * and is exercised through the route; these are the pure halves.
 */

const NOW = new Date("2026-09-09T12:00:00Z");

describe("the request body — the security-relevant parts", () => {
  it("denies every command that could turn a support session into permanent access", () => {
    const body = ssoRequestBody("acmecorp1", "CMD_USER_STATS", NOW);
    const denied = SSO_DENIED_COMMANDS.map((_, i) => body.get(`select_deny${i}`));
    expect(denied).toEqual([...SSO_DENIED_COMMANDS]);
    /* Named explicitly so a refactor that drops one has to change this line and
       explain itself: without these, "let me take a look for you" could become an
       account takeover the customer cannot see. */
    expect(denied).toContain("CMD_USER_PASSWD");
    expect(denied).toContain("CMD_LOGIN_KEYS");
    expect(denied).toContain("CMD_API_LOGIN_KEYS");
    expect(denied).toContain("CMD_TWO_FACTOR_AUTH");
  });

  it("is single-use and self-clearing", () => {
    const body = ssoRequestBody("acmecorp1", "CMD_USER_STATS", NOW);
    expect(body.get("max_uses")).toBe("1");
    expect(body.get("clear_key")).toBe("yes");
    expect(body.get("type")).toBe("one_time_url");
  });

  it("expires in five minutes, not the hour DMS used", () => {
    /* The button opens the panel immediately, so a longer window is only more
       time for a live credential to sit somewhere it was copied. */
    const body = ssoRequestBody("acmecorp1", "CMD_USER_STATS", NOW);
    expect(SSO_TTL_SECONDS).toBe(300);
    expect(Number(body.get("expiry_timestamp"))).toBe(Math.floor(NOW.getTime() / 1000) + 300);
  });

  it("does not notify the customer that somebody opened their panel", () => {
    expect(ssoRequestBody("acmecorp1", "CMD_USER_STATS", NOW).get("notify")).toBe("no");
  });

  it("lands on the stats page by default, not somewhere destructive", () => {
    expect(ssoRequestBody("acmecorp1", "CMD_USER_STATS", NOW).get("redirect-url")).toBe("CMD_USER_STATS");
    expect(ssoRequestBody("acmecorp1", "CMD_FILE_MANAGER", NOW).get("redirect-url")).toBe("CMD_FILE_MANAGER");
  });

  it("carries the username DA is being asked about", () => {
    expect(ssoRequestBody("acmetrial", "CMD_USER_STATS", NOW).get("user")).toBe("acmetrial");
  });
});

describe("extractSsoUrl — DA answers this endpoint in more than one shape", () => {
  it("takes a bare URL body", () => {
    expect(extractSsoUrl("https://server1.example.com/CMD_LOGIN?key=abc")).toBe(
      "https://server1.example.com/CMD_LOGIN?key=abc",
    );
  });

  it("trims trailing whitespace and any second token", () => {
    expect(extractSsoUrl("  https://s.example.com/x?k=1  \n")).toBe("https://s.example.com/x?k=1");
  });

  it("reads the JSON envelope newer DA versions send", () => {
    expect(extractSsoUrl('{"result":"https://s.example.com/CMD_LOGIN?key=z"}')).toBe(
      "https://s.example.com/CMD_LOGIN?key=z",
    );
    expect(extractSsoUrl('{"url":"https://s.example.com/u"}')).toBe("https://s.example.com/u");
  });

  it("reads DA's urlencoded envelope", () => {
    expect(extractSsoUrl("result=https%3A%2F%2Fs.example.com%2FCMD_LOGIN%3Fkey%3Dq")).toBe(
      "https://s.example.com/CMD_LOGIN?key=q",
    );
  });

  it("refuses anything that is not an http(s) URL, rather than passing it on as a link", () => {
    /* A 200 whose body is an error message must not become an href. */
    for (const junk of [
      "", "   ", "error=1&text=Unable+to+create+key",
      "<html>login page</html>", "Cannot create login key",
      '{"result":"not-a-url"}', "javascript:alert(1)", "ftp://s.example.com/x",
    ]) {
      expect(extractSsoUrl(junk)).toBeNull();
    }
  });

  it("does not mistake DA's error envelope for a result", () => {
    expect(extractSsoUrl("error=1&text=You+cannot+create+keys+for+this+user")).toBeNull();
  });
});
