/**
 * UX observer — the pure half (3 Oct 2026). See migration 20261003100000_ux_observer.sql.
 *
 *  - maskPII / sanitizeEvent: nothing a person typed is ever sent; labels are masked for
 *    emails, phone-like digit runs, GSTIN/PAN and long numbers — in the browser and AGAIN
 *    here on the server, because a client can be old, modified or wrong.
 *  - isRageClick: 3+ clicks on the same element inside 1.2 s.
 *  - aggregate: events → per-page friction numbers.
 *  - findings: the deterministic reading (thresholds) — what the AI then explains and turns
 *    into fixes; the AI never invents a problem without a number behind it.
 *  - uxPrompt / sanitizeInsights: the model's JSON is untrusted, like every AI read here.
 */

import { sanitizeMetrics, type UiMetrics } from "@/lib/ui/score";

export const UX_KINDS = ["view", "rage_click", "dead_click", "error", "form_abandon", "stall", "quick_exit", "slow", "ui_probe"] as const;
export type UxKind = (typeof UX_KINDS)[number];
export type Surface = "app" | "site";

export interface UxEventIn {
  kind: string; path: string; target?: string | null; detail?: string | null; ms?: number | null; metrics?: unknown;
}
export interface UxEvent { kind: UxKind; path: string; target: string | null; detail: string | null; ms: number | null; metrics?: UiMetrics | null }

export function maskPII(s: string | null | undefined, max = 160): string | null {
  if (!s) return null;
  let t = String(s).replace(/\s+/g, " ").trim();
  t = t.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]");
  t = t.replace(/\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]\b/gi, "[gstin]");
  t = t.replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, "[pan]");
  t = t.replace(/\+?\d[\d\s-]{7,}\d/g, "[number]");
  t = t.replace(/\b\d{5,}\b/g, "[number]");
  return t ? t.slice(0, max) : null;
}

/** A path with ids collapsed, so /quotes/Q-FBB9-27-0006 and /leads?lead=L-X group as one page. */
export function normalisePath(p: string): string {
  const path = (p || "/").split("#")[0].split("?")[0].slice(0, 200) || "/";
  return path
    .split("/")
    .map((seg) => (/^(Q|INV|L|C|SUP|EXP|BILL|P|S)-[A-Z0-9-]+$/i.test(seg) || /^[0-9a-f-]{20,}$/i.test(seg) || /\d{3,}/.test(seg) ? "[id]" : seg))
    .join("/") || "/";
}

export function surfaceFor(path: string): Surface {
  const p = normalisePath(path);
  const site = ["/", "/pricing", "/buy", "/checkout", "/about", "/contact", "/privacy-policy", "/terms", "/hosting", "/domains", "/cart", "/done", "/email"];
  return site.some((s) => p === s || (s !== "/" && p.startsWith(s + "/"))) || p.startsWith("/buy") ? "site" : "app";
}

export function sanitizeEvent(e: UxEventIn): UxEvent | null {
  if (!e || typeof e.kind !== "string" || !UX_KINDS.includes(e.kind as UxKind)) return null;
  if (typeof e.path !== "string") return null;
  const ms = typeof e.ms === "number" && Number.isFinite(e.ms) && e.ms >= 0 ? Math.min(Math.round(e.ms), 3_600_000) : null;
  const base = { kind: e.kind as UxKind, path: normalisePath(e.path), target: maskPII(e.target, 160), detail: maskPII(e.detail, 300), ms };
  if (e.kind !== "ui_probe") return base;
  const metrics = sanitizeMetrics(e.metrics);
  return metrics ? { ...base, target: null, detail: null, metrics } : null;
}

/** 3 or more clicks on the same target inside `windowMs`. */
export function isRageClick(times: readonly number[], windowMs = 1200): boolean {
  if (times.length < 3) return false;
  const last3 = times.slice(-3);
  return last3[2] - last3[0] <= windowMs;
}

/* ── aggregation ─────────────────────────────────────────────────────────── */
export interface RowIn extends UxEvent { session_id: string; surface: Surface }

