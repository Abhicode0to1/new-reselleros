/**
 * S21 lint rule ka scope OWNERS.json se bandha rahe.
 *
 * `.eslintrc.json` ka no-restricted-syntax override (naive `toISOString().slice(0, 10)`) sirf
 * Pardeep ke areas par lagta hai — Abhishek / Pawan ki files unki marzi se, request ke through.
 * JSON me comment nahi likh sakte, isliye ye test hi uska "why" hai: OWNERS.json me pardeep ka
 * naya path jude aur override me na jude, to yahan laal.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const owners = JSON.parse(readFileSync(join(root, "..", "OWNERS.json"), "utf8")) as {
  areas: Record<string, { paths: string[] }>;
};
const eslint = JSON.parse(readFileSync(join(root, ".eslintrc.json"), "utf8")) as {
  overrides: { files: string[]; rules?: Record<string, unknown> }[];
};

describe("naive-UTC-date lint rule scope", () => {
  const ov = eslint.overrides.find((o) => o.rules && "no-restricted-syntax" in o.rules);

  it("exists and is an error, not a warning (warnings would move the lint ratchet)", () => {
    expect(ov).toBeDefined();
    expect((ov!.rules!["no-restricted-syntax"] as unknown[])[0]).toBe("error");
  });

  /* 30 Sep 2026: OWNERS.json was re-split (accounting → hitesh, crons/ops/backup → abhishek).
     The rule stays on those paths — it guards GST / books / cron dates, whoever owns them — so
     the check is now: every pardeep src path is covered, and every covered path is owned by
     someone in OWNERS.json (no stale globs). */
  const glob = (p: string) => p.slice("production/".length) + (p.endsWith("/") ? "**" : "");
  it("covers every pardeep src path from OWNERS.json", () => {
    const want = owners.areas.pardeep.paths.filter((p) => p.startsWith("production/src/")).map(glob);
    for (const w of want) expect(ov!.files).toContain(w);
  });
  it("covers only paths some owner in OWNERS.json has", () => {
    const all = Object.values(owners.areas).flatMap((a) => a.paths).filter((p) => p.startsWith("production/src/")).map(glob);
    for (const f of ov!.files) expect(all).toContain(f);
  });

  it("touches no other owner's area (no sub-path of these is carved out for someone else)", () => {
    // Longest prefix wins in OWNERS.json, so `(public)/unsubscribe/` is pardeep's even though
    // pawan owns `(public)/`. The risk is the reverse: someone else owning a deeper path.
    const others = Object.entries(owners.areas).filter(([k]) => k !== "pardeep").flatMap(([, a]) => a.paths);
    for (const f of ov!.files) {
      const path = `production/${f.replace(/\*\*$/, "")}`;
      expect(others.filter((o) => o.startsWith(path) && o !== path)).toEqual([]);
    }
  });
});
