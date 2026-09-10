import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { toneToKind } from "./badge";

/**
 * `<Badge color="rose">` type-checked, spread onto the `<span>` where the
 * browser ignores it, and left `kind` undefined — which defaults to `muted`. So
 * EVERY status pill on ten files rendered grey: paid, overdue and disputed all
 * looked identical, which is the exact opposite of a status pill's job.
 *
 * It survived because it compiled, so the fix is a type (`color?: never` in
 * badge.tsx) — and the ratchet below is here because a type ban only holds while
 * nobody widens the props again.
 */

describe("toneToKind — colour vocabulary → kind", () => {
  it("maps the tones these screens actually use", () => {
    expect(toneToKind("rose")).toBe("danger");
    expect(toneToKind("amber")).toBe("warning");
    expect(toneToKind("emerald")).toBe("success");
    expect(toneToKind("indigo")).toBe("info");
    expect(toneToKind("slate")).toBe("muted");
  });

  it("maps the plainer synonyms too, since the maps are not consistent", () => {
    expect(toneToKind("red")).toBe("danger");
    expect(toneToKind("green")).toBe("success");
    expect(toneToKind("blue")).toBe("info");
    expect(toneToKind("info")).toBe("info");
  });

  it("falls back to muted for anything unrecognised — a decision, not an accident", () => {
    /* Grey is the same thing the bug produced. The difference is that this line
       is a choice somebody can read, and a status that reaches here is at worst
       as informative as it was before rather than a crash. */
    for (const odd of ["fuchsia", "", "  ", null, undefined, "MUTED"]) {
      expect(toneToKind(odd), String(odd)).toBe("muted");
    }
  });

  it("never returns a kind badgeVariants does not have", () => {
    /* A typo here would put an unknown class on the span and paint nothing. */
    const valid = new Set(["muted", "success", "warning", "danger", "info", "outline"]);
    for (const tone of ["rose", "red", "amber", "orange", "yellow", "emerald", "green",
                        "indigo", "info", "sky", "blue", "violet", "outline", "slate", "?"]) {
      expect(valid.has(toneToKind(tone)), tone).toBe(true);
    }
  });
});

/* ── The ratchet ─────────────────────────────────────────────────────────────
 * A source scan rather than a render test, because the failure is not that the
 * badge throws — it is that it renders, silently, in the wrong colour. Only the
 * absence of the prop can be asserted.
 */
describe("no <Badge> is given a `color`", () => {
  const SRC = join(process.cwd(), "src");

  function tsxFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (entry === "node_modules" || entry === ".next") continue;
        tsxFiles(p, out);
      } else if (entry.endsWith(".tsx")) {
        out.push(p);
      }
    }
    return out;
  }

  /**
   * Comments are blanked before scanning, with the line count kept intact.
   *
   * The first version of this test failed on badge.tsx itself: the doc comment
   * explaining the bug necessarily writes `<Badge color="rose">` out in full. A
   * ratchet that cannot survive its own explanation is one that gets deleted.
   */
  function stripComments(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
  }

  it("holds across every .tsx in src", () => {
    /* Matches `<Badge` followed by anything up to the first `>` that contains a
       `color=`. Deliberately narrow: `Avatar` has a real `color` prop and 21
       legitimate uses of it, so a blanket search for `color=` would be noise. */
    const offenders: string[] = [];
    for (const file of tsxFiles(SRC)) {
      const text = stripComments(readFileSync(file, "utf8"));
      for (const m of text.matchAll(/<Badge\b[^>]*?\bcolor\s*=/g)) {
        const line = text.slice(0, m.index).split("\n").length;
        offenders.push(`${file.replace(SRC, "src")}:${line}`);
      }
    }
    expect(offenders, `Badge takes \`kind\`, not \`color\` — use toneToKind() for a colour name:\n${offenders.join("\n")}`)
      .toEqual([]);
  });
});
