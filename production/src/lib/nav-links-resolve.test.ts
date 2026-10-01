/**
 * Every link in the app menu opens a page that exists (R-047, 1 Oct 2026).
 *
 * nav.ts carried a "Customer-facing" menu with three links to pages that were never built
 * (/buy/m365, /buy/zoho, /support-customer). Nothing caught it: internal-links.test.ts reads
 * `href` attributes in page code, and a link stored as data in nav.ts is not one. This reads
 * every `href: "…"` in nav.ts and resolves it against the page files under src/app, with route
 * groups dropped and [param] segments matching anything — the same way Next.js serves them.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const APP = join(process.cwd(), "src/app");

/** Route patterns, one per page.tsx: "/leads/[id]" etc., route groups and @slots removed. */
function routePatterns(dir: string = APP, out: string[][] = []): string[][] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) routePatterns(p, out);
    else if (/^page\.(tsx|ts|jsx|js)$/.test(name)) {
      const segs = relative(APP, dir).split(sep).filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@"));
      out.push(segs);
    }
  }
  return out;
}

function resolves(href: string, patterns: string[][]): boolean {
  const path = href.split(/[?#]/)[0];
  const segs = path.split("/").filter(Boolean);
  return patterns.some((pat) => {
    for (let i = 0; i < pat.length; i++) {
      if (/^\[\[?\.\.\./.test(pat[i])) return true; // catch-all
      if (i >= segs.length) return false;
      if (!/^\[.+\]$/.test(pat[i]) && pat[i] !== segs[i]) return false;
    }
    return pat.length === segs.length;
  });
}

const nav = readFileSync(join(process.cwd(), "src/lib/nav.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const hrefs = [...new Set([...nav.matchAll(/href:\s*"(\/[^"]*)"/g)].map((m) => m[1]))];
const patterns = routePatterns();

describe("every link in the app menu opens a real page", () => {
  it("guard: the scan found the menu and the pages", () => {
    expect(hrefs.length).toBeGreaterThan(40);
    expect(patterns.length).toBeGreaterThan(100);
  });

  it("the resolver itself: a real page, a dynamic page, and a missing one", () => {
    expect(resolves("/leads", patterns)).toBe(true);
    expect(resolves("/quote/Q-ANY-0001/accept", patterns)).toBe(true);
    expect(resolves("/buy/m365", patterns)).toBe(false);
  });

  it("no href in nav.ts points at a page that does not exist", () => {
    expect(hrefs.filter((h) => !resolves(h, patterns))).toEqual([]);
  });

  it("the dead customer menu is gone", () => {
    expect(nav).not.toMatch(/CUSTOMER_NAV/);
  });
});

describe("signup's legal links open the documents", () => {
  const signup = readFileSync(join(process.cwd(), "src/app/(auth)/signup/page.tsx"), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""); // comments say why, so they may quote the old href
  it("Terms and Privacy point at real pages, not #", () => {
    expect(signup).not.toMatch(/href="#"/);
    expect(signup).toMatch(/href="\/terms"[^>]*>Terms</);
    expect(signup).toMatch(/href="\/privacy"[^>]*>Privacy Policy</);
    expect(resolves("/terms", patterns) && resolves("/privacy", patterns)).toBe(true);
  });
});
