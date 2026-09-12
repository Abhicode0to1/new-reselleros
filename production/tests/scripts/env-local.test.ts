/**
 * The .env.local parser the maintenance scripts share.
 *
 * ─── THE CASE THAT COST A DEBUGGING SESSION ─────────────────────────────────
 * Eight scripts each had `value.trim().replace(/^["']|["']$/g, "")`, which
 * strips one quote from each end of the LINE — so a quoted value followed by a
 * comment kept the comment. The service-role key parsed as the JWT plus the
 * sentence after it, and Node's rejection named a character offset and no file:
 *
 *     TypeError: Cannot convert argument to a ByteString because the character
 *     at index 191 has a value of 8212
 *
 * which reads as a corrupt key rather than a parser bug. That exact line is the
 * first test below.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
// @ts-expect-error — .mjs with no type declarations; this is a script helper.
import { parseEnv } from "../../scripts/lib/env-local.mjs";

const env = (t: string): Record<string, string> => parseEnv(t) as Record<string, string>;

describe("a quoted value ends at its closing quote", () => {
  it("drops the trailing comment that broke eight scripts", () => {
    const line = 'SUPABASE_SERVICE_ROLE_KEY="eyJhbGciOi.J9"  # LOCAL demo key — same on every local supabase';
    const v = env(line).SUPABASE_SERVICE_ROLE_KEY;
    expect(v).toBe("eyJhbGciOi.J9");
    expect(v).not.toContain("#");
    // 8212 is the em dash the ByteString error pointed at.
    expect([...v].some((c) => c.charCodeAt(0) > 255), "non-Latin-1 char survived into a header value").toBe(false);
  });

  it("handles single quotes the same way", () => {
    expect(env("A='one' # two").A).toBe("one");
  });

  /* Greedy `.*` would run to the LAST quote on the line and swallow this. */
  it("is not confused by a quote inside the comment", () => {
    expect(env('A="real"  # the "old" value').A).toBe("real");
  });

  it("keeps an empty quoted value empty", () => {
    expect(env('A=""').A).toBe("");
  });
});

describe("an unquoted value ends at whitespace-then-hash", () => {
  it("strips a spaced comment", () => {
    expect(env("A=plain   # note").A).toBe("plain");
  });

  /* dotenv requires the space, and passwords contain #. Dropping from the
     first `#` regardless would silently truncate a credential. */
  it("keeps a # that is part of the value", () => {
    expect(env("A=pa#ssword").A).toBe("pa#ssword");
  });
});

describe("the shapes a real .env.local has", () => {
  it("keeps = inside a value — the key ends at the FIRST =", () => {
    expect(env("DATABASE_URL=postgres://u:p@h:5432/db?x=1&y=2").DATABASE_URL)
      .toBe("postgres://u:p@h:5432/db?x=1&y=2");
  });

  it("accepts `export FOO=bar`", () => {
    expect(env("export A=1").A).toBe("1");
  });

  it("skips blanks and comment lines", () => {
    const e = env(["# header", "", "A=1", "   ", "# B=2", "C=3"].join("\n"));
    expect(e).toEqual({ A: "1", C: "3" });
    expect(e.B).toBeUndefined();
  });

  it("survives CRLF", () => {
    expect(env("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
  });

  it("ignores a line with no =", () => {
    expect(env("JUST_A_WORD")).toEqual({});
  });
});

/* ─── NOBODY MAY HAND-ROLL IT AGAIN ─────────────────────────────────────────
   This spread by copy-paste to eight files; the fix only holds if the ninth
   copy fails here rather than in someone's terminal at midnight. */
describe("scripts read .env.local through the shared parser", () => {
  const DIR = join(process.cwd(), "scripts");
  const files = readdirSync(DIR).filter((f) => f.endsWith(".mjs"));

  it("denominator — found the scripts", () => {
    expect(files.length, "no .mjs files in scripts/").toBeGreaterThan(8);
  });

  it("no script strips quotes off the ends of the line", () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(join(DIR, f), "utf8");
      // the comment in env-local.mjs quotes the bad pattern while explaining it
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      return /replace\(\s*\/\^\["']?\|?\["']?\$\/g/.test(code);
    });
    expect(
      offenders,
      "`.replace(/^[\"']|[\"']$/g, \"\")` keeps a trailing comment inside the value.\n" +
        "Import { loadEnvLocal } from './lib/env-local.mjs' instead.",
    ).toEqual([]);
  });
});
