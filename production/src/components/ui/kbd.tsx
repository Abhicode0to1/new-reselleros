/**
 * A key badge — `⌘K` on a Mac, `Ctrl K` everywhere else.
 *
 * ─── WHY THE PLATFORM SWAP IS NOT COSMETIC ──────────────────────────────────
 * A badge reading `⌘K` on a Windows desk is not a small inaccuracy — it is an instruction
 * the operator cannot follow, and they conclude the shortcut is broken rather than that the
 * label is. This app runs on Windows desks and Macs both, so the registry stores "Ctrl"
 * and this component decides what to draw.
 *
 * ─── AND IT DECIDES AFTER MOUNT, ON PURPOSE ─────────────────────────────────
 * `navigator` does not exist while Next renders on the server. Reading it during render
 * would either crash the build or make the server and client disagree about the markup, so
 * the badge starts as "Ctrl" — correct for most users — and corrects itself on a Mac after
 * mount. Guessing the other way round would flash the wrong symbol at the majority.
 */
"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/** Mac, as far as the browser will admit. */
function useIsMac(): boolean {
  const [isMac, setIsMac] = React.useState(false);
  React.useEffect(() => {
    const p = navigator.platform ?? "";
    const ua = navigator.userAgent ?? "";
    setIsMac(/Mac|iPhone|iPad/.test(p) || /Mac OS X/.test(ua));
  }, []);
  return isMac;
}

/** How each key is drawn. Only where a symbol is genuinely clearer than the word. */
function glyph(key: string, isMac: boolean): string {
  switch (key) {
    case "Ctrl":  return isMac ? "⌘" : "Ctrl";
    case "Alt":   return isMac ? "⌥" : "Alt";
    case "Shift": return "⇧";
    case "Enter": return "↵";
    case "Esc":   return "Esc";
    default:      return key.length === 1 ? key.toUpperCase() : key;
  }
}

export interface KbdProps {
  /** One or more keys, e.g. ["Ctrl", "K"] or ["g", "l"]. */
  keys: readonly string[];
  className?: string;
  /**
   * A two-letter SEQUENCE is pressed one after the other, not together. Drawn with a
   * space rather than a "+", because "g+l" tells somebody to hold both and it will not
   * work.
   */
  sequence?: boolean;
}

export function Kbd({ keys, className, sequence }: KbdProps) {
  const isMac = useIsMac();
  return (
    <span className={cn("inline-flex items-center gap-0.5 align-middle", className)}>
      {keys.map((k, i) => (
        <React.Fragment key={`${k}-${i}`}>
          {i > 0 && (
            <span aria-hidden="true" className="px-0.5 text-3xs text-ink-3">
              {sequence ? "" : "+"}
            </span>
          )}
          <kbd className="rounded border border-hairline bg-paper-2 px-1.5 py-0.5 font-mono text-3xs leading-none text-ink-2 shadow-[0_1px_0_rgba(0,0,0,0.06)]">
            {glyph(k, isMac)}
          </kbd>
        </React.Fragment>
      ))}
    </span>
  );
}
