/**
 * R-052 (1 Oct 2026): `window.confirm()` silently returns false in the desktop app's preview
 * and some webviews, so a button gated on it looks dead. Every prompt goes through
 * useConfirm (confirm-provider.tsx). This keeps a native confirm/alert/prompt from coming back,
 * and keeps the 404 + loading screens in place.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const src = join(process.cwd(), "src");

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.includes(".test.")) out.push(p);
  }
  return out;
}

/* Strip comments so a sentence like "not a browser confirm()" in a doc comment is not a hit. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/* window.confirm/alert/prompt, and bare alert(/prompt( (the globals). A bare confirm( is
   allowed — that is the useConfirm() function every page names "confirm". */
const NATIVE = /\bwindow\.(confirm|alert|prompt)\s*\(|(^|[^.\w$])(alert|prompt)\s*\(/m;

describe("no native browser dialogs (R-052)", () => {
  const files = filesUnder(src);

  it("scans the app", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("no window.confirm / alert / prompt anywhere in src", () => {
    const hits = files.filter((f) => NATIVE.test(code(readFileSync(f, "utf8"))));
    expect(hits.map((f) => f.slice(src.length + 1))).toEqual([]);
  });

  it("has the branded 404 and the in-app loading screen", () => {
    expect(existsSync(join(src, "app", "not-found.tsx"))).toBe(true);
    expect(existsSync(join(src, "app", "(app)", "not-found.tsx"))).toBe(true);
    expect(existsSync(join(src, "app", "(app)", "loading.tsx"))).toBe(true);
  });
});
