/**
 * The `?` cheat sheet, and the hint bar under a list.
 *
 * ─── BOTH READ THE SAME REGISTRY ────────────────────────────────────────────
 * Neither of these contains a hard-coded key. They render lib/keyboard/shortcuts.ts, which
 * is also what the handlers read — so a cheat sheet that lists a shortcut nobody
 * implemented, or omits one that works, is not possible here. There is a test asserting
 * that every handled key appears in the registry.
 *
 * A cheat sheet maintained separately from the code is a lie with a nice layout; it drifts
 * the first time somebody changes a key and does not think of the documentation.
 */
"use client";

import * as React from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { shortcutGroups, type Shortcut } from "@/lib/keyboard/shortcuts";

/** A sequence is two keys pressed in turn — drawn without a "+". */
function isSequence(s: Shortcut): boolean {
  return s.keys.length === 2 && s.keys[0] === "g";
}

export function ShortcutsSheet({ open, onOpenChange }: {
  open: boolean; onOpenChange: (v: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Press <Kbd keys={["?"]} /> any time to see this. Shortcuts stay out of the way
            while you are typing in a field.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {shortcutGroups().map(({ group, items }) => (
            <div key={group}>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                {group}
              </p>
              <ul className="space-y-1">
                {items.map((s) => (
                  <li key={`${group}-${s.keys.join("-")}-${s.label}`} className="flex items-baseline gap-3">
                    <span className="w-24 shrink-0">
                      <Kbd keys={s.keys} sequence={isSequence(s)} />
                    </span>
                    <span className="text-[13px] leading-snug text-ink-2">{s.label}</span>
                    {/* The scope is stated, because "j moves the list" is confusing on a
                        page with no list — and somebody WILL try it there first. */}
                    {s.scope !== "global" && (
                      <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-ink-3">
                        {s.scope === "list" ? "on a list" : "in a form"}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The floating hint bar on a table view.
 *
 * ─── IT ONLY APPEARS ONCE A KEY HAS BEEN USED ───────────────────────────────
 * A permanent bar across the bottom of every list is chrome an operator stops seeing within
 * a day, and it costs 40px of a phone screen for ever. This one is hidden until the first
 * j/k press proves somebody is driving by keyboard, and it then stays for the session —
 * which is exactly when a reminder of `Enter` and `?` is useful.
 */
export function KeyHintBar({ visible, onShowHelp, className }: {
  visible: boolean; onShowHelp: () => void; className?: string;
}) {
  if (!visible) return null;
  return (
    <div
      className={cn(
        "pointer-events-auto fixed bottom-4 left-1/2 z-30 -translate-x-1/2",
        "flex items-center gap-3 rounded-full border border-hairline bg-paper/95 px-3.5 py-1.5",
        "shadow-lg backdrop-blur",
        /* Clears the mobile bottom nav so it never sits on top of the tab bar. */
        "mb-[env(safe-area-inset-bottom)] md:mb-0",
        className,
      )}
      role="status"
    >
      <span className="flex items-center gap-1.5 text-[11px] text-ink-2">
        <Kbd keys={["j"]} /><Kbd keys={["k"]} /> Navigate
      </span>
      <span aria-hidden="true" className="text-ink-3">·</span>
      <span className="flex items-center gap-1.5 text-[11px] text-ink-2">
        <Kbd keys={["Enter"]} /> Open
      </span>
      <span aria-hidden="true" className="text-ink-3">·</span>
      <button
        type="button"
        onClick={onShowHelp}
        className="flex items-center gap-1.5 text-[11px] text-amber-ink hover:underline"
      >
        <Kbd keys={["?"]} /> Shortcuts
      </button>
    </div>
  );
}
