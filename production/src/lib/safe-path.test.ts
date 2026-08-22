import { describe, it, expect } from "vitest";
import { isAppPath, appPathOr } from "./safe-path";

/* This guards a real open redirect. Until 22 Aug 2026 the login page did
   `window.location.href = searchParams.get("next")` with no check at all, so
   /login?next=https://evil.com walked the operator off-site immediately after they typed
   their password — the worst possible moment for it. */
describe("what must never be treated as one of our paths", () => {
  it("rejects an absolute URL — the actual hole", () => {
    expect(isAppPath("https://evil.com")).toBe(false);
    expect(isAppPath("http://evil.com/x")).toBe(false);
    /* Case and scheme variations, because a checker that only knows "https" is theatre. */
    expect(isAppPath("HTTPS://evil.com")).toBe(false);
    expect(isAppPath("javascript:alert(1)")).toBe(false);
    expect(isAppPath("data:text/html,x")).toBe(false);
  });

  it("rejects a protocol-relative URL", () => {
    /* "//evil.com" has no scheme and looks like a path. The browser reads the part after
       the slashes as a HOST. */
    expect(isAppPath("//evil.com")).toBe(false);
    expect(isAppPath("//evil.com/quotes")).toBe(false);
  });

  it("rejects a backslash, which browsers normalise into the case above", () => {
    /* The gap in the copy this replaced: lib/push/payload.ts stopped at "//". A checker
       that stops there looks complete and is not — "/\evil.com" becomes "//evil.com" once
       the browser normalises it. */
    expect(isAppPath("/\\evil.com")).toBe(false);
    expect(isAppPath("/\\/evil.com")).toBe(false);
  });

  it("rejects control characters", () => {
    /* A newline in a path can split a Location header. No internal path needs one. */
    expect(isAppPath("/quotes\nSet-Cookie: x=1")).toBe(false);
    expect(isAppPath("/quotes\r\nx")).toBe(false);
  });

  it("rejects nothing-at-all", () => {
    expect(isAppPath(null)).toBe(false);
    expect(isAppPath(undefined)).toBe(false);
    expect(isAppPath("")).toBe(false);
    /* A bare path-less string is not a path. */
    expect(isAppPath("dashboard")).toBe(false);
  });
});

describe("what must still work, because over-blocking breaks the feature", () => {
  it("allows an ordinary internal path", () => {
    expect(isAppPath("/dashboard")).toBe(true);
    expect(isAppPath("/quotes/Q-ADPL-2026-27-0026")).toBe(true);
  });

  it("keeps the query string", () => {
    /* The reason this matters today: "Lifetime paid" links to /payments?customer=<id>.
       Dropping the query turns "open the payments behind this number" into "open
       payments", which looks like the link is broken. */
    expect(isAppPath("/payments?customer=b3e0d7a7-3e3d-4dbb-991e-d74de662c483")).toBe(true);
    expect(isAppPath("/leads?view=all&tab=hot")).toBe(true);
  });

  it("keeps a fragment", () => {
    expect(isAppPath("/settings#notifications")).toBe(true);
  });
});

describe("appPathOr", () => {
  it("passes a good path through untouched", () => {
    expect(appPathOr("/payments?customer=abc")).toBe("/payments?customer=abc");
  });

  it("substitutes the fallback for anything else", () => {
    expect(appPathOr("https://evil.com")).toBe("/dashboard");
    expect(appPathOr(null)).toBe("/dashboard");
    expect(appPathOr("//evil.com", "/leads")).toBe("/leads");
  });
});
