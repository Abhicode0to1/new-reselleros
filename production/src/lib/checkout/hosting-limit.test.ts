import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hostingLimitProblem } from "./hosting-limit";
import { isSingleUnit } from "@/site/lib/money";

describe("one hosting account per order", () => {
  it("allows one plan, and any number of non-hosting lines", () => {
    expect(hostingLimitProblem([{ sku: "hosting:starter", qty: 1 }, { sku: "domain:in", qty: 1 }, { sku: "domain:com", qty: 1 }])).toBeNull();
    expect(hostingLimitProblem([{ sku: "domain:in", qty: 1 }])).toBeNull();
    expect(hostingLimitProblem([])).toBeNull();
  });
  it("with the switch OFF it refused two plans, naming what was found and what to do", () => {
    const m = hostingLimitProblem([{ sku: "hosting:starter", qty: 1 }, { sku: "hosting:plus", qty: 1 }], false);
    expect(m).toMatch(/2 hosting plans/);
    expect(m).toMatch(/Nothing was charged/);
    expect(m).toMatch(/separate order/);
  });
  it("with the switch ON (R-032, 1 Oct 2026) two plans are one order", () => {
    expect(hostingLimitProblem([{ sku: "hosting:starter", qty: 1 }, { sku: "hosting:plus", qty: 1 }])).toBeNull();
  });
  it("refuses one plan with quantity above 1", () => {
    expect(hostingLimitProblem([{ sku: "hosting:standard", qty: 3 }])).toMatch(/quantity 3/);
  });
  it("is not fooled by a trial line (a trial checks out on its own and is not hosting:)", () => {
    expect(hostingLimitProblem([{ sku: "hosting-trial:starter", qty: 1 }, { sku: "hosting:starter", qty: 1 }])).toBeNull();
  });
});

describe("the cart shows no quantity stepper on a hosting plan", () => {
  it("hosting, trial and domain lines are single-unit; other lines are not", () => {
    expect(isSingleUnit({ sku: "hosting:starter" })).toBe(true);
    expect(isSingleUnit({ sku: "hosting-trial:starter" })).toBe(true);
    expect(isSingleUnit({ sku: "domain:in" })).toBe(true);
    expect(isSingleUnit({ sku: "mailbox:anutech" })).toBe(false);
  });
});

describe("wiring", () => {
  it("checkout refuses before pricing, so nothing is saved or charged", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/checkout/cart-checkout.ts"), "utf8");
    const guard = src.indexOf("hostingLimitProblem(lines)");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(src.indexOf("await priceDomainLines(lines)"));
  });
});
