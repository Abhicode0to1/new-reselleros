import { describe, it, expect } from "vitest";
import {
  SHORTCUTS, shortcutGroups, isTypingTarget, shouldIgnore,
  chordStep, CHORD_IDLE, CHORD_WINDOW_MS, GO_TO,
  moveIndex, listAction,
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
