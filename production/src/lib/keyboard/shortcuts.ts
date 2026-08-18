/**
 * Every keyboard shortcut in the app, in one place, with the rules that stop them firing
 * at the wrong moment.
 *
 * ─── THE FAILURE MODE THAT MATTERS ──────────────────────────────────────────
 * A single-letter shortcut is a character somebody types. `j` and `k` move a list — and
 * they are also two letters in "Rajesh". `?` opens the cheat sheet, and it is also the
 * last character of a question typed into a search box. If a shortcut fires while an input
 * has focus, the operator does not experience a clever shortcut; they experience a form
 * that eats their typing and a page that jumps for no reason.
 *
 * So `isTypingTarget()` is the most important function in this file, and it is deliberately
 * generous: it refuses in inputs, textareas, selects, contenteditable regions, and anything
 * with a combobox or textbox role, because a false negative loses somebody's work and a
 * false positive only means a shortcut did not fire.
 *
 * ─── AND ONE REGISTRY, NOT THREE ────────────────────────────────────────────
 * The cheat sheet, the hint bar and the handlers all read SHORTCUTS. A cheat sheet
 * maintained separately from the handlers is a lie with a nice layout — it drifts the first
 * time somebody changes a key and does not think to update the documentation. Here the
 * documentation IS the definition.
 */

export type ShortcutScope =
  /** Works anywhere in the app. */
  | "global"
  /** Only on a page showing a list or table. */
  | "list"
  /** Only inside a form or an editor. */
  | "form";

export interface Shortcut {
  /** How the keys are drawn, e.g. ["g", "l"] or ["Ctrl", "K"]. */
  keys: readonly string[];
  label: string;
  scope: ShortcutScope;
  /** Grouping in the cheat sheet. */
  group: "Move around" | "Lists" | "Actions" | "Help";
}

/**
 * The whole map. Order is the order the cheat sheet shows.
 *
 * `Ctrl` is written rather than `⌘` because the badge component swaps it per platform —
 * hard-coding one would be wrong for half the users, and this app runs on Windows desks
 * and Macs both.
 */
export const SHORTCUTS: readonly Shortcut[] = [
  { keys: ["Ctrl", "K"], label: "Search everything — customers, leads, quotes, invoices, domains", scope: "global", group: "Move around" },
  { keys: ["g", "l"],    label: "Go to Leads",         scope: "global", group: "Move around" },
  { keys: ["g", "e"],    label: "Go to Enquiries",     scope: "global", group: "Move around" },
  { keys: ["g", "q"],    label: "Go to Quotes",        scope: "global", group: "Move around" },
  { keys: ["g", "s"],    label: "Go to Subscriptions", scope: "global", group: "Move around" },
  { keys: ["g", "a"],    label: "Go to Accounting",    scope: "global", group: "Move around" },

  { keys: ["j"],         label: "Next row",            scope: "list", group: "Lists" },
  { keys: ["k"],         label: "Previous row",        scope: "list", group: "Lists" },
  { keys: ["Enter"],     label: "Open the selected row", scope: "list", group: "Lists" },
  { keys: ["o"],         label: "Open the selected row", scope: "list", group: "Lists" },
  { keys: ["Esc"],       label: "Close a dialog, or clear the selection", scope: "list", group: "Lists" },

  { keys: ["Ctrl", "Enter"], label: "Send — on a quote or a reply", scope: "form", group: "Actions" },
  { keys: ["Alt", "A"],      label: "Add an item to the quote",     scope: "form", group: "Actions" },

  { keys: ["?"],         label: "Show this list",      scope: "global", group: "Help" },
] as const;

/** The cheat sheet's sections, derived so it can never disagree with the map above. */
export function shortcutGroups(): { group: Shortcut["group"]; items: Shortcut[] }[] {
  const order: Shortcut["group"][] = ["Move around", "Lists", "Actions", "Help"];
  return order
    .map((group) => ({ group, items: SHORTCUTS.filter((s) => s.group === group) }))
    .filter((g) => g.items.length > 0);
}

/* ── Is the operator typing? ────────────────────────────────────────────────── */

