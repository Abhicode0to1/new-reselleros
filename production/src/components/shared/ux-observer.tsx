"use client";

/**
 * UX observer — runs only while a person is ACTIVE (3 Oct 2026; see lib/ux/signals.ts).
 *
 * Active = the tab is visible AND there was pointer / key / scroll input in the last minute.
 * Otherwise it records nothing. It never reads what is typed: only which control was
 * clicked (its visible label, masked), errors that were SHOWN, and timings. Respects the
 * browser's Do Not Track. Batches to /api/public/ux/events every 15 s and when the tab hides.
 *
 * Signals: view, rage_click (3 clicks / 1.2 s on one control), dead_click (a pointer-cursor
 * thing that is not a control and nothing happened), error (error toast or uncaught
 * error), form_abandon (fields touched, page left without a submit), stall (45 s present
 * but no click), quick_exit (left within 10 s without a click), slow (page load time).
 */
import * as React from "react";
import { usePathname } from "next/navigation";
import { maskPII, isRageClick } from "@/lib/ux/signals";

type Ev = { kind: string; path: string; target?: string | null; detail?: string | null; ms?: number | null };

const ACTIVE_MS = 60_000;
const FLUSH_MS = 15_000;
const SKIP = /^\/(api|dev|attendance\/kiosk)(\/|$)/;
const INTERACTIVE = "a,button,input,select,textarea,label,summary,[role=button],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=switch],[contenteditable=true]";

function sessionId(): string {
  try {
    const k = "ux_sid";
    let v = sessionStorage.getItem(k);
    if (!v) { v = Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem(k, v); }
    return v;
  } catch { return "nostore" + Math.random().toString(36).slice(2, 10); }
}

function labelOf(el: Element | null): string | null {
  if (!el) return null;
  const h = el as HTMLElement;
  const t = h.getAttribute("aria-label") || h.getAttribute("title") || (h.innerText || h.textContent || "").trim().split("\n")[0] || h.getAttribute("placeholder") || h.tagName.toLowerCase();
  return maskPII(t.slice(0, 80), 80);
}

function formLabel(el: Element): string {
  const dialog = el.closest("[role=dialog]");
  const scope = dialog ?? el.closest("form") ?? el.closest("section,[data-card],main");
  const head = scope?.querySelector("h1,h2,h3,[role=heading],legend");
  return maskPII((head?.textContent || scope?.getAttribute("aria-label") || "form").trim().slice(0, 60), 60) ?? "form";
}

