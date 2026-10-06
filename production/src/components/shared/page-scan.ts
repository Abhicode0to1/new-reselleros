"use client";

/**
 * The DOM half of AI Help's page scan (R-162). Reads the screen the tester is looking at and
 * returns findings; the rules for what counts live in lib/ai/test-trail.ts. Read-only: it
 * clicks nothing, types nothing, and skips the AI Help panel itself.
 *
 * Also exports the screen's visible headings/buttons as a short outline, so the AI can say
 * "aage kya test karein" about THIS screen rather than a generic one.
 */
import { badTextFindings, type Finding, type TrailEvent } from "@/lib/ai/test-trail";

const SELF = "[data-ai-help]";

function visible(el: Element): boolean {
  const r = (el as HTMLElement).getBoundingClientRect?.();
  if (!r || (r.width === 0 && r.height === 0)) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
}

function textLines(root: Element): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentElement;
      if (!p || p.closest(`${SELF},script,style,noscript,code,pre,textarea,[contenteditable=true]`)) return NodeFilter.FILTER_REJECT;
      return (n.textContent || "").trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let n: Node | null;
  while ((n = walker.nextNode()) && out.length < 3000) {
    const p = (n as Text).parentElement;
    if (p && visible(p)) out.push((p.innerText || n.textContent || "").trim());
  }
  return out;
}

const nameOf = (el: Element) =>
  (el.getAttribute("aria-label") || el.getAttribute("title") || (el as HTMLElement).innerText || el.getAttribute("aria-labelledby") || "").trim();

export function scanPage(trail: readonly TrailEvent[], pathname: string): { findings: Finding[]; outline: string } {
  const root = document.querySelector("main") ?? document.body;
  const findings: Finding[] = [];

  findings.push(...badTextFindings(textLines(root)));

  const broken = Array.from(root.querySelectorAll("img")).filter((i) => !i.closest(SELF) && i.complete && i.naturalWidth === 0 && visible(i));
  if (broken.length) findings.push({ kind: "broken_image", detail: `${broken.length} image(s) did not load: ${broken.slice(0, 3).map((i) => i.getAttribute("alt") || i.src.split("/").pop()?.split("?")[0]).join(", ")}` });

  const docW = document.documentElement.scrollWidth, winW = window.innerWidth;
  if (docW > winW + 4) {
    const wide = Array.from(root.querySelectorAll<HTMLElement>("*")).find((e) => !e.closest(SELF) && !e.closest("table,pre,[data-scroll-x]") && e.getBoundingClientRect().right > winW + 4 && getComputedStyle(e).overflowX === "visible");
    findings.push({ kind: "overflow", detail: `Page is ${docW - winW}px wider than the screen (${winW}px) — sideways scroll${wide ? `; widest: <${wide.tagName.toLowerCase()}> "${(wide.innerText || "").trim().slice(0, 50)}"` : ""}` });
  }

  const unnamed = Array.from(root.querySelectorAll("button,[role=button],a[href]")).filter((b) => !b.closest(SELF) && visible(b) && !nameOf(b));
  if (unnamed.length) findings.push({ kind: "unnamed_button", detail: `${unnamed.length} button/link(s) with no text or label (screen readers and testers cannot tell what they do)` });

  const here = trail.filter((e) => e.path === pathname);
  for (const e of here.filter((x) => x.kind === "api_fail").slice(-5)) findings.push({ kind: "api_fail", detail: e.text });
  for (const e of here.filter((x) => x.kind === "error" || x.kind === "toast_error").slice(-5)) findings.push({ kind: "js_error", detail: e.text });

  const nav = performance.getEntriesByType?.("navigation")?.[0] as PerformanceNavigationTiming | undefined;
  // Not in dev: the dev server compiles a page on first visit, so its load time is not the page's.
  if (nav && nav.loadEventEnd > 4000 && process.env.NODE_ENV === "production") findings.push({ kind: "slow", detail: `Page took ${(nav.loadEventEnd / 1000).toFixed(1)}s to load` });

  // Outline: headings, then the controls a tester would try, for a page-specific checklist.
  const heads = Array.from(root.querySelectorAll("h1,h2,h3")).filter((h) => !h.closest(SELF) && visible(h)).map((h) => (h as HTMLElement).innerText.trim()).filter(Boolean).slice(0, 12);
  const controls = Array.from(new Set(Array.from(root.querySelectorAll("button,[role=tab],a[href^='/'],select,input[type=checkbox]")).filter((b) => !b.closest(SELF) && visible(b)).map((b) => nameOf(b).split("\n")[0].slice(0, 40)).filter(Boolean))).slice(0, 30);
  const outline = `Headings: ${heads.join(" | ") || "—"}\nControls: ${controls.join(" | ") || "—"}`;

  return { findings, outline: outline.slice(0, 1500) };
}
