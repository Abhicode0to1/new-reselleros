import { describe, it, expect } from "vitest";
import { sanitizeMetrics, medianMetrics, scorePage, sanitizeUiInsights, basicUiInsight, type UiMetrics } from "./score";

const clean: UiMetrics = { vw: 1280, mobile: 0, overflowX: 0, h1: 1, tinyText: 0, lowContrast: 0, smallTargets: 0, unnamed: 0, imgNoAlt: 0, primaryButtons: 1, fontSizes: 6, fontFamilies: 2, wordsAboveFold: 120, longestForm: 4, cls: 0.01, lcp: 1200 };

describe("UI agent — measurements are numbers or nothing", () => {
  it("drops anything that is not a non-negative number", () => {
    expect(sanitizeMetrics({ ...clean, h1: "x" })).toBeNull();
    expect(sanitizeMetrics({ ...clean, tinyText: -1 })).toBeNull();
    expect(sanitizeMetrics(clean)).toEqual(clean);
  });
  it("uses the median visit, not one odd screen", () => {
    const m = medianMetrics([{ ...clean, lowContrast: 0 }, { ...clean, lowContrast: 9 }, { ...clean, lowContrast: 1 }]);
    expect(m?.lowContrast).toBe(1);
  });
});

describe("scorePage", () => {
  it("a clean page scores 100", () => {
    expect(scorePage(clean)).toEqual({ score: 100, issues: [] });
  });
  it("each measured problem costs points and names its rule", () => {
    const { score, issues } = scorePage({ ...clean, overflowX: 1, lowContrast: 4, primaryButtons: 4, h1: 0, mobile: 1, smallTargets: 3 });
    expect(issues.map((i) => i.code)).toEqual(["overflow", "primary-actions", "contrast", "headings", "tap-targets"]);
    expect(issues.find((i) => i.code === "contrast")?.rule).toMatch(/WCAG 1\.4\.3/);
    expect(score).toBe(100 - 15 - 10 - 8 - 3 - 5);
  });
  it("tap targets only count on a phone; slow paint only in production", () => {
    expect(scorePage({ ...clean, smallTargets: 9 }).issues).toEqual([]);
    expect(scorePage({ ...clean, lcp: 5000 }).issues).toEqual([]);
    expect(scorePage({ ...clean, lcp: 5000 }, { production: true }).issues.map((i) => i.code)).toEqual(["slow-paint"]);
  });
  it("never goes below zero", () => {
    expect(scorePage({ ...clean, overflowX: 1, lowContrast: 50, unnamed: 20, primaryButtons: 20, cls: 1, tinyText: 30, imgNoAlt: 20, h1: 3, fontSizes: 20, fontFamilies: 9, wordsAboveFold: 999, longestForm: 30 }).score).toBe(0);
  });
});

describe("AI only explains measured issues", () => {
  const page = { surface: "app" as const, path: "/quotes/new", samples: 4, ...scorePage({ ...clean, primaryButtons: 4 }) };
  it("keeps insights tied to a real issue, drops invented ones", () => {
    const out = sanitizeUiInsights({ insights: [
      { path: "/quotes/new", surface: "app", code: "primary-actions", severity: "high", category: "visual", problem: "Four orange buttons compete", fix: "Keep Save & send filled; make Preview / Email outline" },
      { path: "/quotes/new", surface: "app", code: "made-up", severity: "high", category: "visual", problem: "x", fix: "y" },
    ] }, [page]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ signal: "ui:primary-actions", category: "visual" });
    expect(out[0].evidence).toMatch(/4 filled primary buttons.*page score 90\/100/);
  });
  it("a plain insight exists without AI", () => {
    expect(basicUiInsight(page, page.issues[0]).fix).toMatch(/one filled primary button/);
  });
});
