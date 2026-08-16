import { describe, it, expect } from "vitest";
import {
  STAGE_PROBABILITY, stageProbability, weightedValue, buildForecast, closingBy,
  isOpenStage, probabilityLabel,
} from "./forecast";
import type { Lead } from "@/lib/supabase/database.types";

const lead = (over: Partial<Lead> & { expected_close_date?: string | null } = {}) =>
  ({ value: 100_000, stage: "new", ...over }) as Lead & { expected_close_date?: string | null };

describe("STAGE_PROBABILITY", () => {
  it("matches the brief exactly", () => {
    expect(STAGE_PROBABILITY.new).toBe(10);
    expect(STAGE_PROBABILITY.contact).toBe(20);
    expect(STAGE_PROBABILITY.demo).toBe(40);
    expect(STAGE_PROBABILITY.trial).toBe(60);
    expect(STAGE_PROBABILITY.quote).toBe(80);
    expect(STAGE_PROBABILITY.won).toBe(100);
  });

  it("gives `lost` an explicit 0 rather than leaving it out", () => {
    /* A stage missing from the lookup falls to a default, and a default of 10% on a lost
       deal would quietly add money to a forecast. */
    expect(STAGE_PROBABILITY.lost).toBe(0);
    expect(Object.keys(STAGE_PROBABILITY)).toHaveLength(7);
  });

  it("rises monotonically through the funnel", () => {
    const order: Lead["stage"][] = ["new", "contact", "demo", "trial", "quote", "won"];
    for (let i = 1; i < order.length; i++) {
      expect(STAGE_PROBABILITY[order[i]]).toBeGreaterThan(STAGE_PROBABILITY[order[i - 1]]);
    }
  });

  it("scores an unknown or missing stage at 0, not at the lowest stage", () => {
    expect(stageProbability(null)).toBe(0);
    expect(stageProbability(undefined)).toBe(0);
    expect(stageProbability("archived" as Lead["stage"])).toBe(0);
  });
});

describe("weightedValue — rupees, rounded once", () => {
  it.each([
    ["new",     100_000, 10_000],
    ["contact", 100_000, 20_000],
    ["demo",    100_000, 40_000],
    ["trial",   100_000, 60_000],
    ["quote",   100_000, 80_000],
  ] as const)("%s deal worth ₹%s weights to ₹%s", (stage, value, expected) => {
    expect(weightedValue(lead({ stage, value }))).toBe(expected);
  });

  it("rounds to whole rupees — value is an integer column", () => {
    // 33,333 × 40% = 13,333.2
    expect(weightedValue(lead({ stage: "demo", value: 33_333 }))).toBe(13_333);
    // 33,334 × 40% = 13,333.6 → 13,334
    expect(weightedValue(lead({ stage: "demo", value: 33_334 }))).toBe(13_334);
  });

  it("is zero for a lost deal and for a valueless one", () => {
    expect(weightedValue(lead({ stage: "lost", value: 500_000 }))).toBe(0);
    expect(weightedValue(lead({ stage: "quote", value: 0 }))).toBe(0);
    expect(weightedValue(lead({ stage: "quote", value: null }))).toBe(0);
  });

  it("never returns a negative from a negative value", () => {
    // A negative deal value is data corruption, not a refund. Do not propagate it.
    expect(weightedValue(lead({ stage: "quote", value: -50_000 }))).toBe(0);
  });
});

describe("buildForecast — what it counts", () => {
  const pipeline = [
    lead({ stage: "new",     value: 100_000, expected_close_date: "2026-09-30" }),
    lead({ stage: "demo",    value: 200_000, expected_close_date: "2026-09-15" }),
    lead({ stage: "quote",   value: 500_000, expected_close_date: "2026-08-31" }),
  ];

  it("adds full value for the open pipeline and weighted value beside it", () => {
    const f = buildForecast(pipeline);
    expect(f.openValue).toBe(800_000);
    // 10,000 + 80,000 + 400,000
    expect(f.weighted).toBe(490_000);
    expect(f.openCount).toBe(3);
  });

  it("EXCLUDES won, even though won is 100% certain", () => {
    /* A forecast answers "what is still to come". Folding in money already earned
       inflates it every time somebody closes a deal — exactly backwards. */
    const f = buildForecast([...pipeline, lead({ stage: "won", value: 9_000_000 })]);
    expect(f.openValue).toBe(800_000);
    expect(f.weighted).toBe(490_000);
    expect(f.openCount).toBe(3);
  });

  it("excludes lost", () => {
    const f = buildForecast([...pipeline, lead({ stage: "lost", value: 9_000_000 })]);
    expect(f.openValue).toBe(800_000);
  });

  it("reports confidence as weighted over open", () => {
    // 490,000 / 800,000 = 61.25% → 61
    expect(buildForecast(pipeline).confidencePct).toBe(61);
  });

  it("returns null confidence rather than 0% on an empty pipeline", () => {
    /* 0% reads as "we will win nothing". Null reads as "there is nothing to say", which
       is the truth. */
    const f = buildForecast([]);
    expect(f.confidencePct).toBeNull();
    expect(f.openValue).toBe(0);
    expect(f.weighted).toBe(0);
  });

  it("the total is the SUM of the rounded rows, so a table adds up to its header", () => {
    const odd = [
      lead({ stage: "demo", value: 33_333 }),
      lead({ stage: "demo", value: 33_333 }),
      lead({ stage: "demo", value: 33_333 }),
    ];
    const f = buildForecast(odd);
    expect(f.weighted).toBe(13_333 * 3);
    // NOT round(99,999 x 40%) = 40,000 — that would leave a row/total mismatch of ₹1.
    expect(f.weighted).not.toBe(40_000);
  });
});

