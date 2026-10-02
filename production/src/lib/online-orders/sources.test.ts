import { describe, it, expect } from "vitest";
import { isWebsiteOrderSource, orderChannel, trialWindow, isTrialOrder } from "./sources";

describe("website order sources (R-077)", () => {
  it("cart, hosting trial and DMS orders are website orders — not only buy-workspace", () => {
    for (const s of ["buy-cart-direct", "buy-cart-direct-sim", "buy-hosting-trial", "dms-panel",
      "buy-workspace", "buy-workspace-trial", "buy-workspace-direct", "buy-workspace-direct-sim"]) {
      expect(isWebsiteOrderSource(s)).toBe(true);
    }
  });
  it("enquiries, manual and AI-finder leads are not", () => {
    for (const s of ["enquiry-form", "manual", "ai-finder", "meta-ads", null]) {
      expect(isWebsiteOrderSource(s)).toBe(false);
    }
  });
  it("labels the channel in plain words, marks test payments and DMS trials", () => {
    expect(orderChannel("buy-cart-direct")).toBe("Website cart");
    expect(orderChannel("buy-cart-direct-sim")).toBe("Website cart (test)");
    expect(orderChannel("dms-panel")).toBe("DMS panel order");
    expect(orderChannel("buy-hosting-trial", "dms-panel")).toBe("Hosting trial · DMS");
    expect(orderChannel("buy-hosting-trial", "google")).toBe("Hosting trial");
    expect(orderChannel("buy-something-new")).toBe("buy-something-new");
  });
});

describe("trialWindow", () => {
  const start = "2026-10-01T00:00:00.000Z";
  it("reads the lead's own expiry — a 15-day hosting trial is day 15 of 15, not expired at 14", () => {
    const l = { source: "buy-hosting-trial", created_at: start, trial_started_at: start, trial_expires_at: "2026-10-16T00:00:00.000Z" };
    const w = trialWindow(l, new Date("2026-10-15T10:00:00.000Z"));
    expect(w).toMatchObject({ day: 15, length: 15, state: "converting" });
  });
  it("expired once the expiry has passed", () => {
    const l = { source: "buy-hosting-trial", created_at: start, trial_expires_at: "2026-10-16T00:00:00.000Z" };
    expect(trialWindow(l, new Date("2026-10-17T00:00:00.000Z")).state).toBe("expired");
  });
  it("no trial dates → published length (Workspace 14)", () => {
    const w = trialWindow({ source: "buy-workspace-trial", created_at: start }, new Date("2026-10-03T00:00:00.000Z"));
    expect(w).toMatchObject({ day: 3, length: 14, state: "active" });
  });
  it("trial by source or stage", () => {
    expect(isTrialOrder({ source: "buy-hosting-trial", stage: "new" })).toBe(true);
    expect(isTrialOrder({ source: "buy-cart-direct", stage: "quote" })).toBe(false);
  });
});
