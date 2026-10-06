/**
 * UI agent — the in-browser design measurement (3 Oct 2026). Numbers only; no text leaves.
 * Scored by lib/ui/score.ts. Called by the UX observer once per page per visit, while active.
 */
import type { UiMetrics } from "@/lib/ui/score";

type RGBA = [number, number, number, number];

function parse(c: string): RGBA | null {
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}
function lum([r, g, b]: RGBA): number {
  const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function bgOf(el: Element | null): RGBA {
  for (let e = el; e; e = e.parentElement) {
    const c = parse(getComputedStyle(e).backgroundColor);
    if (c && c[3] > 0.5) return c;
    if (getComputedStyle(e).backgroundImage !== "none") return [128, 128, 128, 1]; // image behind — unknown, treat as mid
  }
  return [255, 255, 255, 1];
}
const visible = (el: Element) => {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
};
function saturated(c: RGBA | null): boolean {
  if (!c || c[3] < 0.6) return false;
  const [r, g, b] = c.map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max - min > 0.35 && max > 0.3;
}

/* Layout shift and largest paint, collected from page start. */
let cls = 0, lcp = 0, started = false;
export function startVitals() {
  if (started || typeof PerformanceObserver === "undefined") return;
  started = true;
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) if (!e.hadRecentInput) cls += e.value; })
      .observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((l) => { const e = l.getEntries().at(-1); if (e) lcp = Math.round(e.startTime); })
      .observe({ type: "largest-contentful-paint", buffered: true });
  } catch { /* unsupported browser */ }
}

export function measureUi(): UiMetrics {
  const vw = window.innerWidth, vh = window.innerHeight;
  const mobile = vw < 768 ? 1 : 0;
  const doc = document.documentElement;
  const overflowX = doc.scrollWidth - doc.clientWidth > 4 ? 1 : 0;
  const main = document.querySelector("main") ?? document.body;

  const h1 = Array.from(document.querySelectorAll("h1")).filter(visible).length;

  // text elements: elements with their own non-empty text
  const texts: HTMLElement[] = [];
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
  const seen = new Set<Element>();
  while (walker.nextNode() && texts.length < 300) {
    const n = walker.currentNode as Text;
    const el = n.parentElement;
    if (!el || seen.has(el) || !n.textContent?.trim()) continue;
    if (el.closest("script,style,noscript,svg,[aria-hidden=true]")) continue;
    seen.add(el);
    if (visible(el)) texts.push(el);
  }
  let tinyText = 0, lowContrast = 0, words = 0;
  const sizes = new Set<string>(), families = new Set<string>();
  for (const el of texts) {
    const cs = getComputedStyle(el);
    const px = parseFloat(cs.fontSize);
    sizes.add(cs.fontSize);
    families.add(cs.fontFamily.split(",")[0].trim().replace(/["']/g, "").toLowerCase());
    if (px < 12) tinyText++;
    const fg = parse(cs.color);
    if (fg && fg[3] > 0.2) {
      const bg = bgOf(el);
      const a = lum(fg), b = lum(bg);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const large = px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) lowContrast++;
    }
    const r = el.getBoundingClientRect();
    if (r.top < vh) words += (el.textContent ?? "").trim().split(/\s+/).length;
  }

  const controls = Array.from(main.querySelectorAll("a[href],button,[role=button],input:not([type=hidden]),select,textarea")).filter(visible);
  let smallTargets = 0, unnamed = 0, primaryButtons = 0;
  for (const c of controls) {
    const r = c.getBoundingClientRect();
    const inline = c.tagName === "A" && getComputedStyle(c).display === "inline";
    if (mobile && !inline && (r.width < 24 || r.height < 24)) smallTargets++;
    const isBtn = c.tagName === "BUTTON" || c.getAttribute("role") === "button" || c.tagName === "A";
    if (isBtn) {
      const name = (c.getAttribute("aria-label") || c.getAttribute("title") || (c as HTMLElement).innerText || "").trim();
      if (!name) unnamed++;
      if (r.top < vh && saturated(parse(getComputedStyle(c).backgroundColor)) && r.width > 40) primaryButtons++;
    }
  }
  const imgNoAlt = Array.from(main.querySelectorAll("img")).filter((i) => visible(i) && !i.hasAttribute("alt")).length;

  let longestForm = 0;
  for (const scope of Array.from(document.querySelectorAll("form,[role=dialog]"))) {
    const n = Array.from(scope.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]),select,textarea")).filter(visible).length;
    longestForm = Math.max(longestForm, n);
  }

  return {
    vw, mobile, overflowX, h1, tinyText, lowContrast, smallTargets, unnamed, imgNoAlt, primaryButtons,
    fontSizes: sizes.size, fontFamilies: families.size, wordsAboveFold: words, longestForm,
    cls: Math.round(cls * 1000) / 1000, lcp,
  };
}
