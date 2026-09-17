import { describe, it, expect } from "vitest";
import { notLiveBreakdown } from "./not-live";

/**
 * The tile counted everything that was not `active` and stopped there, so one
 * paused site and one still being built read "Not live 2" — one number for two
 * situations that call for opposite reactions.
 */
describe("notLiveBreakdown", () => {
  it("separates the two that matter most", () => {
    expect(notLiveBreakdown(["suspended", "pending"])).toBe("1 paused · 1 setting up");
  });

  it("puts what needs attention first, whatever order the rows arrive in", () => {
    /* Rows come back ordered by expiry, not by how bad they are. */
    expect(notLiveBreakdown(["pending", "pending", "suspended"])).toBe("1 paused · 2 setting up");
    expect(notLiveBreakdown(["pending", "failed", "suspended"])).toBe(
      "1 paused · 1 setup failed · 1 setting up",
    );
  });

  it("says nothing when the breakdown would only restate the number", () => {
    /* A single kind under a tile reading "1" adds a word and no information. */
    expect(notLiveBreakdown(["suspended"])).toBe("1 paused");
    expect(notLiveBreakdown(["pending", "pending"])).toBe("2 setting up");
  });

  it("is undefined when nothing is wrong", () => {
    expect(notLiveBreakdown([])).toBeUndefined();
  });

  it("covers every status the table allows except active", () => {
    /* The check constraint on hosting_accounts.status is
       pending | active | suspended | expired | terminated | failed.
       A status with no word here would vanish from the breakdown while still
       being counted in the number above it. */
    const all = ["pending", "suspended", "expired", "terminated", "failed"];
    const out = notLiveBreakdown(all)!;
    expect(out).toBe("1 paused · 1 setup failed · 1 ended · 1 closed · 1 setting up");
    /* No raw identifier reaches the customer. `failed` is excluded from this
       check on purpose — "setup failed" is the plain-English phrase and happens
       to contain the status word, which is a coincidence, not a leak. */
    for (const s of ["pending", "suspended", "expired", "terminated"]) {
      expect(out, `"${s}" is a database word, not something to show`).not.toContain(s);
    }
  });

  it("ignores a status it does not know rather than inventing a word for it", () => {
    expect(notLiveBreakdown(["suspended", "something_new"])).toBe("1 paused");
  });
});
