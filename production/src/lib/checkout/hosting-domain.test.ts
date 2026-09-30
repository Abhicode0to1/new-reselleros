import { describe, it, expect } from "vitest";
import { hostingDomain } from "./hosting-domain";

describe("hostingDomain — the one rule for a hosting domain (30 Sep 2026)", () => {
  it("accepts real domains, lower-cased", () => {
    expect(hostingDomain("yourcompany.in")).toBe("yourcompany.in");
    expect(hostingDomain("My-Shop.co.in")).toBe("my-shop.co.in");
  });
  it("forgives how people paste a site address", () => {
    expect(hostingDomain(" https://www.Acme.in/about ")).toBe("acme.in");
    expect(hostingDomain("http://acme.com/")).toBe("acme.com");
  });
  it("refuses what is not a domain name", () => {
    for (const bad of ["", "mywebsite", "acme.", ".in", "acme..in", "-acme.in", "acme-.in", "ac me.in", "acme.c", "acme.in@x"]) {
      expect(hostingDomain(bad), bad).toBeNull();
    }
    expect(hostingDomain(null)).toBeNull();
  });
});