export interface PageStats {
  surface: Surface; path: string; sessions: number; views: number;
  rage: Array<{ target: string; n: number }>; dead: Array<{ target: string; n: number }>;
  errors: Array<{ text: string; n: number }>; abandons: Array<{ form: string; n: number }>;
  stalls: number; quickExits: number; slowMsP50: number | null;
}

const top = (m: Map<string, number>, k = 5) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);

export function aggregate(rows: readonly RowIn[]): PageStats[] {
  const pages = new Map<string, { s: Surface; p: string; sess: Set<string>; views: number; rage: Map<string, number>; dead: Map<string, number>; err: Map<string, number>; ab: Map<string, number>; stalls: number; qx: number; slow: number[] }>();
  for (const r of rows) {
    const key = `${r.surface}|${r.path}`;
    let g = pages.get(key);
    if (!g) { g = { s: r.surface, p: r.path, sess: new Set(), views: 0, rage: new Map(), dead: new Map(), err: new Map(), ab: new Map(), stalls: 0, qx: 0, slow: [] }; pages.set(key, g); }
    g.sess.add(r.session_id);
    const bump = (m: Map<string, number>, k: string | null) => m.set(k || "(unnamed)", (m.get(k || "(unnamed)") ?? 0) + 1);
    switch (r.kind) {
      case "view": g.views++; break;
      case "rage_click": bump(g.rage, r.target); break;
      case "dead_click": bump(g.dead, r.target); break;
      case "error": bump(g.err, r.detail); break;
      case "form_abandon": bump(g.ab, r.target); break;
      case "stall": g.stalls++; break;
      case "quick_exit": g.qx++; break;
      case "slow": if (r.ms != null) g.slow.push(r.ms); break;
    }
  }
  return [...pages.values()].map((g) => {
    const sorted = [...g.slow].sort((a, b) => a - b);
    return {
      surface: g.s, path: g.p, sessions: g.sess.size, views: g.views,
      rage: top(g.rage).map(([target, n]) => ({ target, n })),
      dead: top(g.dead).map(([target, n]) => ({ target, n })),
      errors: top(g.err).map(([text, n]) => ({ text, n })),
      abandons: top(g.ab).map(([form, n]) => ({ form, n })),
      stalls: g.stalls, quickExits: g.qx,
      slowMsP50: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    };
  }).sort((a, b) => b.sessions - a.sessions);
}

/* ── deterministic findings ──────────────────────────────────────────────── */
export interface Finding { surface: Surface; path: string; signal: string; severity: "high" | "medium" | "low"; evidence: string; sessions: number }

export function findings(stats: readonly PageStats[]): Finding[] {
  const out: Finding[] = [];
  for (const s of stats) {
    const push = (signal: string, severity: Finding["severity"], evidence: string) => out.push({ surface: s.surface, path: s.path, signal, severity, evidence, sessions: s.sessions });
    for (const r of s.rage) if (r.n >= 2) push(`rage:${r.target}`, r.n >= 5 ? "high" : "medium", `${r.n} rage-click bursts on “${r.target}”`);
    for (const d of s.dead) if (d.n >= 3) push(`dead:${d.target}`, d.n >= 8 ? "high" : "medium", `${d.n} clicks on “${d.target}”, which does nothing`);
    for (const e of s.errors) if (e.n >= 1) push(`error:${e.text}`, e.n >= 3 ? "high" : "medium", `Error shown ${e.n}×: “${e.text}”`);
    for (const a of s.abandons) if (a.n >= 2) push(`abandon:${a.form}`, a.n >= 5 ? "high" : "medium", `${a.n} people started “${a.form}” and left without submitting`);
    if (s.stalls >= 3) push("stall", s.stalls >= 8 ? "medium" : "low", `${s.stalls} sessions sat on this page 45 s+ without doing anything`);
    if (s.views >= 5 && s.quickExits / s.views >= 0.5) push("quick_exit", "medium", `${s.quickExits} of ${s.views} visits left within 10 s`);
    if (s.slowMsP50 != null && s.slowMsP50 >= 3000) push("slow", s.slowMsP50 >= 6000 ? "high" : "medium", `Typical load ${Math.round(s.slowMsP50 / 100) / 10} s`);
  }
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.sessions - a.sessions).slice(0, 25);
}

