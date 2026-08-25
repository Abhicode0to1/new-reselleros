import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SHORTCUTS, shortcutGroups, isTypingTarget, shouldIgnore,
  chordStep, CHORD_IDLE, CHORD_WINDOW_MS, GO_TO,
  moveIndex, listAction,
  findShortcut, matchesShortcut, shortcutText, actionRoute, type ShortcutId,
} from "./shortcuts";

/** A DOM-ish stand-in, so these rules are testable without a browser. */
function el(tag: string, opts: {
  role?: string; editable?: boolean; insideEditable?: boolean;
} = {}): EventTarget {
  return {
    tagName: tag,
    isContentEditable: opts.editable ?? false,
    getAttribute: (k: string) => (k === "role" ? opts.role ?? null : null),
    closest: (sel: string) => (opts.insideEditable && /input|textarea/.test(sel) ? {} : null),
  } as unknown as EventTarget;
}

/**
 * ─── THE RULE EVERYTHING ELSE DEPENDS ON ────────────────────────────────────
 * `j` and `k` are two letters in "Rajesh". `?` is the last character of a typed question.
 * A shortcut that fires while an input has focus is not a clever shortcut — it is a form
 * that eats your typing and a page that jumps for no reason.
 */
describe("shortcuts never fire while somebody is typing", () => {
  it("refuses in every kind of text field", () => {
    for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(isTypingTarget(el(tag)), tag).toBe(true);
    }
    expect(isTypingTarget(el("DIV", { editable: true }))).toBe(true);
  });

  it("refuses in a div that a component library dressed up as a text field", () => {
    /* This app's Select builds a combobox out of a div — a tag check alone would miss it. */
    for (const role of ["textbox", "combobox", "searchbox"]) {
      expect(isTypingTarget(el("DIV", { role })), role).toBe(true);
    }
  });

  it("refuses when the event landed on a wrapper INSIDE a field", () => {
    /* A keydown in a composed input can target a span; trusting the exact element would
       let the shortcut through. */
    expect(isTypingTarget(el("SPAN", { insideEditable: true }))).toBe(true);
  });

  it("allows a plain page element", () => {
    expect(isTypingTarget(el("DIV"))).toBe(false);
    expect(isTypingTarget(el("BODY"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  /**
   * Ctrl+J and Alt+K belong to the browser and the OS. Hijacking them makes the app feel
   * broken in a way the user blames on us.
   */
  it("leaves modified keypresses to the browser", () => {
    const base = { metaKey: false, ctrlKey: false, altKey: false, target: el("BODY") };
    expect(shouldIgnore(base)).toBe(false);
    expect(shouldIgnore({ ...base, ctrlKey: true })).toBe(true);
    expect(shouldIgnore({ ...base, metaKey: true })).toBe(true);
    expect(shouldIgnore({ ...base, altKey: true })).toBe(true);
  });

  it("ignores a bare keypress that landed in an input", () => {
    expect(shouldIgnore({
      metaKey: false, ctrlKey: false, altKey: false, target: el("INPUT"),
    })).toBe(true);
  });
});

describe("the g-then-letter sequence", () => {
  it("navigates on the second key", () => {
    const armed = chordStep(CHORD_IDLE, "g", 1000);
    expect(armed.next).toEqual({ armed: true, at: 1000 });
    expect(armed.go).toBeUndefined();

    expect(chordStep(armed.next, "l", 1100).go).toBe("/leads");
  });

  it("covers every page the goal names", () => {
    const expected = {
      l: "/leads", e: "/enquiries", q: "/quotes",
      s: "/subscriptions", a: "/accounting",
    };
    expect(GO_TO).toEqual(expected);
    for (const [k, dest] of Object.entries(expected)) {
      const armed = chordStep(CHORD_IDLE, "g", 0);
      expect(chordStep(armed.next, k, 10).go, k).toBe(dest);
    }
  });

  it("is case-insensitive, so Caps Lock does not break it", () => {
    const armed = chordStep(CHORD_IDLE, "G", 0);
    expect(chordStep(armed.next, "L", 10).go).toBe("/leads");
  });

  /**
   * Otherwise a `g` typed minutes ago turns the NEXT keystroke into a navigation, which
   * feels like the app moved on its own.
   */
  it("expires after the window", () => {
    const armed = chordStep(CHORD_IDLE, "g", 0);
    const late  = chordStep(armed.next, "l", CHORD_WINDOW_MS + 1);
    expect(late.go).toBeUndefined();
    expect(late.next).toEqual(CHORD_IDLE);
  });

  it("still navigates at exactly the window edge", () => {
    const armed = chordStep(CHORD_IDLE, "g", 0);
    expect(chordStep(armed.next, "l", CHORD_WINDOW_MS).go).toBe("/leads");
  });

  it("an unrecognised second key disarms rather than waiting", () => {
    /* Staying armed would make the letter AFTER it jump — the behaviour that makes people
       distrust shortcuts entirely. */
    const armed = chordStep(CHORD_IDLE, "g", 0);
    const miss  = chordStep(armed.next, "z", 10);
    expect(miss.next).toEqual(CHORD_IDLE);
    expect(chordStep(miss.next, "l", 20).go).toBeUndefined();
  });

  it("a second g re-arms instead of doing nothing", () => {
    /* "gg" then "l" should still go to Leads: the second g is likelier to be the start of
       an intent than the end of one. */
    const a = chordStep(CHORD_IDLE, "g", 0);
    const b = chordStep(a.next, "g", 10);
    expect(b.next).toEqual({ armed: true, at: 10 });
    expect(chordStep(b.next, "l", 20).go).toBe("/leads");
  });

  it("a lone letter does nothing", () => {
    expect(chordStep(CHORD_IDLE, "l", 0)).toEqual({ next: CHORD_IDLE });
  });
});

describe("moving through a list", () => {
  it("j from nothing selected picks the first row", () => {
    /* What makes the keyboard usable without touching the mouse first. */
    expect(moveIndex(-1, 1, 10)).toBe(0);
  });

  it("k from nothing selected picks the last row", () => {
    expect(moveIndex(-1, -1, 10)).toBe(9);
  });

  /**
   * Clamping, not wrapping. In eight hundred subscriptions, wrapping means the operator
   * presses `j` expecting nothing and is silently back at the top — where the next Enter
   * opens the wrong record.
   */
  it("clamps at both ends instead of wrapping", () => {
    expect(moveIndex(9, 1, 10)).toBe(9);
    expect(moveIndex(0, -1, 10)).toBe(0);
  });

  it("selects nothing in an empty list", () => {
    expect(moveIndex(-1, 1, 0)).toBe(-1);
    expect(moveIndex(5, 1, 0)).toBe(-1);
  });

  it("survives a stale index after the list shrank", () => {
    /* A filter can shrink the list under a selection — clamping keeps it in range rather
       than opening undefined. */
    expect(moveIndex(50, 1, 3)).toBe(2);
  });
});

describe("which key means what in a list", () => {
  it("maps the letters and the arrows to the same actions", () => {
    expect(listAction("j")).toBe("next");
    expect(listAction("ArrowDown")).toBe("next");
    expect(listAction("k")).toBe("prev");
    expect(listAction("ArrowUp")).toBe("prev");
    expect(listAction("Enter")).toBe("open");
    expect(listAction("o")).toBe("open");
    expect(listAction("Escape")).toBe("clear");
  });

  it("returns null for anything else, so other keys pass through", () => {
    for (const k of ["a", "1", "Tab", "?", "g"]) {
      expect(listAction(k), k).toBeNull();
    }
  });
});

/**
 * ─── ONE REGISTRY, SO THE CHEAT SHEET CANNOT LIE ────────────────────────────
 * A cheat sheet maintained apart from the handlers is a lie with a nice layout. These
 * assertions are what keep the two in step.
 */
describe("the registry drives the cheat sheet", () => {
  it("documents every g-sequence that actually works", () => {
    for (const key of Object.keys(GO_TO)) {
      const found = SHORTCUTS.some((s) => s.keys.length === 2 && s.keys[0] === "g" && s.keys[1] === key);
      expect(found, `g ${key} is handled but not documented`).toBe(true);
    }
  });

  it("documents every list key that listAction handles", () => {
    for (const key of ["j", "k", "Enter", "o"]) {
      const shown = SHORTCUTS.some((s) => s.keys.includes(key));
      expect(shown, `${key} is handled but not documented`).toBe(true);
    }
  });

  it("groups them without losing any", () => {
    const total = shortcutGroups().reduce((n, g) => n + g.items.length, 0);
    expect(total).toBe(SHORTCUTS.length);
  });

  it("writes Ctrl rather than ⌘, so the badge can swap it per platform", () => {
    /* Hard-coding either symbol is wrong for half the users. */
    for (const s of SHORTCUTS) {
      expect(s.keys.join(""), s.label).not.toContain("⌘");
    }
  });

  it("every shortcut says what it does", () => {
    for (const s of SHORTCUTS) {
      expect(s.label.length, s.keys.join("+")).toBeGreaterThan(4);
    }
  });
});

/* ── The registry is the only place keys may be written ─────────────────────── */

describe("no hand-typed shortcut ever ships in a label", () => {
  /**
   * WHY THIS SCANS THE SOURCE TREE
   *   The registry's promise is that changing a key updates everything that mentions it.
   *   A `title="Add item (Alt+A)"` breaks that promise silently: it keeps rendering the old
   *   keys forever, and nothing fails. That exact string was in quote-builder.tsx, and the
   *   Report Bug tooltip had the opposite problem — it knew the button's purpose and never
   *   mentioned Ctrl+Shift+B at all, so a shortcut that worked was undiscoverable.
   *
   *   route-map.test.ts already earns its keep this way, by scanning src/app instead of
   *   trusting a committed list. Same idea: the rule is only real if breaking it is red.
   *
   * WHAT IS ALLOWED INSTEAD
   *   <Kbd keys={...} />, a tooltip's `shortcut` prop, or shortcutText(id) for a title
   *   attribute. All three read from SHORTCUTS.
   */
  const MODIFIER_TEXT = /(?:Ctrl|Cmd|⌘|Alt|⌥|Shift|⇧)\s*\+\s*\S/;

  /** Only files that RENDER. The registry, the badge and the cheat sheet spell keys out
   *  for a living, and comments are not scanned at all — the patterns below read attribute
   *  values and tooltip children, never prose. */
  const SKIP = ["lib/keyboard/", "components/ui/kbd.tsx", "components/shared/shortcuts-sheet.tsx"];

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) sourceFiles(full, out);
      else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  const files = sourceFiles(join(dirname(fileURLToPath(import.meta.url)), "..", "..")).filter(
    (f) => !SKIP.some((s) => f.split("\\").join("/").includes(s)),
  );

  it("finds files to scan at all", () => {
    // Guard against the scan silently covering nothing — a green run on zero files.
    expect(files.length).toBeGreaterThan(100);
  });

  it("never spells keys out in a title attribute", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/title="([^"]*)"/g)) {
        if (MODIFIER_TEXT.test(m[1])) offenders.push(`${file}: title="${m[1]}"`);
      }
    }
    expect(offenders, "use shortcutText(id) so the keys come from SHORTCUTS").toEqual([]);
  });

  it("never spells keys out inside a tooltip", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/<TooltipContent[^>]*>([\s\S]*?)<\/TooltipContent>/g)) {
        if (MODIFIER_TEXT.test(m[1])) offenders.push(`${file}: ${m[1].trim().slice(0, 60)}`);
      }
    }
    expect(offenders, 'pass shortcut="<id>" to <TooltipContent> instead').toEqual([]);
  });
});

