/**
 * The three things Radix does for a dialog that a hand-written overlay does not.
 *
 * Seven overlays in this app carry `role="dialog"` on a plain <div> rather than
 * on <DialogContent> — two of them on the customer-facing quote acceptance page,
 * which is the money path. Measured there, on a real quote, before this existed:
 *
 *   Escape                        did nothing
 *   isDialogOpen() could see it   no — the guard matches [data-state="open"]
 *   focus after opening           still on the trigger BEHIND the overlay
 *
 * The third is the one that hurts most: a person opening the PO dialog with a
 * keyboard was left outside it, and had to tab the whole page to reach the
 * field they had just asked for.
 *
 * ─── WHY NOT JUST CONVERT THEM TO <Dialog> ──────────────────────────────────
 * Because that is a bigger change than it looks — these are bottom sheets on a
 * phone with their own rounding, their own backdrop click, and in two cases a
 * layout that does not survive being reparented into a portal. This closes the
 * accessibility gap without touching what they look like. Converting them is
 * still worth doing and is a separate piece of work.
 *
 * ─── WHY NO FOCUS TRAP ──────────────────────────────────────────────────────
 * Deliberately not implemented here. A half-written trap is worse than none: it
 * is the thing that produces a page you cannot tab out of (WCAG 2.1.2), and
 * doing it properly means handling shift-Tab, sentinels and portals — which is
 * what Radix already has. This moves focus IN and puts it BACK, which is the
 * part a person notices, and leaves the trap to the conversion.
 *
 * This file is plumbing on purpose (see the note in useKeyboard.ts): there is
 * no decision here worth a unit test, and it is verified in a browser instead.
 */
"use client";

import * as React from "react";

/** Anything a person can land on, in the order the overlay presents them. */
const FOCUSABLE =
  'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), ' +
  'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function useHandRolledModal<T extends HTMLElement = HTMLDivElement>(
  onClose: () => void,
  open = true,
): React.RefObject<T> {
  const ref = React.useRef<T>(null);
  /* A ref, not a dependency: re-running the effect on every render of the
     parent would re-steal focus while somebody is typing in the dialog. */
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;

  React.useEffect(() => {
    if (!open) return;

    const returnTo = document.activeElement as HTMLElement | null;

    /* Focus the first real control, falling back to the overlay itself — which
       is why the call site needs tabIndex={-1} on it. */
    const node = ref.current;
    if (node) {
      const first = node.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? node).focus?.();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      /* Stop here: without this the list hooks below also see Escape and clear
         a selection the person never touched. */
      e.stopPropagation();
      closeRef.current();
    };
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("keydown", onKey);
      /* Put focus back where it came from, so closing does not dump the person
         at the top of the document. */
      if (returnTo && document.contains(returnTo)) returnTo.focus?.();
    };
  }, [open]);

  return ref;
}
