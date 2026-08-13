import { describe, it, expect } from "vitest";
import { normaliseDomainInput } from "./doh";

/**
 * No network here on purpose. The live lookup was verified once against real
 * domains during development (anutech.in → 1 smtp.google.com, microsoft.com →
 * outlook.com, a bogus name → NXDOMAIN), but a permanent test that queries the
 * internet fails on a train and teaches everyone to ignore red runs.
 */
describe("normaliseDomainInput — accept what people actually paste", () => {
  it("strips a URL down to the domain", () => {
    expect(normaliseDomainInput("https://www.Anutech.in/pricing?x=1")).toBe("anutech.in");
    expect(normaliseDomainInput("http://example.co.in/")).toBe("example.co.in");
  });

  it("takes the domain out of an email address", () => {
    // Operators paste the customer's email at least as often as their domain.
    expect(normaliseDomainInput("pardeep@anutech.in")).toBe("anutech.in");
  });

  it("drops a trailing dot and leading www, and lower-cases", () => {
    expect(normaliseDomainInput("ANUTECH.IN.")).toBe("anutech.in");
    expect(normaliseDomainInput("  www.Example.COM  ")).toBe("example.com");
  });

  it("keeps multi-label domains intact", () => {
    expect(normaliseDomainInput("mail.corp.example.co.uk")).toBe("mail.corp.example.co.uk");
  });

  // ── Why the check is narrower than the DNS spec ───────────────────────────
  it("rejects anything that is not a public domain", () => {
    // This value goes into a URL that is then fetched. A permissive check is how
    // a query parameter becomes a request somewhere that is not a DNS resolver.
    for (const bad of ["", "   ", "localhost", "10.0.0.1", "not a domain", "a.b", "-bad.com", "bad-.com", "example", "http://", "example.123"]) {
      expect(normaliseDomainInput(bad), `should reject ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it("rejects null and undefined without throwing", () => {
    expect(normaliseDomainInput(null)).toBeNull();
    expect(normaliseDomainInput(undefined)).toBeNull();
  });

  it("rejects an over-long name", () => {
    expect(normaliseDomainInput(`${"a".repeat(250)}.com`)).toBeNull();
  });
});
