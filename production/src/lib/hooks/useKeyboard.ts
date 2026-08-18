/**
 * The keyboard hooks. All the decisions live in lib/keyboard/shortcuts.ts; these only
 * attach listeners and call them.
 *
 * ─── WHY THE LISTENERS ARE THIN ─────────────────────────────────────────────
 * Every rule that could be wrong — is the operator typing, has the `g` expired, does
 * clamping wrap — is a pure function with a test. What is left here is plumbing, which
 * cannot be unit-tested meaningfully and therefore should contain nothing worth testing.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  chordStep, CHORD_IDLE, shouldIgnore, listAction, moveIndex,
  type ChordState,
} from "@/lib/keyboard/shortcuts";

/**
 * `g` then a letter jumps between pages, and `?` opens the cheat sheet.
 *
 * Mounted once, in the app shell. Mounting it per page would stack listeners and fire a
 * navigation several times for one keypress.
 */
export function useGlobalKeys(onShowHelp: () => void): void {
  const router = useRouter();
  /* A ref, not state: a re-render per keystroke would be pointless work, and state here
     would make the handler close over a stale value. */
  const chord = React.useRef<ChordState>(CHORD_IDLE);

  /* The callback in a ref too, so a parent passing an inline arrow does not re-attach the
     listener on every render. */
  const helpRef = React.useRef(onShowHelp);
  helpRef.current = onShowHelp;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnore(e)) return;

      if (e.key === "?") {
        e.preventDefault();
        helpRef.current();
        return;
      }

      const r = chordStep(chord.current, e.key, Date.now());
      chord.current = r.next;
      if (r.go) {
        /* preventDefault only once a sequence has COMPLETED. Swallowing the bare `g`
           would break typing anywhere this hook has not already bailed out. */
        e.preventDefault();
        router.push(r.go as never);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);
}

export interface ListKeysOptions {
  /** How many rows are currently rendered. Changes as filters change. */
  count: number;
  /** Called with the index to open. */
  onOpen: (index: number) => void;
  /** Off while a dialog is open — otherwise j/k moves the list behind it. */
  enabled?: boolean;
}

export interface ListKeys {
  /** -1 when nothing is selected. */
  index: number;
  setIndex: (i: number) => void;
}

/**
 * j / k / Enter / o / Esc over a list.
 *
 * ─── THE SELECTION IS CLAMPED ON EVERY RENDER, NOT JUST ON KEYPRESS ─────────
 * A filter or a search can shrink the list under an existing selection. Leaving the index
 * where it was would let the next Enter open a row that is no longer there — or, worse,
 * a DIFFERENT row that has moved into that position. Re-clamping when `count` changes is
 * what keeps "the highlighted row" and "the row Enter opens" the same row.
 */
export function useListKeys({ count, onOpen, enabled = true }: ListKeysOptions): ListKeys {
  const [index, setIndex] = React.useState(-1);

  React.useEffect(() => {
    setIndex((i) => (i < 0 ? -1 : Math.min(i, count - 1)));
  }, [count]);

  const openRef = React.useRef(onOpen);
  openRef.current = onOpen;

  React.useEffect(() => {
    if (!enabled) return;

    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnore(e)) return;

      const action = listAction(e.key);
      if (!action) return;

      /* Escape is handled even with nothing selected — it is also "close this", and a
         dialog above us will have stopped propagation before we see it. */
      if (action === "clear") { setIndex(-1); return; }

      e.preventDefault();
      if (action === "next" || action === "prev") {
        setIndex((i) => moveIndex(i, action === "next" ? 1 : -1, count));
        return;
      }
      /* Open. Read the index through the setter so the handler cannot act on a stale
         value captured when the listener was attached. */
      setIndex((i) => {
        if (i >= 0 && i < count) openRef.current(i);
        return i;
      });
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count, enabled]);

  return { index, setIndex };
}
