import { describe, it, expect } from "vitest";
import { genUsername, genPassword } from "./provision";

/**
 * The account-creating side of DirectAdmin is irreversible, so the two pure
 * helpers that decide the account's identity and secret are pinned here. The
 * network functions aren't unit-tested (they'd create real accounts); they are
 * exercised once, by hand, against a throwaway domain before going live.
 */
describe("genUsername — deterministic, DirectAdmin-legal", () => {
  it("is stable for the same domain (idempotency depends on this)", () => {
    expect(genUsername("sharmatraders.in")).toBe(genUsername("sharmatraders.in"));
  });
  it("differs for look-alike domains on different TLDs", () => {
    expect(genUsername("acme.in")).not.toBe(genUsername("acme.com"));
  });
  it("starts with a letter and is 4–16 lowercase alphanumerics", () => {
    for (const d of ["123-numbers.in", "a.co", "verylongbusinessname-example.com", "x_y.in"]) {
      const u = genUsername(d);
      expect(u).toMatch(/^[a-z][a-z0-9]{3,15}$/);
    }
  });
});

describe("genPassword — meets DA complexity", () => {
  it("has upper, lower, digit and symbol, and a sane length", () => {
    for (let i = 0; i < 20; i++) {
      const p = genPassword();
      expect(p.length).toBeGreaterThanOrEqual(12);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[^A-Za-z0-9]/);
    }
  });
  it("is different each call", () => {
    expect(genPassword()).not.toBe(genPassword());
  });
});
