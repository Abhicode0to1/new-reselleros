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

describe("who the session is for changes what it may do", () => {
  /* Two ways to get this wrong and they fail in opposite directions:
       · a CUSTOMER carrying the staff deny list cannot change their own hosting
         password from the panel we just sent them into — a broken product;
       · a STAFF session WITHOUT it can be turned into permanent access, which is
         the account takeover the list was written to prevent.
     So both are pinned, and the default is the locked-down one. */

  it("a STAFF session carries every denial", () => {
    const body = ssoRequestBody("acmecorp1", "CMD_USER_STATS", NOW, "staff");
    const denied = SSO_DENIED_COMMANDS.map((_, i) => body.get(`select_deny${i}`));
    expect(denied).toEqual([...SSO_DENIED_COMMANDS]);
  });

  it("STAFF is the DEFAULT, so an un-migrated caller stays locked down", () => {
    /* The signature gained a parameter on 11 Sep. Every existing call site omits
       it, and omitting it must not quietly widen a support session. */
    const body = ssoRequestBody("acmecorp1", "CMD_USER_STATS", NOW);
    expect(body.get("select_deny0")).toBe(SSO_DENIED_COMMANDS[0]);
  });

  it("a CUSTOMER session carries NO denials at all", () => {
    /* It is their own account. Every host on earth lets the owner change their
       own password and set up 2FA. */
    const body = ssoRequestBody("acmecorp1", "CMD_USER_STATS", NOW, "customer");
    for (let i = 0; i < SSO_DENIED_COMMANDS.length + 2; i++) {
      expect(body.get(`select_deny${i}`), `select_deny${i}`).toBeNull();
    }
  });

  it("everything else about the session is identical for both", () => {
    /* Single-use, self-clearing, five minutes, no email to the customer — those
       are properties of a one-time URL, not of who asked for it. Without this a
       future edit could widen the customer session's lifetime by accident. */
    const staff = ssoRequestBody("acmecorp1", "CMD_USER_STATS", NOW, "staff");
    const cust = ssoRequestBody("acmecorp1", "CMD_USER_STATS", NOW, "customer");
    for (const k of ["max_uses", "clear_key", "type", "notify", "expiry_timestamp", "user", "redirect-url"]) {
      expect(cust.get(k), k).toBe(staff.get(k));
    }
  });
});
