/**
 * Every icon the portal asks for must actually exist.
 *
 * ─── THE BUG THIS PINS ──────────────────────────────────────────────────────
 * Found in the browser on 11 Sep 2026, on the first render of the new sidebar:
 * Hosting, Shop, Invoices and Billing all showed a warning triangle. So did two
 * of the four KPI tiles on the dashboard. Nothing failed — `Icon` falls back
 * when it does not know a name, and a fallback is invisible to tsc, to the
 * linter and to every test in the suite.
 *
 * The names were plausible and wrong: `server`, `shopping_cart`,
 * `receipt_indian_rupee`, `indian_rupee`, `alert_triangle`, `message_circle`.
 * The set has 96 icons and the real ones are `package`, `cart`, `receipt`,
 * `rupee`, `alert`, `message`.
 *
 * A warning triangle where a rupee should be is worse than a missing icon: on a
 * MONEY row it reads as a problem with the money. That is why this is a test and
 * not a note.
 *
 * ─── WHY IT READS SOURCE ────────────────────────────────────────────────────
 * The failure is a string that does not match a key in a map — there is nothing
 * to render and assert against, because rendering is exactly what hides it.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const ROOT = process.cwd();
const PORTAL = join(ROOT, "src/app/(public)/portal");
const ICON_FILE = join(ROOT, "src/components/ui/icon.tsx");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** The registry's keys — `name: Component,` at the top level of the map. */
function knownIcons(): Set<string> {
  const src = readFileSync(ICON_FILE, "utf8");
  return new Set([...src.matchAll(/^\s+([a-z0-9_]+):\s*[A-Z]/gm)].map((m) => m[1]));
}

/** Every `icon="x"` and `icon: "x"` under the portal, with where it came from. */
function requestedIcons(): Array<{ file: string; name: string }> {
  const out: Array<{ file: string; name: string }> = [];
  for (const full of walk(PORTAL)) {
    if (full.includes(".test.")) continue;
    const rel = full.slice(PORTAL.length + 1).split("\\").join("/");
    const src = readFileSync(full, "utf8");
    for (const m of src.matchAll(/icon[:=]\s*"([a-z0-9_]+)"/g)) {
      out.push({ file: rel, name: m[1] });
    }
  }
  return out;
}

describe("the portal only asks for icons that exist", () => {
  const known = knownIcons();
  const requested = requestedIcons();

  /* The denominator, before anything is asserted about it. A regex that stopped
     matching would leave this file green while checking nothing — the same trap
     the headings guard fell into this morning. */
  it("actually found the icon registry and the portal's requests", () => {
    expect(known.size, "parsed no icons out of components/ui/icon.tsx").toBeGreaterThanOrEqual(50);
    expect(requested.length, "found no icon= props under the portal").toBeGreaterThanOrEqual(10);
  });

  it("every requested name is in the registry", () => {
    const missing = requested.filter((r) => !known.has(r.name));
    expect(
      missing.map((m) => `${m.file}: icon "${m.name}"`),
      "These fall back to a warning triangle at runtime — silently, and on money rows\n" +
        "a warning triangle reads as a problem with the money.\n" +
        `Known icons: ${[...known].sort().join(", ")}`,
    ).toEqual([]);
  });

  /* The specific six that were wrong, named so a copy-paste from an older
     branch cannot quietly bring them back. */
  it("does not use the names that were invented and fixed", () => {
    const banned = ["server", "shopping_cart", "receipt_indian_rupee", "indian_rupee", "alert_triangle", "message_circle"];
    const found = requested.filter((r) => banned.includes(r.name));
    expect(found.map((f) => `${f.file}: ${f.name}`)).toEqual([]);
  });
});
