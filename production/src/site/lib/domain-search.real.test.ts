/**
 * Domain search REAL, not faked (merge Phase-1, 1 Sep 2026) — source pins.
 * The hero box used a deterministic string-hash for AVAILABLE/TAKEN and
 * hardcoded catalogue prices. It must never regress to a guess.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const search = readFileSync(join(process.cwd(), "src/site/components/home/DomainSearch.tsx"), "utf8");
const proxy = readFileSync(join(process.cwd(), "src/app/api/domains/availability/route.ts"), "utf8");
const config = readFileSync(join(process.cwd(), "src/site/lib/config.ts"), "utf8");

describe("DomainSearch reads real availability", () => {
  it("the fake hash is gone", () => {
    expect(search).not.toContain("h % 4");
    expect(search).not.toMatch(/function taken\(/);
    expect(search).not.toMatch(/charCodeAt\(0\)\) % 997/);
  });
  it("it calls the site's availability proxy", () => {
    expect(search).toContain("/api/domains/availability");
  });
  it("it does not import the hardcoded TLD catalogue for pricing any more", () => {
    // Prices now come from the API response, not catalog.ts.
    expect(search).not.toMatch(/from "@\/lib\/data\/catalog"/);
  });
});

describe("availability proxy points at the platform via config, fails honest", () => {
  it("forwards to DOMAIN_AVAILABILITY_API and never fabricates on error", () => {
    expect(proxy).toContain("DOMAIN_AVAILABILITY_API");
    expect(proxy).toContain("502");
    expect(proxy).not.toContain("available: true"); // no invented result
  });
  it("config keeps the platform address in ONE place, on a custom domain (not run.app)", () => {
    expect(config).toContain("DOMAIN_AVAILABILITY_API");
    expect(config).toContain("app.anutech.in");
    expect(config).not.toMatch(/DOMAINS_APP_URL[\s\S]{0,120}run\.app/);
  });
});
