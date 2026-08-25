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
  /**
   * Stable slug, so a button's tooltip can point at a shortcut instead of restating it.
   *
   * A tooltip that spells the keys out in its own words is the same drift the cheat sheet
   * used to have: change `Ctrl+Shift+B` and the badge keeps promising the old keys. The
   * `shortcut` prop on <TooltipContent> takes one of these ids and reads the keys from
   * here, and the prop's TYPE is derived from this list — so a wrong id is a compile
   * error rather than a tooltip that quietly shows nothing.
   */
  id: string;
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
const SHORTCUT_DEFS = [
  { id: "search",          keys: ["Ctrl", "K"], label: "Search everything — customers, leads, quotes, invoices, domains", scope: "global", group: "Move around" },
  { id: "go-leads",        keys: ["g", "l"],    label: "Go to Leads",         scope: "global", group: "Move around" },
  { id: "go-enquiries",    keys: ["g", "e"],    label: "Go to Enquiries",     scope: "global", group: "Move around" },
  { id: "go-quotes",       keys: ["g", "q"],    label: "Go to Quotes",        scope: "global", group: "Move around" },
  { id: "go-subscriptions", keys: ["g", "s"],   label: "Go to Subscriptions", scope: "global", group: "Move around" },
  { id: "go-accounting",   keys: ["g", "a"],    label: "Go to Accounting",    scope: "global", group: "Move around" },

  { id: "next-row",        keys: ["j"],         label: "Next row",            scope: "list", group: "Lists" },
  { id: "prev-row",        keys: ["k"],         label: "Previous row",        scope: "list", group: "Lists" },
  { id: "open-row-enter",  keys: ["Enter"],     label: "Open the selected row", scope: "list", group: "Lists" },
  { id: "open-row-o",      keys: ["o"],         label: "Open the selected row", scope: "list", group: "Lists" },
  { id: "escape",          keys: ["Esc"],       label: "Close a dialog, or clear the selection", scope: "list", group: "Lists" },

  { id: "send",            keys: ["Ctrl", "Enter"], label: "Send — on a quote or a reply", scope: "form", group: "Actions" },
  { id: "add-quote-item",  keys: ["Alt", "A"],      label: "Add an item to the quote",     scope: "form", group: "Actions" },
  /* Was implemented in global-bug-reporter.tsx and listed NOWHERE — not here, so not in
     the cheat sheet either, while this file's own first line claimed to hold every
     shortcut in the app. A shortcut nobody can discover is a shortcut nobody uses; it was
     working and invisible for as long as it has existed. The handler now reads its keys
     from this entry (see matchesShortcut), so the three copies cannot drift apart. */
  { id: "report-bug",      keys: ["Ctrl", "Shift", "B"], label: "Report a bug or suggest a feature", scope: "global", group: "Actions" },

  /* Workspace tabs. Implemented in workspace-tabs-provider.tsx and, like report-bug,
     listed nowhere until now.
     Only the ones that actually WORK are listed. That file also attempts Ctrl+Tab and
     Ctrl+W, and says so plainly: the browser keeps them, and they land only in the
     installed PWA. Printing those in a cheat sheet would promise the operator something
     that does nothing on their machine, which is worse than saying nothing — they would
     press it, watch their browser switch tabs, and stop trusting the rest of the list. */
  { id: "tab-jump",   keys: ["Alt", "1–8"],         label: "Jump to workspace tab 1–8", scope: "global", group: "Move around" },
  { id: "tab-next",   keys: ["Ctrl", "Alt", "→"],   label: "Next workspace tab",        scope: "global", group: "Move around" },
  { id: "tab-prev",   keys: ["Ctrl", "Alt", "←"],   label: "Previous workspace tab",    scope: "global", group: "Move around" },
  { id: "tab-close",  keys: ["Ctrl", "Alt", "W"],   label: "Close the workspace tab",   scope: "global", group: "Move around" },

  /* ── The three single-letter action keys ──────────────────────────────────
     `n`, `q` and `i` are the letters most likely to be typed by accident, so every guard in
     this file matters more for them than for anything above: isTypingTarget, the no-modifier
     rule, the mid-chord rule (a `g` already armed means `q` is "go to Quotes", never "new
     quote"), and the open-dialog rule in useGlobalKeys.

     ─── AND NONE OF THEM CREATES ANYTHING ──────────────────────────────────
     Each one OPENS the screen or dialog where the thing is made. That is not timidity about
     shortcuts, it is CGST Rule 46: `next_document_number` allocates from a gapless
     per-tenant series, and a series with a hole in it is a compliance problem that cannot be
     undone by deleting the row. A stray keystroke must never be able to consume a document
     number. Same reasoning as the two-step confirm on a bulk delete — the cost of the two
     mistakes is not symmetric. */
  { id: "new-lead",  keys: ["n"], label: "New lead",  scope: "global", group: "Actions" },
  { id: "new-quote", keys: ["q"], label: "New quote", scope: "global", group: "Actions" },
  /* The label carries a fact about the app, not just a key. There is no "create invoice"
     screen in ResellerOS — an invoice is generated from a PAID quote, which is why the
     "New invoice" button on /invoices also routes to /quotes. A cheat sheet entry saying
     "New invoice" alone would send somebody hunting for a form that does not exist. */
  { id: "new-invoice", keys: ["i"], label: "Raise an invoice — opens Quotes, because an invoice is generated from a paid quote", scope: "global", group: "Actions" },

  { id: "help",            keys: ["?"],         label: "Show this list",      scope: "global", group: "Help" },
] as const satisfies readonly Shortcut[];

