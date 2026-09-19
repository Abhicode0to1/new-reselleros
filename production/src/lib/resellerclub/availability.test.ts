import { describe, it, expect } from "vitest";
import { parseAvailability, looksConcatenated, tldsInConcatenatedKey } from "./index";

/**
 * ResellerClub's concatenated-key quirk, ported from DMS's `searchDomainWithTlds`
 * on 10 Sep 2026.
 *
 * Asked for one name across several TLDs, RC occasionally answers with a single
 * key naming all of them — `{"acme.com,net,org": {status: "available"}}` —
 * instead of one key per domain. Our reader took that as a domain literally
 * called `acme.com,net,org`, so the route's per-TLD lookups all missed and the
 * search returned an EMPTY result set with HTTP 200: no rows, no error, for a
 * name that might be entirely free.
 *
 * It is rare enough in the wild that these tests are the only thing keeping it
 * handled, which is why they are here and not just in the module's comment.
 */

describe("looksConcatenated", () => {
  it("spots the malformed key and leaves normal ones alone", () => {
    expect(looksConcatenated("acme.com,net,org")).toBe(true);
    expect(looksConcatenated("acme.com")).toBe(false);
    expect(looksConcatenated("acme.co.in")).toBe(false);
  });
});

describe("tldsInConcatenatedKey — which TLDs went unanswered", () => {
  it("takes the TLD off the first part and the bare rest", () => {
    expect(tldsInConcatenatedKey("acme.com,net,org", "acme")).toEqual(["com", "net", "org"]);
  });

  it("handles a multi-level TLD in the leading part", () => {
    expect(tldsInConcatenatedKey("acme.co.in,com", "acme")).toEqual(["co.in", "com"]);
  });

  it("still finds the TLD when the leading part is not the name we asked about", () => {
    /* Defensive: RC's key should start with the searched name, and if it does
       not, splitting on the first dot is still the best reading available. */
    expect(tldsInConcatenatedKey("other.com,net", "acme")).toEqual(["com", "net"]);
  });

  it("lower-cases and trims, because the key is not always tidy", () => {
    expect(tldsInConcatenatedKey("acme.COM, Net , ORG", "acme")).toEqual(["com", "net", "org"]);
  });

  it("survives a key with a trailing comma", () => {
    expect(tldsInConcatenatedKey("acme.com,net,", "acme")).toEqual(["com", "net"]);
  });
});

describe("parseAvailability", () => {
  it("reads the normal shape", () => {
    const got = parseAvailability(
      {
        "acme.com": { status: "available" },
        "acme.net": { status: "regthroughothers" },
      },
      "acme",
    );
    expect(got.needsRetry).toEqual([]);
    expect(got.entries).toEqual([
      { domain: "acme.com", available: true },
      { domain: "acme.net", available: false },
    ]);
  });

  it("treats only `available` as available", () => {
    /* RC has several words for taken and inventing a new one must not read as
       free. Anything that is not exactly "available" is not. */
    for (const status of ["regthroughothers", "regthroughus", "unknown", "invalid", ""]) {
      expect(parseAvailability({ "acme.com": { status } }, "acme").entries[0].available).toBe(false);
    }
  });

  it("does NOT emit a domain named after the concatenated key", () => {
    /* The actual bug: this entry used to be produced, and then no lookup for
       acme.com / acme.net / acme.org could ever match it. */
    const got = parseAvailability({ "acme.com,net,org": { status: "available" } }, "acme");
    expect(got.entries).toEqual([]);
    expect(got.entries.map((e) => e.domain)).not.toContain("acme.com,net,org");
  });

  it("reports the concatenated TLDs as needing an individual ask", () => {
    const got = parseAvailability({ "acme.com,net,org": { status: "available" } }, "acme");
    expect(got.needsRetry).toEqual(["com", "net", "org"]);
  });

  it("does not spread the single status across the three names", () => {
    /* One answer to a question about three domains. Copying "available" onto all
       three would be inventing availability for two of them — and an invented
       AVAILABLE is a customer paying for a name that cannot be registered. */
    const got = parseAvailability({ "acme.com,net,org": { status: "available" } }, "acme");
    expect(got.entries.filter((e) => e.available === true)).toEqual([]);
  });

  it("keeps the good keys when only some of the response is malformed", () => {
    const got = parseAvailability(
      {
        "acme.in": { status: "available" },
        "acme.com,net": { status: "regthroughothers" },
      },
      "acme",
    );
    expect(got.entries).toEqual([{ domain: "acme.in", available: true }]);
    expect(got.needsRetry).toEqual(["com", "net"]);
  });

  it("ignores non-object values rather than throwing on them", () => {
    const got = parseAvailability(
      { "acme.com": { status: "available" }, "acme.net": undefined } as Record<
        string,
        { status?: string } | undefined
      >,
      "acme",
    );
    expect(got.entries).toHaveLength(1);
  });

  it("returns nothing for an empty response, and asks for nothing", () => {
    expect(parseAvailability({}, "acme")).toEqual({ entries: [], needsRetry: [] });
  });
});
