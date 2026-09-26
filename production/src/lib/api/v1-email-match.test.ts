import { describe, it, expect } from "vitest";
import { likeLiteral, sameEmail } from "./v1-email-match";

describe("likeLiteral", () => {
  it("escapes the LIKE wildcards and the escape character itself", () => {
    expect(likeLiteral("a_b%c@x.in")).toBe(String.raw`a\_b\%c@x.in`);
    expect(likeLiteral(String.raw`a\b@x.in`)).toBe(String.raw`a\\b@x.in`);
    expect(likeLiteral("plain@x.in")).toBe("plain@x.in");
  });
});

describe("sameEmail — the comparison that decides the match", () => {
  it("ignores case and surrounding space", () => {
    expect(sameEmail(" Asha@Example.IN ", "asha@example.in")).toBe(true);
  });
  it("a wildcard-shaped address matches only itself", () => {
    expect(sameEmail("axb@x.in", "a_b@x.in")).toBe(false);
    expect(sameEmail("anything@x.in", "*@x.in")).toBe(false);
  });
  it("nothing matches a missing email, not even another missing one", () => {
    expect(sameEmail(null, null)).toBe(false);
    expect(sameEmail("", "")).toBe(false);
  });
});
