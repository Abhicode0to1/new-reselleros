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

describe("install icons (manifest)", () => {
  it("192 and 512 are the logo as real PNGs of that size, not the old drawn \"R\" routes", () => {
    for (const [f, size] of [["icon-192.png", 192], ["icon-512.png", 512]] as const) {
      const b = readFileSync(join(process.cwd(), "public", f));
      expect([...b.subarray(0, 4)], f).toEqual(PNG);
      // PNG IHDR: width and height are big-endian at bytes 16 and 20.
      expect([b.readUInt32BE(16), b.readUInt32BE(20)], f).toEqual([size, size]);
      expect(existsSync(join(process.cwd(), "src/app", f, "route.tsx")), `${f} route would shadow the file`).toBe(false);
    }
  });
});