/**
 * Anything that swallows a keystroke as text.
 *
 * Generous on purpose. A false negative here means a shortcut steals a character out of
 * somebody's sentence — or worse, `Esc` throws away a half-written reply. A false positive
 * only means a shortcut did not fire and they press it again.
 *
 * `isContentEditable` covers rich editors. The role checks cover component libraries that
 * build a text field out of a div, which this app's Select does.
 */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!el || typeof el !== "object" || !("tagName" in el)) return false;
  const node = el as HTMLElement;

  const tag = (node.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (node.isContentEditable) return true;

  const role = node.getAttribute?.("role");
  if (role === "textbox" || role === "combobox" || role === "searchbox") return true;

  /* A dialog's own OK button is not a typing target, but a field NESTED in one is — walk up
     for an editable ancestor rather than trusting the exact element the event landed on,
     because a keydown inside a composed input can target a wrapper. */
  return Boolean(node.closest?.("input, textarea, select, [contenteditable=true]"));
}

/**
 * Should a plain single-letter shortcut be ignored for this event?
 *
 * Modifiers are the other half. `Ctrl+J` is a browser shortcut and `Alt+K` may be an OS
 * one; hijacking them makes the app feel broken in a way the user blames on us. Only a
 * bare keypress drives the single-letter shortcuts.
 */
export function shouldIgnore(e: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "target">): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return true;
  return isTypingTarget(e.target);
}

/* ── The `g` then letter sequence ───────────────────────────────────────────── */

/** Where each `g` sequence goes. */
export const GO_TO: Readonly<Record<string, string>> = {
  l: "/leads",
  e: "/enquiries",
  q: "/quotes",
  s: "/subscriptions",
  a: "/accounting",
};

/**
 * How long a `g` stays armed, in milliseconds.
 *
 * Short enough that a `g` typed as part of nothing in particular does not turn the NEXT
 * keystroke into a navigation minutes later; long enough for a human to press two keys.
 * 1200ms is roughly the gap between deliberate keys and unrelated ones.
 */
export const CHORD_WINDOW_MS = 1200;

export type ChordState = { armed: false } | { armed: true; at: number };

export const CHORD_IDLE: ChordState = { armed: false };

export interface ChordResult {
  next: ChordState;
  /** Where to navigate, when the sequence completed. */
  go?: string;
}

/**
 * Feed one keypress to the `g`-sequence machine.
 *
 * Pure, so the whole thing is testable without a browser and without faking time — `now` is
 * passed in. The alternative, reading Date.now() inside, is how a timing rule ends up
 * untested and wrong at midnight.
 */
export function chordStep(state: ChordState, key: string, now: number): ChordResult {
  const k = key.toLowerCase();

  if (state.armed) {
    /* Expired — but a `g` typed now re-arms rather than doing nothing, because the second
       `g` of "gg" is far more likely to be the start of an intent than the end of one. */
    if (now - state.at > CHORD_WINDOW_MS) {
      return k === "g" ? { next: { armed: true, at: now } } : { next: CHORD_IDLE };
    }
    const dest = GO_TO[k];
    if (dest) return { next: CHORD_IDLE, go: dest };
    /* An unrecognised second key disarms. Staying armed would make the NEXT letter jump,
       which is the behaviour that makes people distrust shortcuts. */
    return { next: k === "g" ? { armed: true, at: now } : CHORD_IDLE };
  }

  return k === "g" ? { next: { armed: true, at: now } } : { next: CHORD_IDLE };
}

/* ── Moving through a list ──────────────────────────────────────────────────── */

/**
 * The next selected index for a j/k press.
 *
 * Clamps rather than wrapping. Wrapping from the last row to the first is disorienting in a
 * list of eight hundred subscriptions: the operator presses `j` expecting nothing to happen
 * and is silently back at the top, where the next `Enter` opens the wrong record.
 *
 * `-1` means nothing is selected yet; `j` from there selects the first row, which is what
 * makes the keyboard usable without touching the mouse first.
 */
export function moveIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return Math.max(0, Math.min(count - 1, current + delta));
}

/** What a list keypress means. Null when the key is not ours. */
export type ListAction = "next" | "prev" | "open" | "clear" | null;

export function listAction(key: string): ListAction {
  switch (key) {
    case "j": case "ArrowDown": return "next";
    case "k": case "ArrowUp":   return "prev";
    case "Enter": case "o":     return "open";
    case "Escape":              return "clear";
    default:                    return null;
  }
}
