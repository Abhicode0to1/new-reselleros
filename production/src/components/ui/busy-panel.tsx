"use client";

/**
 * "We're working on it" — shown while a customer waits on the server.
 *
 * Owner, 30 Sep 2026: "tell users that they are sending email or processing things while
 * background work happens, so that user knows things are happening, not just stuck at a
 * page". Starting a trial took up to 30 s behind a button that only said "Starting your
 * trial…", and it read as a frozen page.
 *
 * What it shows, and why it is honest:
 *   - a title naming the action ("Starting your free trial");
 *   - WHAT the server is doing, as a plain list — not ticked off one by one, because the
 *     server does them in one request and the page cannot know which is finished;
 *   - how long it has been, counting up, so a wait is visibly a wait and not a hang;
 *   - after `slowAfterSec`, a line saying it is slower than usual and to keep the page open.
 * It announces itself to screen readers (role="status", aria-live="polite") and respects
 * prefers-reduced-motion.
 *
 * Plain inline styles with CSS-variable fallbacks, so it looks right on the public site
 * (site.css) and on the Tailwind pages (quote accept) alike.
 */
import * as React from "react";

export interface BusyPanelProps {
  /** Show it. When this goes false the panel disappears and the clock resets. */
  active: boolean;
  /** The action, as the customer would say it: "Starting your free trial". */
  title: string;
  /** What is happening, in order: "Checking you haven't had a trial before", … */
  steps: string[];
  /** Seconds before the "taking longer than usual" line appears. */
  slowAfterSec?: number;
}

export function BusyPanel({ active, title, steps, slowAfterSec = 8 }: BusyPanelProps) {
  const [secs, setSecs] = React.useState(0);

  React.useEffect(() => {
    if (!active) { setSecs(0); return; }
    const t0 = Date.now();
    setSecs(0);
    const id = window.setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 500);
    return () => window.clearInterval(id);
  }, [active]);

  if (!active) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-busy-panel
      style={{
        border: "1px solid var(--border-hairline, #E3E8EF)",
        background: "var(--surface-muted, #F6F8FB)",
        borderRadius: 10,
        padding: "14px 16px",
        margin: "12px 0",
        fontSize: 14,
        color: "var(--text-secondary, #475467)",
      }}
    >
      <style>{`
        @keyframes busy-panel-spin { to { transform: rotate(360deg); } }
        [data-busy-panel] .busy-panel-spinner { animation: busy-panel-spin 0.9s linear infinite; }
        @media (prefers-reduced-motion: reduce) { [data-busy-panel] .busy-panel-spinner { animation: none; } }
      `}</style>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          className="busy-panel-spinner"
          aria-hidden
          style={{
            width: 16, height: 16, flexShrink: 0, borderRadius: "50%",
            border: "2px solid var(--border-strong, #C8D0DA)",
            borderTopColor: "var(--primary, #1A6BE0)",
          }}
        />
        <strong style={{ color: "var(--text-primary, #101828)" }}>{title}…</strong>
        <span style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums", color: "var(--text-muted, #667085)" }}>
          {secs}s
        </span>
      </div>
      {steps.length > 0 && (
        <ul style={{ margin: "10px 0 0 26px", padding: 0, listStyle: "disc", lineHeight: 1.6 }}>
          {steps.map((s) => <li key={s}>{s}</li>)}
        </ul>
      )}
      {secs >= slowAfterSec && (
        <p style={{ margin: "10px 0 0", color: "var(--text-primary, #101828)" }}>
          This is taking a little longer than usual. Please keep this page open — there is no need
          to press the button again.
        </p>
      )}
    </div>
  );
}