/* ── AI ───────────────────────────────────────────────────────────────────── */
export function uxPrompt(): string {
  return `You review real usage signals of ResellerOS — an Indian reseller's business app (quotes, invoices, GST, leads) and its public website (Google Workspace / Microsoft 365 / hosting plans, buy pages).
You get FINDINGS: measured friction per page (rage clicks, clicks on things that do nothing, errors shown, forms abandoned, long stalls, quick exits, slow loads), with counts.
For each finding worth acting on, return one insight in plain, short English:
{"insights":[{"path":"<page>","surface":"app|site","signal":"<the finding's signal, copied exactly>","severity":"high|medium|low","category":"confusing|broken|slow|copy|logic|flow","problem":"what the person was trying to do and what got in the way (1–2 lines)","fix":"the concrete change to make — UI, wording, flow or logic (1–3 lines; name the element)"}]}
Rules: only use the findings given — never invent a problem or a number. Merge findings that are one problem. Think as the user: what did they expect would happen? Prefer fixes that remove a step or make the next step obvious. Up to 12 insights. JSON only.`;
}

export interface Insight { path: string; surface: Surface; signal: string; severity: "high" | "medium" | "low"; category: "confusing" | "broken" | "slow" | "copy" | "logic" | "flow"; problem: string; fix: string }

const CATS = ["confusing", "broken", "slow", "copy", "logic", "flow"] as const;
const SEVS = ["high", "medium", "low"] as const;

/** Model output → insights, each tied to a real finding (unknown signals are dropped). */
export function sanitizeInsights(raw: unknown, known: readonly Finding[]): Array<Insight & { evidence: string; sessions: number }> {
  const list = (raw as { insights?: unknown })?.insights;
  if (!Array.isArray(list)) return [];
  const bySig = new Map(known.map((f) => [`${f.surface}|${f.path}|${f.signal}`, f]));
  const out: Array<Insight & { evidence: string; sessions: number }> = [];
  for (const x of list.slice(0, 12)) {
    const r = x as Record<string, unknown>;
    const s = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
    const surface = r.surface === "site" ? "site" : "app";
    const f = bySig.get(`${surface}|${s(r.path, 200)}|${s(r.signal, 200)}`);
    if (!f) continue;
    const problem = s(r.problem, 300), fix = s(r.fix, 500);
    if (!problem || !fix) continue;
    out.push({
      path: f.path, surface: f.surface, signal: f.signal,
      severity: SEVS.includes(r.severity as never) ? (r.severity as Insight["severity"]) : f.severity,
      category: CATS.includes(r.category as never) ? (r.category as Insight["category"]) : "confusing",
      problem, fix, evidence: f.evidence, sessions: f.sessions,
    });
  }
  return out;
}

/** Without AI: the finding itself, worded as a problem with a generic next step. */
export function basicInsight(f: Finding): Insight & { evidence: string; sessions: number } {
  const kind = f.signal.split(":")[0];
  const map: Record<string, [Insight["category"], string, string]> = {
    rage: ["confusing", "People click this again and again — it does not respond the way they expect.", "Make the click give instant feedback (loading state, disabled with a reason, or the action itself)."],
    dead: ["confusing", "People click something that looks clickable but does nothing.", "Make it a real link/button to where they expect to go, or make it look not clickable."],
    error: ["broken", "An error is shown to people here.", "Fix the cause; until then, say what to do next in the message."],
    abandon: ["flow", "People start this form and leave without finishing.", "Cut fields, show progress, and explain any field that blocks submit."],
    stall: ["confusing", "People stop here without acting — the next step is not obvious.", "Make the primary action stand out and say what happens next."],
    quick_exit: ["flow", "Most visits leave this page within seconds.", "Check the first screen matches what brought them here; lead with the main action."],
    slow: ["slow", "This page is slow to load.", "Load less up front (paginate / lazy-load) and show the page shell immediately."],
  };
  const [category, problem, fix] = map[kind] ?? ["confusing", "Friction measured here.", "Review this page."];
  return { path: f.path, surface: f.surface, signal: f.signal, severity: f.severity, category, problem, fix, evidence: f.evidence, sessions: f.sessions };
}

export const signatureOf = (i: { surface: Surface; path: string; signal: string }) => `${i.surface}|${i.path}|${i.signal}`.slice(0, 400);
