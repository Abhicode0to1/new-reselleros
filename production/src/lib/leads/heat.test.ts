import { describe, it, expect } from "vitest";
import {
  isHotLead, isHighValueLead, hotReason,
  daysSinceTouch, intentTier, intentMeta, staleWarning,
  HOT_VALUE, COLD_DAYS, STALE_DAYS,
} from "./heat";

const NOW = new Date("2026-08-13T10:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

/** Minimal lead shape the heat helpers read. */
const lead = (over: Partial<Parameters<typeof intentTier>[0]> = {}) => ({
  value: 10_000,
  stage: "new",
  priority: "medium",
  updated_at: daysAgo(1),
  created_at: daysAgo(30),
  ...over,
}) as Parameters<typeof intentTier>[0];

describe("daysSinceTouch", () => {
  it("counts whole days from the newest signal available", () => {
    expect(daysSinceTouch(lead({ updated_at: daysAgo(8) }), null, NOW)).toBe(8);
  });

  it("prefers an explicit lead_activities timestamp over updated_at", () => {
    // updated_at can be bumped by unrelated edits; a real activity is the truth.
    expect(daysSinceTouch(lead({ updated_at: daysAgo(20) }), daysAgo(2), NOW)).toBe(2);
  });

  it("falls back to created_at when never updated", () => {
    expect(daysSinceTouch({ updated_at: null, created_at: daysAgo(5) } as never, null, NOW)).toBe(5);
  });

  it("returns null when there is no usable timestamp — 'unknown', not 'stale'", () => {
    // A freshly imported lead with no history must not be scolded on day one.
    expect(daysSinceTouch({ updated_at: null, created_at: null } as never, null, NOW)).toBeNull();
    expect(daysSinceTouch({ updated_at: "not-a-date", created_at: null } as never, null, NOW)).toBeNull();
  });

  it("never returns a negative age when a clock is skewed ahead", () => {
    expect(daysSinceTouch(lead({ updated_at: daysAgo(-3) }), null, NOW)).toBe(0);
  });
});

describe("intentTier", () => {
  it("is hot for a high-value deal in an advanced stage", () => {
    expect(intentTier(lead({ value: HOT_VALUE + 1, stage: "quote" }), null, NOW)).toBe("hot");
    expect(intentTier(lead({ value: 200_000, stage: "trial" }), null, NOW)).toBe("hot");
  });

  it("is hot when the operator flagged it high priority, whatever the value", () => {
    expect(intentTier(lead({ value: 1_000, priority: "high" }), null, NOW)).toBe("hot");
  });

  it("is NOT hot on value alone — the deal has to have moved", () => {
    expect(intentTier(lead({ value: 500_000, stage: "new" }), null, NOW)).toBe("warm");
  });

  it("treats exactly HOT_VALUE as not-yet-hot (threshold is >, not >=)", () => {
    expect(intentTier(lead({ value: HOT_VALUE, stage: "quote" }), null, NOW)).toBe("warm");
  });

  it("COLD WINS over hot — an untouched big deal is at risk, not on fire", () => {
    // This ordering is the whole point: calling a 3-week-old ₹2L deal "Hot" is
    // how it keeps getting ignored.
    const forgotten = lead({ value: 200_000, stage: "quote", priority: "high", updated_at: daysAgo(21) });
    expect(intentTier(forgotten, null, NOW)).toBe("cold");
  });

  it("goes cold exactly at COLD_DAYS", () => {
    expect(intentTier(lead({ updated_at: daysAgo(COLD_DAYS - 1) }), null, NOW)).toBe("warm");
    expect(intentTier(lead({ updated_at: daysAgo(COLD_DAYS) }), null, NOW)).toBe("cold");
  });

  it("defaults to warm for an ordinary enquiry", () => {
    expect(intentTier(lead(), null, NOW)).toBe("warm");
  });
});

describe("intentMeta", () => {
  it("gives every tier a label, a tone and a plain-language reason", () => {
    const hot = intentMeta(lead({ value: 90_000, stage: "quote" }), null, NOW);
    expect(hot).toMatchObject({ tier: "hot", label: "Hot", kind: "danger" });
    expect(hot.reason).toContain("Quote sent");

    const cold = intentMeta(lead({ updated_at: daysAgo(14) }), null, NOW);
    expect(cold).toMatchObject({ tier: "cold", label: "Cold" });
    expect(cold.reason).toBe("No activity for 14 days");

    expect(intentMeta(lead(), null, NOW)).toMatchObject({ tier: "warm", label: "Warm", kind: "warning" });
  });
});

describe("staleWarning", () => {
  it("fires at STALE_DAYS with the stage named", () => {
    const w = staleWarning(lead({ stage: "quote", updated_at: daysAgo(8) }), null, NOW);
    expect(w).not.toBeNull();
    expect(w!.days).toBe(8);
    expect(w!.message).toBe("8 days in Quote Sent — action needed");
  });

  it("stays quiet below the threshold", () => {
    expect(staleWarning(lead({ updated_at: daysAgo(STALE_DAYS - 1) }), null, NOW)).toBeNull();
  });

  it("warns BEFORE the lead goes cold, so there is a window to save it", () => {
    expect(STALE_DAYS).toBeLessThan(COLD_DAYS);
    const inWindow = lead({ stage: "quote", updated_at: daysAgo(STALE_DAYS) });
    expect(staleWarning(inWindow, null, NOW)).not.toBeNull();
    expect(intentTier(inWindow, null, NOW)).toBe("warm");
  });

  it("never nags about closed deals — won/lost are supposed to sit still", () => {
    expect(staleWarning(lead({ stage: "won",  updated_at: daysAgo(90) }), null, NOW)).toBeNull();
    expect(staleWarning(lead({ stage: "lost", updated_at: daysAgo(90) }), null, NOW)).toBeNull();
  });

  it("says nothing when the age is unknown", () => {
    expect(staleWarning({ stage: "new", updated_at: null, created_at: null } as never, null, NOW)).toBeNull();
  });
});

describe("existing helpers still hold", () => {
  it("isHotLead / isHighValueLead / hotReason are unchanged", () => {
    expect(isHotLead({ priority: "high", stage: "new" } as never)).toBe(true);
    expect(isHotLead({ priority: "low", stage: "quote" } as never)).toBe(true);
    expect(isHotLead({ priority: "low", stage: "new" } as never)).toBe(false);
    expect(isHighValueLead({ value: 100_000 } as never)).toBe(true);
    expect(isHighValueLead({ value: 99_999 } as never)).toBe(false);
    expect(hotReason({ priority: "high", stage: "quote" } as never)).toBe("High priority");
    expect(hotReason({ priority: "low", stage: "new" } as never)).toBe("");
  });
});
