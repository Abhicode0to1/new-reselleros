/**
 * UI agent — design measurements → a page score and issues (3 Oct 2026).
 * See migration 20261003110000_ui_agent.sql. Pure; the DOM probe lives in
 * components/shared/ux-observer.tsx.
 *
 * Every issue names the rule it comes from (WCAG 2.2, Nielsen, platform guidance), so a
 * fix can be argued with, and the AI only explains issues that were MEASURED — it never
 * invents a design problem. Scores are medians over real visits, so one odd screen size
 * does not swing a page.
 */

export interface UiMetrics {
  vw: number; mobile: number; overflowX: number; h1: number; tinyText: number; lowContrast: number;
  smallTargets: number; unnamed: number; imgNoAlt: number; primaryButtons: number; fontSizes: number;
  fontFamilies: number; wordsAboveFold: number; longestForm: number; cls: number; lcp: number;
}

const KEYS: Array<keyof UiMetrics> = ["vw", "mobile", "overflowX", "h1", "tinyText", "lowContrast", "smallTargets", "unnamed", "imgNoAlt", "primaryButtons", "fontSizes", "fontFamilies", "wordsAboveFold", "longestForm", "cls", "lcp"];

/** Numbers only, clamped — anything else is dropped. */
export function sanitizeMetrics(raw: unknown): UiMetrics | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out = {} as UiMetrics;
  for (const k of KEYS) {
    const n = Number(r[k]);
    if (!Number.isFinite(n) || n < 0) return null;
    out[k] = k === "cls" ? Math.min(Math.round(n * 1000) / 1000, 10) : Math.min(Math.round(n), 100_000);
  }
  return out;
}

export function medianMetrics(list: readonly UiMetrics[]): UiMetrics | null {
  if (list.length === 0) return null;
  const out = {} as UiMetrics;
  for (const k of KEYS) {
    const v = list.map((m) => m[k]).sort((a, b) => a - b);
    out[k] = v[Math.floor((v.length - 1) / 2)];
  }
  return out;
}

export interface UiIssue { code: string; rule: string; deduct: number; evidence: string }

/** 100 minus what the measurements cost, with the rule behind each deduction. */
export function scorePage(m: UiMetrics, opts: { production?: boolean } = {}): { score: number; issues: UiIssue[] } {
  const issues: UiIssue[] = [];
  const add = (code: string, rule: string, deduct: number, evidence: string) => issues.push({ code, rule, deduct, evidence });
  if (m.overflowX) add("overflow", "Layout — no sideways scroll (WCAG 1.4.10 Reflow)", 15, `Page scrolls sideways at ${m.vw}px wide`);
  if (m.lowContrast > 0) add("contrast", "WCAG 1.4.3 Contrast (4.5:1 text, 3:1 large)", Math.min(20, 2 * m.lowContrast), `${m.lowContrast} text elements below the contrast minimum`);
  if (m.tinyText > 3) add("tiny-text", "Readability — body text ≥ 12 px (14–16 px preferred)", 8, `${m.tinyText} text elements smaller than 12 px`);
  if (m.mobile && m.smallTargets > 0) add("tap-targets", "WCAG 2.5.8 Target size (≥ 24 px; 44 px recommended)", Math.min(12, m.smallTargets), `${m.smallTargets} tap targets under 24 px on a phone`);
  if (m.unnamed > 0) add("unnamed-controls", "WCAG 4.1.2 Name, role, value", Math.min(10, 2 * m.unnamed), `${m.unnamed} buttons/links with no readable name`);
  if (m.imgNoAlt > 0) add("img-alt", "WCAG 1.1.1 Non-text content", Math.min(6, m.imgNoAlt), `${m.imgNoAlt} images without alt text`);
  if (m.h1 !== 1) add("headings", "Clear page title — exactly one H1 (WCAG 2.4.6)", 5, m.h1 === 0 ? "No main heading on the page" : `${m.h1} main headings compete`);
  if (m.primaryButtons > 2) add("primary-actions", "One primary action per view (Nielsen #8, minimalist design)", Math.min(15, 5 * (m.primaryButtons - 2)), `${m.primaryButtons} filled primary buttons on one screen`);
  if (m.fontSizes > 8) add("type-scale", "Consistent type scale (Nielsen #4 consistency)", 5, `${m.fontSizes} different text sizes in use`);
  if (m.fontFamilies > 3) add("font-families", "Consistent typography (≤ 2–3 families)", 5, `${m.fontFamilies} font families in use`);
  if (m.wordsAboveFold > 350) add("dense", "Scannable first screen (Nielsen #8)", 5, `${m.wordsAboveFold} words on the first screen`);
  if (m.longestForm > 10) add("long-form", "Short forms — ask only what is needed (Nielsen #5, #7)", 6, `A form with ${m.longestForm} fields`);
  if (m.cls > 0.1) add("layout-shift", "Core Web Vitals CLS ≤ 0.1", 8, `Layout shifts by ${m.cls} while loading`);
  if (opts.production && m.lcp > 2500) add("slow-paint", "Core Web Vitals LCP ≤ 2.5 s", 8, `Main content appears after ${Math.round(m.lcp / 100) / 10} s`);
  const score = Math.max(0, 100 - issues.reduce((s, i) => s + i.deduct, 0));
  return { score, issues: issues.sort((a, b) => b.deduct - a.deduct) };
}

