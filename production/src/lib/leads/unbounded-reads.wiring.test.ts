import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/* WC-scale (30 Sep 2026): PostgREST cuts every response at 1000 rows without saying so, so a
   screen that reads a whole table and counts it in the browser is silently wrong past the
   thousandth row. useLeads() is that read for leads (select("*"), every lead). It is
   deprecated; the one caller left is quote-builder.tsx (Abhishek's area, not moved here).
   This pins that no NEW caller appears, and that the leads list's per-row look-ups stay
   scoped to the rows on screen. */

const SRC = join(process.cwd(), "src");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

describe("unbounded lead reads", () => {
  it("useLeads() is called only by the one known caller", () => {
    const callers = walk(SRC)
      .filter((f) => /(?<!function )\buseLeads\(\)/.test(readFileSync(f, "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "")))
      .map((f) => relative(SRC, f).replace(/\\/g, "/"));
    expect(callers.sort()).toEqual(["components/features/quotes/quote-builder.tsx"]);
  });

  it("the leads list scopes its quote / task / first-reply look-ups to the rows on screen", () => {
    const src = readFileSync(join(SRC, "components/features/leads/lead-list-view.tsx"), "utf8");
    expect(src).toMatch(/useLeadQuotes\(leadIds\)/);
    expect(src).toMatch(/useOpenTasksForLeads\(leadIds\)/);
    expect(src).toMatch(/useLeadFirstReplies\(leadIds\)/);
    expect(src).not.toMatch(/useTasks\("all"\)/);
  });
});
