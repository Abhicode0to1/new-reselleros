/**
 * A guard against the E2E suite passing while testing almost nothing.
 *
 * ─── THE TRAP THIS CLOSES ───────────────────────────────────────────────────
 * 70 of the 78 auth-gated tests in this suite call `test.skip(!hasEnv, …)`. Without
 * `.env.test` they skip, and Playwright reports the run as green — "8 passed, 70
 * skipped" reads as a pass in a terminal and looks like a tick in CI.
 *
 * That is the same failure the rest of this codebase keeps finding: an absence
 * rendered as a success. A suite that silently tests nothing is worse than no suite,
 * because it is trusted.
 *
 * This test FAILS when the environment needed to exercise the real spine is missing,
 * so the run cannot be mistaken for coverage. It is the only test here that is
 * supposed to go red on a fresh machine — and the message says exactly what to do.
 *
 * ─── IT DOES NOT ASK ANYONE TO PASTE A SERVICE-ROLE KEY ANYWHERE PUBLIC ─────
 * Lighting up the suite needs SUPABASE_SERVICE_ROLE_KEY in `.env.test`, which is
 * gitignored. That key must never reach a commit, a screenshot, or a chat message —
 * the message below points at the file and at e2e/README.md rather than reproducing
 * any instruction that would encourage pasting it somewhere it can be read.
 */
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { E2E_ROLES, missingEnvFor } from "./fixtures/e2e-roles.mjs";

const ENV_FILE = path.join(process.cwd(), ".env.test");

test.describe("suite health", () => {
  test("the auth-gated specs are actually able to run", () => {
    const hasFile = fs.existsSync(ENV_FILE);
    const hasAnon = Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
    const hasService = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

    const missing: string[] = [];
    if (!hasFile) missing.push("production/.env.test does not exist");
    if (!hasAnon) missing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY is not set");
    if (!hasService) missing.push("SUPABASE_SERVICE_ROLE_KEY is not set");
    // R-053: the logged-in workflow specs (wNN-*.spec.ts) skip per role without these,
    // so their skips count here exactly like the older auth-gated ones.
    for (const name of missingEnvFor(E2E_ROLES)) {
      if (!name.startsWith("E2E_")) continue; // the Supabase vars are reported above
      missing.push(`${name} is not set — the logged-in workflow specs for that role skip`);
    }

    expect(
      missing,
      [
        "",
        "The E2E suite is running with its auth-gated specs disabled, so a green run",
        "here proves almost nothing. Missing:",
        ...missing.map((m) => `  · ${m}`),
        "",
        "Fix: create production/.env.test (gitignored) with the keys and the E2E_*_PASSWORD",
        "vars, then seed (e2e/README.md, \"Logged-in E2E\"). Until then the only specs that",
        "really execute are the no-auth ones: smoke, and the public buy page.",
        "",
      ].join("\n"),
    ).toEqual([]);
  });
});
