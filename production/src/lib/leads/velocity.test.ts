import { describe, it, expect } from "vitest";
import { daysInStage, stageAge, stageVelocity, staleDeals, STAGE_SLA_DAYS } from "./velocity";
import type { Lead } from "@/lib/supabase/database.types";

const NOW = new Date("2026-08-16T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const lead = (over: Partial<Lead> & { stage_changed_at?: string | null } = {}) =>
  ({ stage: "quote", stage_changed_at: daysAgo(3), ...over }) as Lead & { stage_changed_at?: string | null };

describe("daysInStage", () => {
  it("counts whole days since the stage last moved", () => {
    expect(daysInStage(lead({ stage_changed_at: daysAgo(5) }), NOW)).toBe(5);
    expect(daysInStage(lead({ stage_changed_at: daysAgo(0) }), NOW)).toBe(0);
  });

  it("returns NULL — not 0 — when no stamp was ever recorded", () => {
    /* 0 would read as "moved today", which is the opposite of the truth for a lead that
       has been sitting untouched since before the column existed. */
    expect(daysInStage(lead({ stage_changed_at: null }), NOW)).toBeNull();
    expect(daysInStage(lead({ stage_changed_at: undefined }), NOW)).toBeNull();
  });

  it("returns null on an unparseable timestamp rather than NaN days", () => {
    expect(daysInStage(lead({ stage_changed_at: "not-a-date" }), NOW)).toBeNull();
  });

  it("never returns a negative age from clock skew", () => {
    const future = new Date(NOW.getTime() + 86_400_000).toISOString();
    expect(daysInStage(lead({ stage_changed_at: future }), NOW)).toBe(0);
  });
});

describe("stageAge — the badge", () => {
  it("reads '5d in Quote Sent'", () => {
    expect(stageAge(lead({ stage: "quote", stage_changed_at: daysAgo(5) }), NOW).label)
      .toBe("5d in Quote Sent");
  });

  it("uses the human stage name, not the enum value", () => {
    expect(stageAge(lead({ stage: "trial", stage_changed_at: daysAgo(2) }), NOW).label)
      .toBe("2d in Trial Active");
  });

  it("shows a dash for an unknown age, and explains why in the title", () => {
    const a = stageAge(lead({ stage_changed_at: null }), NOW);
    expect(a.label).toBe("—");
    expect(a.days).toBeNull();
    expect(a.stale).toBe(false);
    // Names the trap, so nobody "fixes" it by falling back to updated_at.
    expect(a.title).toMatch(/updated_at is not used/i);
  });
});

describe("stageAge — staleness", () => {
  it("goes stale exactly AT the SLA, not a day later", () => {
    expect(stageAge(lead({ stage_changed_at: daysAgo(STAGE_SLA_DAYS - 1) }), NOW).stale).toBe(false);
    expect(stageAge(lead({ stage_changed_at: daysAgo(STAGE_SLA_DAYS) }), NOW).stale).toBe(true);
  });

  it("NEVER flags a closed deal, however old", () => {
    /* A won deal sitting in `won` for 90 days is not a problem. Flagging it would train
       people to ignore the badge, which costs more than the badge is worth. */
    for (const stage of ["won", "lost"] as const) {
      expect(stageAge(lead({ stage, stage_changed_at: daysAgo(90) }), NOW).stale).toBe(false);
    }
  });

  it("says what to do about a stale deal, not just that it is stale", () => {
    const a = stageAge(lead({ stage_changed_at: daysAgo(20) }), NOW);
    expect(a.title).toMatch(/needs a nudge|nobody recorded it/i);
  });

  it("honours a different SLA when one is given", () => {
    expect(stageAge(lead({ stage_changed_at: daysAgo(10) }), NOW, 14).stale).toBe(false);
    expect(stageAge(lead({ stage_changed_at: daysAgo(10) }), NOW, 3).stale).toBe(true);
  });
});

describe("stageVelocity", () => {
  const pipeline = [
    lead({ stage: "new",   stage_changed_at: daysAgo(2) }),
    lead({ stage: "new",   stage_changed_at: daysAgo(4) }),
    lead({ stage: "quote", stage_changed_at: daysAgo(10) }),
    lead({ stage: "quote", stage_changed_at: daysAgo(20) }),
    lead({ stage: "won",   stage_changed_at: daysAgo(60) }),
  ];

  it("averages days in stage across open deals only", () => {
    const v = stageVelocity(pipeline, NOW);
    expect(v.find((x) => x.stage === "new")!.avgDays).toBe(3);      // (2+4)/2
    expect(v.find((x) => x.stage === "quote")!.avgDays).toBe(15);   // (10+20)/2
    expect(v.some((x) => x.stage === "won")).toBe(false);
  });

  it("orders by funnel position", () => {
    expect(stageVelocity(pipeline, NOW).map((v) => v.stage)).toEqual(["new", "quote"]);
  });

  it("counts stale deals per stage", () => {
    const v = stageVelocity(pipeline, NOW);
    expect(v.find((x) => x.stage === "quote")!.staleCount).toBe(2);
    expect(v.find((x) => x.stage === "new")!.staleCount).toBe(0);
  });

  it("REPORTS unmeasurable deals rather than dropping them from the average", () => {
    /* An average over 2 of 10 deals, presented as though it covered all 10, is a lie by
       omission. The count of unknowns rides alongside. */
    const v = stageVelocity([
      lead({ stage: "demo", stage_changed_at: daysAgo(6) }),
      lead({ stage: "demo", stage_changed_at: null }),
      lead({ stage: "demo", stage_changed_at: null }),
    ], NOW);
    const demo = v.find((x) => x.stage === "demo")!;
    expect(demo.measured).toBe(1);
    expect(demo.unknown).toBe(2);
    expect(demo.avgDays).toBe(6);
  });

  it("returns a null average, not 0, when nothing in a stage can be measured", () => {
    const v = stageVelocity([lead({ stage: "demo", stage_changed_at: null })], NOW);
    expect(v[0].avgDays).toBeNull();
    expect(v[0].unknown).toBe(1);
  });

  it("omits stages with nothing in them", () => {
    expect(stageVelocity([lead({ stage: "quote" })], NOW).map((v) => v.stage)).toEqual(["quote"]);
  });
});

describe("staleDeals — the re-engagement worklist", () => {
  it("returns only open, past-SLA deals, worst first", () => {
    const out = staleDeals([
      lead({ stage: "quote", stage_changed_at: daysAgo(9) }),
      lead({ stage: "demo",  stage_changed_at: daysAgo(30) }),
      lead({ stage: "new",   stage_changed_at: daysAgo(1) }),
      lead({ stage: "won",   stage_changed_at: daysAgo(99) }),
      lead({ stage: "trial", stage_changed_at: null }),
    ], NOW);
    expect(out.map((l) => l.stage)).toEqual(["demo", "quote"]);
  });

  it("excludes deals whose age is unknown — it cannot claim they are stale", () => {
    expect(staleDeals([lead({ stage_changed_at: null })], NOW)).toHaveLength(0);
  });
});
