import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { productCount } from "./catalog-state";

describe("productCount", () => {
  it("does not count the seeded support tiers", () => {
    expect(productCount([{ vendor: "support" }, { vendor: "support" }])).toBe(0);
    expect(productCount([{ vendor: "support" }, { vendor: "google" }])).toBe(1);
    expect(productCount(null)).toBe(0);
  });
  it("/items and /setup offer the default catalog by products, not by rows", () => {
    const items = readFileSync(join(__dirname, "../../app/(app)/items/page.tsx"), "utf8");
    const setup = readFileSync(join(__dirname, "../../app/(app)/setup/page.tsx"), "utf8");
    expect(items).toMatch(/productCount\(items\) === 0/);
    expect(setup).toMatch(/const catalogCount = productCount\(catalogItems\)/);
  });
});
