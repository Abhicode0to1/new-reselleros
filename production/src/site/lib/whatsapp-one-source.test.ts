/**
 * The site's WhatsApp number lives in ONE place, src/site/lib/config.ts (29 Sep 2026).
 * hosting-landing-v2.ts had its own copy of the placeholder, so setting the real number in
 * config would have left /hosting pointing at the fake one. This fails on any `wa.me/<digits>`
 * written anywhere else in src/.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(process.cwd(), "src");
const CONFIG = join("site", "lib", "config.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("the WhatsApp number has one source", () => {
  const files = walk(SRC);

  it("scanned the source tree (guard against a scan that finds nothing)", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("no wa.me/<digits> literal outside site/lib/config.ts", () => {
    const hits = files
      .filter((f) => relative(SRC, f).split(sep).join(sep) !== CONFIG)
      .filter((f) => /wa\.me\/\d/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(hits).toEqual([]);
  });
});
