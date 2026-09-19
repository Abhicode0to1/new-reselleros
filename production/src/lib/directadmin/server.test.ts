import { describe, it, expect } from "vitest";
import { licenceHeadroom } from "./server";

/**
 * The only derived value in the module, and the one that could do harm: a false
 * "0 seats left" would stop sales the server can handle perfectly well.
 */

describe("licenceHeadroom", () => {
  it("subtracts, when DA gave both halves", () => {
    expect(licenceHeadroom({ users: "37", max_users: "100" })).toEqual({ used: 37, max: 100, remaining: 63 });
  });

  it("tries the other spellings DA versions use", () => {
    expect(licenceHeadroom({ num_users: "5", maxusers: "10" }).remaining).toBe(5);
    expect(licenceHeadroom({ accounts: "5", max_accounts: "10" }).remaining).toBe(5);
  });

  it("reports NULL — not zero — when DA named none of them", () => {
    /* The key spellings could not be verified against a live server, so an
       unmatched map has to mean "cannot tell". A confident 0 here would read as
       "licence full" and block provisioning on a server with room to spare. */
    expect(licenceHeadroom({ lid: "12345", expires: "2027-01-01" })).toEqual({
      used: null,
      max: null,
      remaining: null,
    });
  });

  it("reports null remaining when only one half is known", () => {
    expect(licenceHeadroom({ users: "37" }).remaining).toBeNull();
    expect(licenceHeadroom({ max_users: "100" }).remaining).toBeNull();
  });

  it("treats an unlimited licence as unlimited, not as a cap of -1 seats", () => {
    const h = licenceHeadroom({ users: "37", max_users: "unlimited" });
    expect(h.max).toBe(-1);
    /* Null, because "how many are left" has no answer — and 37 - -1 = 38 would
       be worse than no answer. */
    expect(h.remaining).toBeNull();
  });

  it("never reports a negative headroom", () => {
    /* An over-limit server is possible — the licence shrank, or DA counts
       something we don't. Zero is the honest floor. */
    expect(licenceHeadroom({ users: "120", max_users: "100" }).remaining).toBe(0);
  });

  it("skips an empty or unparseable value rather than reading it as a number", () => {
    expect(licenceHeadroom({ users: "   ", num_users: "8", max_users: "10" })).toEqual({
      used: 8,
      max: 10,
      remaining: 2,
    });
    expect(licenceHeadroom({ users: "n/a", max_users: "10" }).used).toBeNull();
  });

  it("reads a value parseDA collapsed into an array", () => {
    expect(licenceHeadroom({ users: ["37"], max_users: ["100"] }).remaining).toBe(63);
  });
});