export const UI_CATS = ["visual", "accessibility", "layout", "consistency", "mobile", "performance"] as const;
export type UiCategory = (typeof UI_CATS)[number];
const CODE_CAT: Record<string, UiCategory> = {
  overflow: "layout", contrast: "accessibility", "tiny-text": "visual", "tap-targets": "mobile", "unnamed-controls": "accessibility",
  "img-alt": "accessibility", headings: "layout", "primary-actions": "visual", "type-scale": "consistency", "font-families": "consistency",
  dense: "layout", "long-form": "layout", "layout-shift": "performance", "slow-paint": "performance",
};
export const categoryOf = (code: string): UiCategory => CODE_CAT[code] ?? "visual";

export interface UiPage { surface: "app" | "site"; path: string; samples: number; score: number; issues: UiIssue[] }

export function uiPrompt(): string {
  return `You are a world-class product designer reviewing ResellerOS — an Indian reseller's business app (quotes, invoices, GST, leads; used by small-business owners and staff, often on phones and slow connections) and its public website (Google Workspace / Microsoft 365 / hosting plans).
You get PAGES with a design score (0–100) and MEASURED issues, each with the rule it breaks (WCAG 2.2, Nielsen heuristics, Core Web Vitals).
For each issue worth fixing, write one insight:
{"insights":[{"path":"<page>","surface":"app|site","code":"<issue code, copied exactly>","severity":"high|medium|low","category":"visual|accessibility|layout|consistency|mobile|performance","problem":"what a person sees or struggles with (1–2 lines, plain English)","fix":"the concrete design change — name the element, the spacing/size/colour/order to use, and the pattern a best-in-class product (Stripe, Linear, Razorpay, Notion) uses for it (1–3 lines)"}]}
Rules: only the issues given; never invent one. Be specific (e.g. "raise the helper text to 13 px ink-2", "keep one filled button — make the others outline"). Up to 12 insights, most score-costly first. JSON only.`;
}

export interface UiInsight { path: string; surface: "app" | "site"; signal: string; severity: "high" | "medium" | "low"; category: UiCategory; problem: string; fix: string; evidence: string; sessions: number }

export function sanitizeUiInsights(raw: unknown, pages: readonly UiPage[]): UiInsight[] {
  const list = (raw as { insights?: unknown })?.insights;
  if (!Array.isArray(list)) return [];
  const out: UiInsight[] = [];
  const s = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
  for (const x of list.slice(0, 12)) {
    const r = x as Record<string, unknown>;
    const surface = r.surface === "site" ? "site" : "app";
    const page = pages.find((p) => p.surface === surface && p.path === s(r.path, 200));
    const issue = page?.issues.find((i) => i.code === s(r.code, 40));
    if (!page || !issue) continue;
    const problem = s(r.problem, 300), fix = s(r.fix, 500);
    if (!problem || !fix) continue;
    out.push({
      path: page.path, surface, signal: `ui:${issue.code}`,
      severity: ["high", "medium", "low"].includes(r.severity as string) ? (r.severity as UiInsight["severity"]) : issue.deduct >= 10 ? "high" : "medium",
      category: UI_CATS.includes(r.category as UiCategory) ? (r.category as UiCategory) : categoryOf(issue.code),
      problem, fix, evidence: `${issue.evidence} — ${issue.rule} (page score ${page.score}/100)`.slice(0, 400), sessions: page.samples,
    });
  }
  return out;
}

/** Without AI: the measured issue with a standard fix. */
export function basicUiInsight(page: UiPage, issue: UiIssue): UiInsight {
  const FIX: Record<string, [string, string]> = {
    overflow: ["The page scrolls sideways — content is cut off on this screen size.", "Find the element wider than the screen (tables, long words, fixed widths); wrap it in a horizontal scroller or let it wrap."],
    contrast: ["Some text is too faint to read comfortably.", "Use the ink / ink-2 text colours for body text; keep ink-3 for hints only, at 13 px or larger."],
    "tiny-text": ["Text is too small to read, especially on phones.", "Use at least 12 px for any text and 14–16 px for body text."],
    "tap-targets": ["Buttons and links are too small to tap reliably on a phone.", "Give tappable things at least 24 px (ideally 44 px) height with spacing between them."],
    "unnamed-controls": ["Some buttons have no name — screen readers (and tooltips) say nothing.", "Add visible text or an aria-label to every icon button."],
    "img-alt": ["Images have no description.", "Add alt text (or alt=\"\" for decorative images)."],
    headings: ["The page has no single clear title.", "Use one H1 that names the page; make other titles H2/H3."],
    "primary-actions": ["Several equally loud buttons compete — the next step is unclear.", "Keep one filled primary button per screen; make the others outline or ghost."],
    "type-scale": ["Too many text sizes make the page look uneven.", "Stick to the type scale (e.g. 12 / 14 / 16 / 20 / 28)."],
    "font-families": ["Too many fonts make the page feel unpolished.", "Use the two app fonts (serif headings, sans body) only."],
    dense: ["The first screen is a wall of text.", "Lead with the key number or action; move detail below or behind a 'More'."],
    "long-form": ["The form asks for a lot at once.", "Ask only what is needed now; group the rest under 'More details' or a later step."],
    "layout-shift": ["Content jumps while the page loads.", "Reserve space for images, charts and late-loading cards (fixed height / skeleton)."],
    "slow-paint": ["The main content takes long to appear.", "Show the page shell first, load lists in pages, and lazy-load heavy parts."],
  };
  const [problem, fix] = FIX[issue.code] ?? ["Design issue measured here.", "Review this page."];
  return { path: page.path, surface: page.surface, signal: `ui:${issue.code}`, severity: issue.deduct >= 10 ? "high" : issue.deduct >= 6 ? "medium" : "low", category: categoryOf(issue.code), problem, fix, evidence: `${issue.evidence} — ${issue.rule} (page score ${page.score}/100)`.slice(0, 400), sessions: page.samples };
}
