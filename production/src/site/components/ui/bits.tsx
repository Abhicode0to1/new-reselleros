"use client";
/**
 * Small shared pieces used across routes: the scroll reveal, section headings, star strip.
 *
 * Reveal implements the README's rule exactly: sections below the fold start at opacity 0 /
 * translateY(16px) and transition in via IntersectionObserver with rootMargin
 * `0px 0px -8% 0px`. Reduced-motion visitors get everything visible immediately — the CSS
 * kills the transition, and the class starts visible when IO is unavailable.
 */
import { useEffect, useRef, useState } from "react";

export function Reveal({ children, as: Tag = "div" }: { children: React.ReactNode; as?: "div" | "section" }) {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setOn(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setOn(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Tag ref={ref as never} className={`reveal${on ? " on" : ""}`}>
      {children}
    </Tag>
  );
}

export function SectionHead({ eyebrow, title, body, os }: { eyebrow?: string; title: string; body?: string; os?: boolean }) {
  return (
    <div style={{ maxWidth: 640, marginBottom: 34 }}>
      {eyebrow && (
        <div className="eyebrow" style={{ color: os ? "var(--accent)" : "var(--primary)", marginBottom: 10 }}>
          {eyebrow}
        </div>
      )}
      <h2 className="h2-section" style={{ marginBottom: body ? 10 : 0 }}>{title}</h2>
      {body && <p className="body-lg" style={{ margin: 0 }}>{body}</p>}
    </div>
  );
}

/** ✓-prefixed feature line — the handoff uses the text glyph, no icon library. */
export function Tick({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 9, fontSize: 15, color: "var(--text-secondary)", padding: "4px 0" }}>
      <span aria-hidden style={{ color: "var(--success)", fontWeight: 700 }}>✓</span>
      <span>{children}</span>
    </div>
  );
}

/** Bordered image placeholder — where a real photo/badge/screenshot goes before launch. */
export function ImageSlot({ label, height = 120 }: { label: string; height?: number }) {
  return (
    <div
      role="img"
      aria-label={`${label} (image to be supplied)`}
      style={{
        height,
        border: "1px dashed var(--border-strong)",
        borderRadius: 8,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--tint-2)",
      }}
    >
      <span className="mono-label" style={{ color: "var(--text-disabled)" }}>{label}</span>
    </div>
  );
}
