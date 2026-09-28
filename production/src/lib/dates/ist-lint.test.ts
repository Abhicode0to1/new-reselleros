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

  it("covers exactly pardeep's src paths from OWNERS.json", () => {
    const want = owners.areas.pardeep.paths
      .filter((p) => p.startsWith("production/src/"))
      .map((p) => p.slice("production/".length) + (p.endsWith("/") ? "**" : ""));
    expect([...ov!.files].sort()).toEqual([...want].sort());
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
