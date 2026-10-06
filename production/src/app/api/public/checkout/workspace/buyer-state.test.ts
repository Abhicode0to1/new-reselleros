import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* R-173 (6 Oct 2026). The Google Workspace "Buy now" path never collected the buyer's state and
   never wrote one to the lead, so record_payment created a customer with no state_code and
   generate_invoice refused its GST invoice ("no state on record"). These pin both halves: the
   page asks for it, the route refuses before saving or charging, and the lead carries it. */
const route = readFileSync(join(process.cwd(), "src/app/api/public/checkout/workspace/route.ts"), "utf8");
const page = readFileSync(join(process.cwd(), "src/app/(public)/buy/workspace/buy-workspace-client.tsx"), "utf8");

describe("Workspace Buy now — buyer state (R-173)", () => {
  it("the route resolves the state like the cart checkout and refuses without one", () => {
    expect(route).toMatch(/resolveStateCode\(\{ stateCode: stateCodeFromName\(parsed\.data\.stateCode\), gstin: validGstin \}\)/);
    expect(route).toMatch(/if \(!buyerStateCode\) \{[\s\S]{0,400}needState: true/);
  });

  it("the refusal comes before the lead is saved (nothing half-created, nothing charged)", () => {
    expect(route.indexOf("needState: true")).toBeGreaterThan(-1);
    expect(route.indexOf("needState: true")).toBeLessThan(route.indexOf('from("leads").insert'));
  });

  it("the lead carries state_code, state and only a valid GSTIN — record_payment copies them", () => {
    expect(route).toMatch(/state_code:\s+buyerStateCode,/);
    expect(route).toMatch(/state:\s+buyerState,/);
    expect(route).toMatch(/gstin:\s+validGstin,/);
  });

  it("the Buy now form has a required state select unless a valid GSTIN gives it", () => {
    expect(page).toMatch(/htmlFor="buy-state"/);
    expect(page).toMatch(/if \(!v\.stateCode && !stateCodeFromGstin\(v\.gstin\)\)/);
  });
});
