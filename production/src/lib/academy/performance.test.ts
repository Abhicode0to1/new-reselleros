import { describe, it, expect } from "vitest";
import { computePerformance, evaluationBand, skillLevel, weekStart, bandOf } from "./performance";

const T = "2026-10-04";

describe("academy performance (R-150)", () => {
  it("evaluation verdicts match the master prompt's bands", () => {
    expect(evaluationBand(100)).toBe("Excellent");
    expect(evaluationBand(90)).toBe("Excellent");
    expect(evaluationBand(89)).toBe("Very Good");
    expect(evaluationBand(75)).toBe("Very Good");
    expect(evaluationBand(74)).toBe("Good");
    expect(evaluationBand(60)).toBe("Good");
    expect(evaluationBand(59)).toBe("Needs Improvement");
    expect(evaluationBand(40)).toBe("Needs Improvement");
    expect(evaluationBand(39)).toBe("Critical Improvement Required");
  });

  it("skill levels and score colours have the stated cut-offs", () => {
    expect([0, 24, 25, 49, 50, 74, 75, 100].map(skillLevel)).toEqual(
      ["Beginner", "Beginner", "Learning", "Learning", "Competent", "Competent", "Advanced", "Advanced"]);
    expect([100, 75, 74, 50, 49, 0].map(bandOf)).toEqual(["green", "green", "yellow", "yellow", "red", "red"]);
  });

  it("weekStart is the Monday of the week (Sunday belongs to the week before)", () => {
    expect(weekStart("2026-10-04")).toBe("2026-09-28"); // Sunday
    expect(weekStart("2026-10-05")).toBe("2026-10-05"); // Monday
    expect(weekStart("2026-10-01")).toBe("2026-09-28"); // Thursday
  });

  it("no data → no score, no colour, no alert", () => {
    const p = computePerformance({ tasks: [], submissions: [], evaluations: [], today: T });
    expect(p.score).toBeNull();
    expect(p.band).toBeNull();
    expect(p.alerts).toEqual([]);
  });

  it("missing parts are left out and the rest re-weighted, not counted as zero", () => {
    const p = computePerformance({ tasks: [], submissions: [{ review_result: "approved", marks: 80 }], evaluations: [], today: T });
    expect(p.score).toBe(80);
    expect(p.band).toBe("green");
  });

  it("weights evaluation 40 / marks 25 / completion 20 / on-time 15", () => {
    const p = computePerformance({
      evaluations: [{ week_start: "2026-09-28", total: 60 }],
      submissions: [{ review_result: "approved", marks: 80 }, { review_result: "rework", marks: 10 }],
      tasks: [
        { status: "completed", due_date: "2026-10-01", completed_at: "2026-10-01T10:00:00Z" },
        { status: "completed", due_date: "2026-10-01", completed_at: "2026-10-03T10:00:00Z" },
        { status: "in_progress", due_date: "2026-10-02", completed_at: null },
        { status: "not_started", due_date: "2026-10-09", completed_at: null }, // not due yet: ignored
      ],
      today: T,
    });
    // completion 2/3 = 66.67, on-time 1/2 = 50 → (60*40 + 80*25 + 66.67*20 + 50*15) / 100 = 64.83
    expect(p.score).toBe(65);
    expect(p.band).toBe("yellow");
    expect(p.parts.find((x) => x.key === "marks")?.value).toBe(80); // rework marks not counted
  });

  it("alerts: red score, a 15-point fall, a critical week, two overdue tasks", () => {
    const p = computePerformance({
      evaluations: [{ week_start: "2026-09-28", total: 35 }, { week_start: "2026-09-21", total: 70 }],
      submissions: [],
      tasks: [
        { status: "not_started", due_date: "2026-10-01", completed_at: null },
        { status: "rework", due_date: "2026-10-02", completed_at: null },
      ],
      today: T,
    });
    expect(p.band).toBe("red");
    expect(p.trend).toBe("down");
    expect(p.alerts.join(" | ")).toMatch(/At risk/);
    expect(p.alerts.join(" | ")).toMatch(/fell from 70 to 35/);
    expect(p.alerts.join(" | ")).toMatch(/critical improvement/);
    expect(p.alerts.join(" | ")).toMatch(/2 tasks are overdue/);
  });

  it("only the latest four evaluations count, newest first regardless of input order", () => {
    // The oldest week (31 Aug, 20 marks) is the fifth and must be dropped; input is shuffled.
    const evaluations = [
      { week_start: "2026-09-14", total: 90 }, { week_start: "2026-08-31", total: 20 }, { week_start: "2026-09-28", total: 90 },
      { week_start: "2026-09-07", total: 90 }, { week_start: "2026-09-21", total: 90 },
    ];
    const p = computePerformance({ evaluations, submissions: [], tasks: [], today: T });
    expect(p.parts.find((x) => x.key === "evaluation")?.value).toBe(90);
  });
});