/* ── The registry itself ─────────────────────────────────────────────────────── */

describe("the registry", () => {
  it("has a unique id for every entry", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size, `duplicate id in: ${ids.join(", ")}`).toBe(ids.length);
  });

  it("lists the two shortcuts that were implemented but invisible", () => {
    // report-bug lived only in global-bug-reporter.tsx; the tab keys only in the tabs
    // provider. Neither appeared in the cheat sheet, so neither could be discovered.
    expect(findShortcut("report-bug").keys).toEqual(["Ctrl", "Shift", "B"]);
    expect(findShortcut("tab-jump").keys).toEqual(["Alt", "1–8"]);
  });

  it("throws on an id it does not know, rather than rendering nothing", () => {
    expect(() => findShortcut("nope" as ShortcutId)).toThrow(/Unknown shortcut id/);
  });

  it("writes a title-safe string from the same source", () => {
    expect(shortcutText("add-quote-item")).toBe("Alt+A");
    expect(shortcutText("report-bug")).toBe("Ctrl+Shift+B");
  });
});

describe("matchesShortcut — the handler reads the registry now", () => {
  const ev = (o: Partial<KeyboardEvent>) =>
    ({ key: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o }) as KeyboardEvent;
  const reportBug = findShortcut("report-bug");

  it("fires on Ctrl+Shift+B, and on ⌘+Shift+B for a Mac", () => {
    expect(matchesShortcut(reportBug, ev({ key: "B", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(matchesShortcut(reportBug, ev({ key: "b", metaKey: true, shiftKey: true }))).toBe(true);
  });

  it("does not fire when a modifier is missing or extra", () => {
    expect(matchesShortcut(reportBug, ev({ key: "b", ctrlKey: true }))).toBe(false);              // no Shift
    expect(matchesShortcut(reportBug, ev({ key: "b", shiftKey: true }))).toBe(false);             // no Ctrl
    expect(matchesShortcut(reportBug, ev({ key: "b", ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false);
  });

  it("does not fire on a different letter", () => {
    expect(matchesShortcut(reportBug, ev({ key: "n", ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it("still fires while the operator is typing, unlike the bare-letter shortcuts", () => {
    /* Deliberate. shouldIgnore() keeps j/k/? out of text fields because they are
       characters people type. Ctrl+Shift+B is not, and somebody hitting it mid-sentence
       is reporting the bug they just hit — refusing there would be the surprising
       behaviour. Modifier combos are exactly why shouldIgnore is not consulted here. */
    expect(matchesShortcut(reportBug, ev({ key: "b", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(shouldIgnore(ev({ key: "b", ctrlKey: true, shiftKey: true, target: null }))).toBe(true);
  });

  it("refuses a sequence shortcut, which is two events and not its job", () => {
    expect(matchesShortcut(findShortcut("go-leads"), ev({ key: "l" }))).toBe(false);
  });
});

describe("the cheat sheet shows the newly-registered shortcuts", () => {
  /* The whole point of adding them to the registry: the sheet renders from
     shortcutGroups(), so a shortcut that is in the registry is discoverable, and one that
     is not may as well not exist. Asserted here rather than in the browser because the
     cheat sheet opens on a real "?" keypress, which a synthetic event does not reproduce. */
  const flat = shortcutGroups().flatMap((g) => g.items.map((i) => i.id));

  it("lists Report Bug under Actions", () => {
    expect(flat).toContain("report-bug");
    const actions = shortcutGroups().find((g) => g.group === "Actions");
    expect(actions?.items.map((i) => i.id)).toContain("report-bug");
  });

  it("lists the workspace tab keys, and none of the browser-reserved ones", () => {
    expect(flat).toContain("tab-jump");
    expect(flat).toContain("tab-next");
    expect(flat).toContain("tab-close");
    // Ctrl+Tab and Ctrl+W are attempted in the provider but the browser keeps them, so
    // printing them here would promise something that does nothing outside the PWA.
    const allKeys = SHORTCUTS.map((s) => s.keys.join("+"));
    expect(allKeys).not.toContain("Ctrl+Tab");
    expect(allKeys).not.toContain("Ctrl+W");
  });

  it("puts every registered shortcut in exactly one group", () => {
    expect(flat.length).toBe(SHORTCUTS.length);
    expect(new Set(flat).size).toBe(SHORTCUTS.length);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Single-letter ACTION keys — n / q / i.

   These are the letters most likely to be typed by accident, and unlike j/k they take the
   operator off the page they are on. Every test below is a way that goes wrong.
   ───────────────────────────────────────────────────────────────────────────── */

describe("actionRoute", () => {
  const key = (
    k: string,
    over: Partial<Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "repeat">> = {},
  ) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, repeat: false, ...over });

  it("opens the Add Lead dialog on n", () => {
    expect(actionRoute(CHORD_IDLE, key("n"))).toBe("/leads?action=add");
  });

  it("opens the quote builder on q", () => {
    expect(actionRoute(CHORD_IDLE, key("q"))).toBe("/quotes/new");
  });

  it("sends i to Quotes, because there is no create-invoice screen", () => {
    /* An invoice is generated from a PAID quote — the "New invoice" button on /invoices
       routes to /quotes for the same reason. Sending the operator to the invoice LIST would
       show them what they already have and no way to make a new one. */
    expect(actionRoute(CHORD_IDLE, key("i"))).toBe("/quotes");
  });

  it("never fires mid-chord — g then q is 'go to Quotes', not 'new quote'", () => {
    /* THE COLLISION THAT MATTERS. `q` is both the second key of `g q` and an action key.
       Firing here would make the two-key shortcut permanently unreachable. */
    const armed = { armed: true as const, at: 1_000 };
    expect(actionRoute(armed, key("q"))).toBeNull();
    expect(actionRoute(armed, key("n"))).toBeNull();
    expect(actionRoute(armed, key("i"))).toBeNull();
  });

  it("never fires with a modifier", () => {
    /* Ctrl+N opens a browser window; Alt+I may be an OS key. Hijacking either makes the app
       feel broken in a way the user blames on us. */
    for (const mod of ["ctrlKey", "metaKey", "altKey"] as const) {
      expect(actionRoute(CHORD_IDLE, key("n", { [mod]: true }))).toBeNull();
    }
  });

  it("never fires on an auto-repeat", () => {
    /* Leaning on the key would otherwise queue one navigation per repeat. */
    expect(actionRoute(CHORD_IDLE, key("n", { repeat: true }))).toBeNull();
  });

  it("ignores every other letter, including the g that arms the chord", () => {
    for (const k of ["g", "j", "k", "o", "x", "1", "Enter", "Escape"]) {
      expect(actionRoute(CHORD_IDLE, key(k)), `${k} must not be an action`).toBeNull();
    }
  });

  it("accepts the shifted letter, because Shift+N is still N", () => {
    expect(actionRoute(CHORD_IDLE, key("N"))).toBe("/leads?action=add");
  });

  it("routes only to screens — no action key can mutate anything", () => {
    /* CGST Rule 46: next_document_number allocates from a gapless per-tenant series, and a
       hole in that series cannot be undone by deleting the row. A stray keystroke must never
       be able to consume a document number. This asserts the SHAPE — every action resolves
       to a path, so there is nowhere for a mutation to hide. */
    for (const k of ["n", "q", "i"]) {
      const route = actionRoute(CHORD_IDLE, key(k));
      expect(route, `${k} should resolve to a route`).toBeTruthy();
      expect(route!.startsWith("/"), `${k} must resolve to a path`).toBe(true);
    }
  });

  it("is listed in the cheat sheet, so it is discoverable", () => {
    /* The registry IS the documentation in this file. A working, invisible shortcut is what
       happened to report-bug for as long as it existed. */
    const actions = SHORTCUTS.filter((s) => s.group === "Actions").map((s) => s.id);
    expect(actions).toContain("new-lead");
    expect(actions).toContain("new-quote");
    expect(actions).toContain("new-invoice");
  });

  it("tells the operator WHY i goes to Quotes", () => {
    /* A label reading just "New invoice" sends somebody hunting for a form that does not
       exist in this app. */
    expect(findShortcut("new-invoice").label).toContain("paid quote");
  });
});
