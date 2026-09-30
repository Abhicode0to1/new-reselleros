/**
 * The browser-tab icon must exist. It was deleted on 11 Aug 2026 inside an unrelated
 * commit (16165bac, the bug reporter) and nobody noticed for seven weeks: a missing
 * favicon breaks nothing, so no other test could see it. Restored 30 Sep 2026 as the
 * Anutech Digital logo, served by Next's app/icon.png convention.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PNG = [0x89, 0x50, 0x4e, 0x47];

describe("favicon", () => {
  for (const f of ["icon.png", "apple-icon.png"]) {
    it(`src/app/${f} exists and is a real PNG`, () => {
      const p = join(process.cwd(), "src/app", f);
      expect(existsSync(p), `${f} is missing — the browser tab will show a blank globe`).toBe(true);
      expect([...readFileSync(p).subarray(0, 4)]).toEqual(PNG);
    });
  }
});