export function UxObserver() {
  const pathname = usePathname() || "/";
  const state = React.useRef({
    sid: "", queue: [] as Ev[], lastInput: Date.now(),
    viewAt: Date.now(), clickedThisView: false, stallSent: false,
    clicks: new Map<string, number[]>(),
    form: null as null | { label: string; done: boolean },
    path: pathname, mutated: 0, off: false,
  });

  const active = () => document.visibilityState === "visible" && Date.now() - state.current.lastInput < ACTIVE_MS;
  const push = React.useCallback((e: Ev, force = false) => {
    const s = state.current;
    if (s.off || (!force && !active())) return;
    if (s.queue.length < 200) s.queue.push(e);
  }, []);

  const flush = React.useCallback((beacon = false) => {
    const s = state.current;
    if (s.off || s.queue.length === 0) return;
    const events = s.queue.splice(0, 50);
    const body = JSON.stringify({ sid: s.sid, events });
    try {
      if (beacon && navigator.sendBeacon) navigator.sendBeacon("/api/public/ux/events", new Blob([body], { type: "application/json" }));
      else void fetch("/api/public/ux/events", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
    } catch { /* best effort — never disturb the page */ }
  }, []);

  /* Leaving a page: close out the view (quick exit, abandoned form). */
  const leaveView = React.useCallback(() => {
    const s = state.current;
    const stay = Date.now() - s.viewAt;
    if (!s.clickedThisView && stay < 10_000) push({ kind: "quick_exit", path: s.path, ms: stay }, true);
    if (s.form && !s.form.done) push({ kind: "form_abandon", path: s.path, target: s.form.label }, true);
    s.form = null;
  }, [push]);

  // once: setup
  React.useEffect(() => {
    const s = state.current;
    const dnt = (navigator as Navigator & { doNotTrack?: string }).doNotTrack === "1";
    if (dnt || SKIP.test(window.location.pathname)) { s.off = true; return; }
    s.sid = sessionId();

    const onInput = () => { s.lastInput = Date.now(); };
    const onClick = (ev: MouseEvent) => {
      s.lastInput = Date.now();
      s.clickedThisView = true;
      const t = ev.target as Element | null;
      if (!t || !(t instanceof Element)) return;
      const control = t.closest(INTERACTIVE);
      const label = labelOf(control ?? t) ?? "(unnamed)";
      // rage
      const times = (s.clicks.get(label) ?? []).concat(Date.now()).slice(-5);
      s.clicks.set(label, times);
      if (isRageClick(times)) { push({ kind: "rage_click", path: s.path, target: label }); s.clicks.set(label, []); }
      // dead: looks clickable, is not a control, and nothing happens
      if (!control && getComputedStyle(t).cursor === "pointer") {
        const before = s.mutated, href = window.location.href;
        setTimeout(() => {
          if (s.mutated === before && window.location.href === href) push({ kind: "dead_click", path: s.path, target: label });
        }, 700);
      }
      // a submit-like click completes the form being filled
      if (control && s.form && /^(save|send|create|submit|add|update|pay|buy|continue|next|disburse|confirm)/i.test(label)) s.form.done = true;
    };
    const onFocus = (ev: FocusEvent) => {
      const t = ev.target as Element | null;
      if (!t || !t.matches?.("input:not([type=search]):not([type=checkbox]):not([type=radio]),textarea,select")) return;
      if (t.closest("[cmdk-root],[role=search]")) return;
      if (!s.form || s.form.done) s.form = { label: formLabel(t), done: false };
    };
    const onSubmit = () => { if (s.form) s.form.done = true; };
    const onError = (ev: ErrorEvent) => push({ kind: "error", path: s.path, detail: maskPII(ev.message, 200) }, true);

    // shown error toasts + "did anything change" for dead clicks
    const mo = new MutationObserver((muts) => {
      s.mutated++;
      for (const m of muts) for (const n of Array.from(m.addedNodes)) {
        if (!(n instanceof Element)) continue;
        const toast = n.matches?.("[data-sonner-toast][data-type=error]") ? n : n.querySelector?.("[data-sonner-toast][data-type=error]");
        if (toast) push({ kind: "error", path: s.path, detail: maskPII((toast.textContent || "").slice(0, 200), 200) }, true);
      }
    });
    mo.observe(document.body, { childList: true, subtree: true, attributes: false });

    const onHide = () => { if (document.visibilityState === "hidden") flush(true); };
    const onPageHide = () => { leaveView(); flush(true); };

    window.addEventListener("pointerdown", onInput, { passive: true });
    window.addEventListener("keydown", onInput, { passive: true });
    window.addEventListener("scroll", onInput, { passive: true });
    window.addEventListener("mousemove", onInput, { passive: true });
    document.addEventListener("click", onClick, true);
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("submit", onSubmit, true);
    window.addEventListener("error", onError);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);

    // page load time, once
    const nav = performance.getEntriesByType?.("navigation")?.[0] as PerformanceNavigationTiming | undefined;
    if (nav && nav.loadEventEnd > 0) push({ kind: "slow", path: s.path, ms: Math.round(nav.loadEventEnd) }, true);

    const tick = setInterval(() => {
      if (!s.clickedThisView && !s.stallSent && active() && Date.now() - s.viewAt > 45_000) {
        push({ kind: "stall", path: s.path, ms: Date.now() - s.viewAt });
        s.stallSent = true;
      }
    }, 5_000);
    const flusher = setInterval(() => flush(false), FLUSH_MS);

    return () => {
      mo.disconnect();
      clearInterval(tick); clearInterval(flusher);
      window.removeEventListener("pointerdown", onInput);
      window.removeEventListener("keydown", onInput);
      window.removeEventListener("scroll", onInput);
      window.removeEventListener("mousemove", onInput);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("submit", onSubmit, true);
      window.removeEventListener("error", onError);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [flush, leaveView, push]);

  // every page change: close the old view, open the new one
  React.useEffect(() => {
    const s = state.current;
    if (s.off) return;
    if (s.path !== pathname) leaveView();
    s.path = pathname;
    s.viewAt = Date.now();
    s.clickedThisView = false;
    s.stallSent = false;
    s.off = SKIP.test(pathname) || s.off;
    push({ kind: "view", path: pathname }, true);
  }, [pathname, leaveView, push]);

  return null;
}
