/**
 * GeminiCard — gradient-bordered AI insight card.
 *
 * Use this for AI-generated suggestions across the app:
 * - Lead scoring on Lead Pipeline
 * - Quote optimization on Quote Builder
 * - Renewal next-best-actions
 * - WhatsApp reply suggestions
 *
 * Supports streaming output (typewriter effect).
 *
 * @example
 * <GeminiCard title="Lead intelligence · Today" actions={<Button>Call now</Button>}>
 *   <b>3 leads worth focusing today.</b> Acme Corp opened your quote 3× in 24h…
 * </GeminiCard>
 *
 * @example streaming
 * <GeminiCard streaming streamedText={aiResponse} />
 */
"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface GeminiCardProps {
  title?: string;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  /**
   * A section-level control, pinned to the card's top-right corner.
   *
   * Separate from `actions` because they are different kinds of thing: `actions` are what to DO
   * about the content, and this is what to do about the CARD. A collapse chevron sitting in the
   * action row reads as a third action and leaves the scope of the collapse ambiguous — the
   * conventional place for it is the corner, and this is that corner.
   *
   * Optional, so the ten existing call sites are untouched.
   */
  collapse?: React.ReactNode;
  compact?: boolean;
  /** Streaming mode — show typewriter animation */
  streaming?: boolean;
  /** Text to stream in (used with streaming=true) */
  streamedText?: string;
  className?: string;
}

export function GeminiCard({
  title = "Gemini AI suggests",
  children,
  actions,
  collapse,
  compact = false,
  streaming = false,
  streamedText,
  className,
}: GeminiCardProps) {
  return (
    <div
      className={cn(
        "relative rounded-lg p-[1.5px]",
        "bg-gradient-to-br from-[#4285F4] via-[#9333EA] to-[#EC4899]",
        "mb-4",
        className
      )}
    >
      <div
        className={cn(
          "bg-gradient-to-br from-paper to-paper-2 rounded-lg",
          compact ? "px-3 py-2.5" : "px-4 py-3.5"
        )}
      >
        {/* Section-level control, top-right. `z-10` because the gradient border wrapper paints
            over the corner otherwise, and the title row is allowed to run under it. */}
        {collapse && <div className="absolute right-2.5 top-2.5 z-10">{collapse}</div>}

        {/* Title row */}
        <div className={cn("flex items-center gap-1.5", compact ? "mb-1" : "mb-2")}>
          <GeminiSpark size={14} />
          <span
            className="text-3xs font-bold uppercase tracking-wider"
            style={{
              background: "linear-gradient(90deg, #4285F4, #9333EA, #EC4899)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            {title}
          </span>
          {streaming && <StreamingDots />}
        </div>

        {/* Body */}
        <div className={cn("text-ink leading-relaxed", compact ? "text-xs" : "text-sm")}>
          {streamedText ?? children}
          {streaming && <span className="inline-block w-0.5 h-3 bg-ink ml-0.5 animate-pulse" aria-hidden />}
        </div>

        {/* Actions */}
        {actions && !streaming && (
          <div className="flex gap-1.5 mt-2.5 flex-wrap">{actions}</div>
        )}
      </div>
    </div>
  );
}

/**
 * Gemini sparkle icon — inline SVG with gradient fill.
 * Reused by GeminiCard and elsewhere (e.g., AI buttons).
 */
export function GeminiSpark({ size = 16, className }: { size?: number; className?: string }) {
  const id = React.useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn("inline-block flex-shrink-0", className)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`gemini-${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4285F4" />
          <stop offset="50%" stopColor="#9333EA" />
          <stop offset="100%" stopColor="#EC4899" />
        </linearGradient>
      </defs>
      <path fill={`url(#gemini-${id})`} d="M12 2 L14 9 L21 11 L14 13 L12 20 L10 13 L3 11 L10 9 Z" />
    </svg>
  );
}

function StreamingDots() {
  return (
    <span className="inline-flex gap-0.5 ml-2" aria-label="Generating">
      <span className="w-1 h-1 rounded-full bg-indigo animate-bounce" style={{ animationDelay: "0ms" }} />
      <span className="w-1 h-1 rounded-full bg-indigo animate-bounce" style={{ animationDelay: "150ms" }} />
      <span className="w-1 h-1 rounded-full bg-indigo animate-bounce" style={{ animationDelay: "300ms" }} />
    </span>
  );
}
