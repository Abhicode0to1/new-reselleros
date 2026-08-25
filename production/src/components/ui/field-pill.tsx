/**
 * The live validation pill under a field.
 *
 * ─── FOUR STATES, AND "EMPTY" IS NOT AN ERROR ───────────────────────────────
 * An untouched field is not wrong. Painting it red before anyone has typed is how a form
 * greets you by shouting, and an operator who is shouted at from the start stops reading
 * the messages that matter later.
 *
 * `typing` is the other half of that. A half-typed GSTIN is not a mistake in progress, it
 * is a GSTIN in progress, and it gets a neutral "3 more characters" rather than a red
 * cross. Red is reserved for a value that is finished AND wrong — the only moment where
 * the operator can actually act on it.
 *
 * ─── AND IT RESERVES ITS OWN SPACE ──────────────────────────────────────────
 * `min-h` on the wrapper, so the pill appearing does not shove the next field down the
 * page mid-type. A form that jumps while you fill it is a form you mis-click.
 */
"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import type { FieldCheck } from "@/lib/forms/poka-yoke";

export function FieldPill({ check, className }: { check: FieldCheck; className?: string }) {
  return (
    <div className={cn("min-h-[18px] pt-1", className)}>
      {check.tone !== "empty" && (
        <p
          className={cn(
            "inline-flex items-center gap-1 text-2xs leading-snug",
            check.tone === "ok"     && "text-emerald",
            check.tone === "error"  && "text-rose",
            check.tone === "typing" && "text-ink-3",
          )}
          /* Announced politely so a screen-reader user hears the verdict without having
             every keystroke interrupt them. */
          role="status"
          aria-live="polite"
        >
          <span aria-hidden="true">
            {check.tone === "ok" ? "✓" : check.tone === "error" ? "✕" : "•"}
          </span>
          <span>{check.message}</span>
          {check.detail && <span className="text-ink-3">· {check.detail}</span>}
        </p>
      )}
    </div>
  );
}