describe("buildForecast — by stage", () => {
  it("groups and orders by funnel position, not alphabetically", () => {
    const f = buildForecast([
      lead({ stage: "quote", value: 100_000 }),
      lead({ stage: "new",   value: 100_000 }),
      lead({ stage: "demo",  value: 100_000 }),
    ]);
    expect(f.byStage.map((s) => s.stage)).toEqual(["new", "demo", "quote"]);
  });

  it("omits stages with nothing in them rather than showing empty rows", () => {
    const f = buildForecast([lead({ stage: "quote", value: 100_000 })]);
    expect(f.byStage).toHaveLength(1);
    expect(f.byStage[0]).toMatchObject({ stage: "quote", count: 1, weighted: 80_000, probability: 80 });
  });

  it("stage slices sum to the totals", () => {
    const f = buildForecast([
      lead({ stage: "new",   value: 100_000 }),
      lead({ stage: "new",   value: 50_000 }),
      lead({ stage: "quote", value: 200_000 }),
    ]);
    expect(f.byStage.reduce((s, x) => s + x.weighted, 0)).toBe(f.weighted);
    expect(f.byStage.reduce((s, x) => s + x.openValue, 0)).toBe(f.openValue);
  });
});

describe("buildForecast — undated deals are reported, never hidden", () => {
  it("counts open deals with no expected close date", () => {
    /* A forecast that silently drops undated deals reads as the whole picture when a
       third of it is missing — and the fix only happens if somebody is told. */
    const f = buildForecast([
      lead({ stage: "quote", value: 500_000, expected_close_date: "2026-08-31" }),
      lead({ stage: "demo",  value: 200_000, expected_close_date: null }),
      lead({ stage: "new",   value: 100_000 }),
    ]);
    expect(f.undatedCount).toBe(2);
    expect(f.undatedValue).toBe(300_000);
  });

  it("still includes undated deals in the totals", () => {
    // They are real pipeline. Only their TIMING is unknown.
    const f = buildForecast([lead({ stage: "quote", value: 500_000, expected_close_date: null })]);
    expect(f.openValue).toBe(500_000);
    expect(f.weighted).toBe(400_000);
    expect(f.undatedCount).toBe(1);
  });

  it("does not count closed deals as undated", () => {
    const f = buildForecast([lead({ stage: "won", value: 100_000, expected_close_date: null })]);
    expect(f.undatedCount).toBe(0);
  });
});

describe("closingBy", () => {
  const leads = [
    lead({ stage: "quote", value: 100_000, expected_close_date: "2026-08-31" }),
    lead({ stage: "demo",  value: 100_000, expected_close_date: "2026-09-30" }),
    lead({ stage: "new",   value: 100_000, expected_close_date: null }),
    lead({ stage: "won",   value: 100_000, expected_close_date: "2026-08-01" }),
  ];

  it("takes open deals dated on or before the cutoff", () => {
    expect(closingBy(leads, "2026-08-31")).toHaveLength(1);
    expect(closingBy(leads, "2026-09-30")).toHaveLength(2);
  });

  it("EXCLUDES undated deals — 'closing this month' is a claim nobody made", () => {
    expect(closingBy(leads, "2099-12-31").some((l) => !l.expected_close_date)).toBe(false);
  });

  it("excludes deals that are already closed", () => {
    expect(closingBy(leads, "2026-08-31").some((l) => l.stage === "won")).toBe(false);
  });
});

describe("isOpenStage / probabilityLabel", () => {
  it("treats won and lost as closed", () => {
    expect(isOpenStage("won")).toBe(false);
    expect(isOpenStage("lost")).toBe(false);
    expect(isOpenStage("quote")).toBe(true);
    expect(isOpenStage(null)).toBe(false);
  });

  it("renders a percent, and a dash when there is no stage", () => {
    expect(probabilityLabel("demo")).toBe("40%");
    expect(probabilityLabel(null)).toBe("—");
  });
});
