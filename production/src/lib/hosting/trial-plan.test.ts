import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isTrialPlan, TRIAL_PLAN_ID } from "./trial-plan";

const src = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");

describe("only Starter has a free trial (owner, 24 Sep 2026)", () => {
  it("Starter is eligible, the others are not", () => {
    expect(isTrialPlan("starter")).toBe(true);
    expect(isTrialPlan(" Starter ")).toBe(true);
    for (const p of ["standard", "plus", "", null, undefined, "hosting-starter"]) expect(isTrialPlan(p), String(p)).toBe(false);
  });

  it("the trial API accepts no plan but Starter, so a direct POST cannot start a Plus trial", () => {
    const api = src("app/api/public/trial/hosting/route.ts");
    expect(api).toMatch(/isTrialPlan\(/);
    expect(api).not.toMatch(/z\.enum\(\["starter", "standard", "plus"\]\)/);
  });

  it("the confirm route never provisions a non-trial plan, even from an older lead", () => {
    expect(src("app/api/public/trial/hosting/confirm/route.ts")).toMatch(/isTrialPlan\(/);
  });

  it("the /hosting page offers the trial button only on the trial plan", () => {
    const page = src("site/components/hosting/HostingLanding.tsx");
    expect(page).toMatch(/isTrialPlan\(p\.name\)/);
    expect(page).not.toMatch(/trial on any plan/i);
  });

  it("the trial form has no plan picker; it always asks for the trial plan", () => {
    const form = src("site/components/hosting/HostingTrialForm.tsx");
    expect(form).toMatch(/tierId: TRIAL_PLAN_ID/);
    expect(form).not.toMatch(/setPlan\(/);
    expect(TRIAL_PLAN_ID).toBe("starter");
  });
});
