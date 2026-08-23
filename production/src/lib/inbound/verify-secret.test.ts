import { describe, it, expect } from "vitest";
import { acceptedSecrets, secretMatches } from "./verify-secret";

describe("acceptedSecrets", () => {
  it("reads a single secret", () => {
    expect(acceptedSecrets("abc123")).toEqual(["abc123"]);
  });

  it("reads two, for a rotation window", () => {
    /* The whole point: "old,new" makes both valid so neither side of the rotation has a
       moment where it is wrong. */
    expect(acceptedSecrets("old-one,new-one")).toEqual(["old-one", "new-one"]);
  });

  it("trims whitespace around each", () => {
    expect(acceptedSecrets(" old , new ")).toEqual(["old", "new"]);
  });

  it("drops blanks instead of treating them as valid", () => {
    /* "old," is a typo. Keeping the empty tail would make a request with NO key at all
       authorised — the exact opposite of what a trailing comma looks like it means. */
    expect(acceptedSecrets("old,")).toEqual(["old"]);
    expect(acceptedSecrets(",,old,,")).toEqual(["old"]);
  });

  it.each([null, undefined, "", "   ", ",", ",,"])("yields nothing for %j", (raw) => {
    expect(acceptedSecrets(raw)).toEqual([]);
  });
});

describe("secretMatches", () => {
  const both = ["old-secret-value", "new-secret-value"];

  it("accepts either secret during a rotation", () => {
    expect(secretMatches("old-secret-value", both)).toBe(true);
    expect(secretMatches("new-secret-value", both)).toBe(true);
  });

  it("rejects anything else", () => {
    expect(secretMatches("wrong", both)).toBe(false);
    expect(secretMatches("old-secret-valu", both)).toBe(false);
    expect(secretMatches("old-secret-value-x", both)).toBe(false);
  });

  it("FAILS CLOSED with no configured secret", () => {
    /* A webhook with nothing configured must not be an open one. This is the posture the
       route already had and the list must not quietly relax it. */
    expect(secretMatches("anything", [])).toBe(false);
    expect(secretMatches("", [])).toBe(false);
  });

  it.each([null, undefined, "", "   "])("rejects %j even when secrets exist", (given) => {
    expect(secretMatches(given, both)).toBe(false);
  });

  it("trims the provided value, because a query string can carry a stray space", () => {
    expect(secretMatches(" old-secret-value ", both)).toBe(true);
  });

  it("is case-sensitive", () => {
    /* These are random strings, not words. Folding case would throw away entropy. */
    expect(secretMatches("OLD-SECRET-VALUE", both)).toBe(false);
  });

  it("does not throw on a length mismatch", () => {
    /* timingSafeEqual throws when the buffers differ in length, which is why length is
       checked first. A guard that throws is a 500, and a 500 on this route makes the
       provider retry a message the idempotency claim will then skip. */
    expect(() => secretMatches("x", both)).not.toThrow();
    expect(secretMatches("x", both)).toBe(false);
  });

  it("handles non-ASCII without crashing", () => {
    expect(secretMatches("पासवर्ड", ["पासवर्ड"])).toBe(true);
    expect(secretMatches("पासवर्ड", ["password"])).toBe(false);
  });
});
