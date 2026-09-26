import { describe, it, expect } from "vitest";
import { campaignMetrics, campaignCode, type CampaignInput } from "./campaign-metrics";
import { slugCampaign } from "./tracking-link";

const diwali: CampaignInput = { start_date: "2026-10-01", end_date: "2026-10-31", budget: 20_000, target_leads: 30, target_won: 5, cancelled: false };

describe("campaign metrics", () => {
  it("phase and days", () => {
    expect(campaignMetrics(diwali, { spend: 0, leads: 0, won: 0, wonValue: 0 }, "2026-09-26").phase).toBe("upcoming");
    const mid = campaignMetrics(diwali, { spend: 0, leads: 0, won: 0, wonValue: 0 }, "2026-10-16");
    expect(mid.phase).toBe("running");
    expect(mid.days).toBe(31);
    expect(mid.daysElapsed).toBe(16);
    expect(campaignMetrics(diwali, { spend: 0, leads: 0, won: 0, wonValue: 0 }, "2026-11-02").phase).toBe("ended");
    expect(campaignMetrics({ ...diwali, cancelled: true }, { spend: 0, leads: 0, won: 0, wonValue: 0 }, "2026-10-16").phase).toBe("cancelled");
  });

  it("pace: half-way through, half the budget is on track; far more is overspending", () => {
    // Day 16 of 31 → plan ≈ ₹10,323
    expect(campaignMetrics(diwali, { spend: 10_000, leads: 0, won: 0, wonValue: 0 }, "2026-10-16").pace).toBe("on_track");
    const hot = campaignMetrics(diwali, { spend: 16_000, leads: 0, won: 0, wonValue: 0 }, "2026-10-16");
    expect(hot.pace).toBe("overspending");
    expect(hot.paceGap).toBeGreaterThan(5_000);
    expect(campaignMetrics(diwali, { spend: 2_000, leads: 0, won: 0, wonValue: 0 }, "2026-10-16").pace).toBe("underspending");
    expect(campaignMetrics(diwali, { spend: 2_000, leads: 0, won: 0, wonValue: 0 }, "2026-11-10").pace).toBeNull(); // ended: no pace
  });

  it("costs, ROAS, targets, over budget", () => {
    const m = campaignMetrics(diwali, { spend: 21_000, leads: 35, won: 3, wonValue: 1_50_000 }, "2026-11-01");
    expect(m.budgetUsedPct).toBe(105);
    expect(m.overBudget).toBe(true);
    expect(m.costPerLead).toBe(600);
    expect(m.costPerWon).toBe(7_000);
    expect(m.roas).toBe(7.1);
    expect(m.leadsPct).toBe(117);
    expect(m.wonPct).toBe(60);
  });

  it("nothing spent or no target → null, never divide by zero", () => {
    const m = campaignMetrics({ ...diwali, budget: 0, target_leads: null, target_won: 0 }, { spend: 0, leads: 4, won: 0, wonValue: 0 }, "2026-10-10");
    expect(m.budgetUsedPct).toBeNull();
    expect(m.costPerLead).toBeNull();
    expect(m.costPerWon).toBeNull();
    expect(m.roas).toBeNull();
    expect(m.leadsPct).toBeNull();
    expect(m.wonPct).toBeNull();
    expect(m.pace).toBeNull();
  });

  it("code matches the tracking-link slug, so links and campaign join", () => {
    for (const n of ["Diwali Offer 2026!", "  New Year — Workspace ", "IndiaMART Q3"]) {
      expect(campaignCode(n)).toBe(slugCampaign(n));
    }
    expect(campaignCode("Diwali Offer 2026!")).toBe("diwali-offer-2026");
  });
});
