/**
 * Reports page par nakli aankda wapas na aa sake — source par pehra.
 *
 * 1 Sep 2026 ke audit ne is page par paanch fabrications naape the (hardcoded
 * funnel/trend, 17% margin, ID-se-bana NPS, jhoothe trend-badge). Ye test un
 * sabki wapsi ke raaste band karta hai: page asli hooks se padhta ho, aur
 * fabrication ke pehchane hue nishaan source me na hon.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(
  join(process.cwd(), "src/app/(app)/reports/page.tsx"),
  "utf8",
);

describe("reports page fabricates nothing", () => {
  it("asli sources se padhta hai — leads aur MRR snapshots", () => {
    expect(src).toContain("useLeads");
    expect(src).toContain("useMrrSnapshots");
  });

  it("hardcoded 12-month trend / funnel ke identifiers wapas nahi aaye", () => {
    expect(src).not.toContain("MRR_TREND");
    expect(src).not.toContain("FUNNEL_STAGES");
    expect(src).not.toContain("vendorBarData");
  });

  it("risk kisi hash/fiction se nahi banta — sirf naapi hui utilisation se", () => {
    expect(src).not.toContain("idHash");
    expect(src).not.toContain("charCodeAt");
    expect(src).toMatch(/used \/ Math\.max\(1, sub\.seats\)/);
  });

  it("koi hardcoded margin-guess nahi (× 0.17 wala parivaar)", () => {
    expect(src).not.toMatch(/\*\s*0\.17/);
  });

  it("trend-badge sirf naape hue MoM se banta hai, string-literal se nahi", () => {
    // Purane page ke jhoothe badge: "+12%", "+14%", "−0.4pp", "+₹40K", "+₹15K".
    for (const fake of ['"+12%"', '"+14%"', '"−0.4pp"', '"+₹40K"', '"+₹15K"']) {
      expect(src).not.toContain(fake);
    }
    expect(src).toContain("mrrMoM");
  });
});