/** Every id above, as a type. A tooltip pointing at a shortcut that does not exist should
 *  not compile — that is cheaper than a test, and it cannot be forgotten. */
export type ShortcutId = (typeof SHORTCUT_DEFS)[number]["id"];

/**
 * The registry as everything else sees it.
 *
 * Two shapes on purpose. `SHORTCUT_DEFS` is `as const`, which is what makes ShortcutId a
 * union of real ids instead of plain `string`. But `as const` also freezes `keys` into
 * literal tuples, and that leaks: `s.keys.includes(someString)` stops compiling for every
 * existing caller, and the fix at each call site would be a cast — which is how a
 * type-safety win turns into a dozen small holes. Widening here keeps the strictness
 * exactly where it is useful (the id) and nowhere it is not.
 */
export const SHORTCUTS: readonly Shortcut[] = SHORTCUT_DEFS;

/** The one shortcut with this id. Throws rather than returning undefined: a missing id
 *  means a caller is out of step with the registry, and a silent no-op hides that. */
export function findShortcut(id: ShortcutId): Shortcut {
  const found = SHORTCUTS.find((s) => s.id === id);
  if (!found) throw new Error(`Unknown shortcut id: ${id}`);
  return found;
}

/**
 * The keys as plain text, e.g. "Alt+A" — for a `title` attribute, which cannot hold JSX
 * and so cannot use <Kbd>.
 *
 * Deliberately platform-NEUTRAL: a title attribute is rendered by the browser, not by us,
 * so there is nowhere to swap ⌘ in after mount. Prefer <Kbd> or a tooltip's `shortcut`
 * prop wherever markup is possible; reach for this only when the target is an attribute.
 */
export function shortcutText(id: ShortcutId): string {
  return findShortcut(id).keys.join("+");
}

/**
 * Does this keyboard event press this shortcut?
 *
 * Only for shortcuts held together with modifiers (Ctrl/Alt/Shift + a key). Sequences like
 * `g` then `l` are two events and are handled by chordStep; single letters go through
 * shouldIgnore. Ctrl is matched against ctrlKey OR metaKey so a Mac's ⌘ works — which is
 * what the badge already promises the user.
 *
 * Modifier combinations deliberately fire even while typing: shouldIgnore() exists to keep
 * BARE letters out of text fields, and someone hitting Ctrl+Shift+B mid-sentence to report
 * the bug they just hit means exactly that.
 */
export function matchesShortcut(
  shortcut: Shortcut,
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
): boolean {
  const keys = shortcut.keys;
  const wantCtrl  = keys.includes("Ctrl");
  const wantAlt   = keys.includes("Alt");
  const wantShift = keys.includes("Shift");
  const main = keys.filter((k) => k !== "Ctrl" && k !== "Alt" && k !== "Shift");
  if (main.length !== 1) return false;               // not a modifier combo

  if (wantCtrl !== (e.ctrlKey || e.metaKey)) return false;
  if (wantAlt !== e.altKey) return false;
  if (wantShift !== e.shiftKey) return false;

  const want = main[0].toLowerCase();
  const got = (e.key ?? "").toLowerCase();
  return got === want || (want === "enter" && got === "enter");
}

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

/* ── Single-letter actions ──────────────────────────────────────────────────── */

/**
 * Where each action letter goes. Keyed by shortcut id, so the cheat sheet and the handler
 * cannot describe different keys — the keys live in the registry above and only the
 * DESTINATION lives here.
 *
 * Every value is a screen, never a mutation. See the registry entries for why.
 */
const ACTION_ROUTES: Readonly<Record<string, string>> = {
  /* Opens the Add Lead dialog on the leads page — the page reads `?action=` and the param
     is stripped afterwards, so a refresh does not re-open it. */
  "new-lead": "/leads?action=add",
  "new-quote": "/quotes/new",
  /* /quotes, not /invoices. An invoice comes from a paid quote; landing the operator on the
     invoice LIST would show them the thing they already have and no way to make a new one. */
  "new-invoice": "/quotes",
};

/**
 * Where a bare action key should take the operator, or null if it should not fire.
 *
 * Pure, and it refuses in four situations — each one a way a shortcut turns into a
 * complaint rather than a convenience:
 *
 *   1. MID-CHORD. `g` is armed, so `q` means "go to Quotes". Firing "new quote" here would
 *      make the two-key shortcut unusable, because its second key is also an action key.
 *   2. WITH A MODIFIER. `Ctrl+N` opens a browser window and `Alt+I` may be an OS key.
 *      Hijacking either makes the app feel broken in a way the user blames on us.
 *   3. NOT AN ACTION KEY — every other letter, including the `g` that arms the chord.
 *   4. REPEAT. Holding a key down fires keydown continuously; without this, leaning on `n`
 *      queues a navigation per repeat.
 *
 * Typing targets and open dialogs are handled by the caller, because both need the DOM.
 */
export function actionRoute(
  state: ChordState,
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "repeat">,
): string | null {
  if (state.armed) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.repeat) return null;

  const k = (e.key ?? "").toLowerCase();
  if (k.length !== 1) return null;

  const hit = SHORTCUTS.find(
    (s) =>
      s.group === "Actions" &&
      s.scope === "global" &&
      s.keys.length === 1 &&
      s.keys[0].toLowerCase() === k,
  );
  if (!hit) return null;

  return ACTION_ROUTES[hit.id] ?? null;
}

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
