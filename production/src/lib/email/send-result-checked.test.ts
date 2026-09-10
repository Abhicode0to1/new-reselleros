/**
 * `sendEmail` returns an OBJECT on every path, so `if (!result)` is not a check.
 *
 * ─── THE BUG THIS EXISTS FOR, AND WHY IT IS INVISIBLE ───────────────────────
 * `sendEmail` resolves to `{ status: "sent" | "stubbed" | "failed", … }`. It only
 * ever REJECTS on an unexpected throw. So this shape, which reads like careful
 * code:
 *
 *     const sent = await sendEmail({ … }).catch(() => null);
 *     if (!sent) { rollBack(); return; }
 *
 * catches the throw and treats `status: "failed"` as a success. The email did not
 * go, the caller records that it did, and nothing errors anywhere.
 *
 * Found 11 Sep 2026 by running the new domain-expiry cron on a machine with no
 * Resend key: all three sends came back `failed`, `email_log` recorded them as
 * failed, and the notice rows were stamped `sent_at` regardless — the table
 * claiming we had warned customers we had not. `domain-watch` had the identical
 * line, copied into the new cron from it, which means ITS claim-rollback had
 * never once fired since the file was written.
 *
 * Both are fixed. This test is here because the trap is still in place: the
 * function still returns a truthy object on failure, so the next caller to reach
 * for `if (!sent)` will be just as wrong and just as quiet.
 *
 * ─── WHAT IT ALLOWS ─────────────────────────────────────────────────────────
 * Not every caller has to branch on the outcome. Plenty of sends are genuinely
 * fire-and-forget — the send is logged in `email_log` either way, which is what
 * that table is for. This only objects to a caller that assigns the result, tests
 * it for TRUTHINESS, and never reads `.status`: that is a caller which believes it
 * is checking and is not.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

interface Offender {
  file: string;
  variable: string;
}

function findOffenders(): { offenders: Offender[]; callSites: number } {
  const offenders: Offender[] = [];
  let callSites = 0;

  for (const file of walk(SRC)) {
    const src = readFileSync(file, "utf8");
    if (!src.includes("sendEmail(")) continue;

    for (const m of src.matchAll(/const\s+(\w+)\s*=\s*await\s+sendEmail\(/g)) {
      callSites++;
      const variable = m[1];
      /* A generous window after the call — long enough to contain the check,
         short enough not to reach an unrelated later block. */
      const after = src.slice(m.index! + m[0].length, m.index! + m[0].length + 2500);
      const readsStatus = new RegExp(`\\b${variable}\\??\\.status\\b`).test(after);
      const testsTruthiness = new RegExp(
        `if\\s*\\(\\s*!\\s*${variable}\\s*\\)|if\\s*\\(\\s*${variable}\\s*\\)`,
      ).test(after);
      if (testsTruthiness && !readsStatus) {
        offenders.push({ file: file.slice(SRC.length + 1).split("\\").join("/"), variable });
      }
    }
  }
  return { offenders, callSites };
}

describe("a caller that checks whether an email sent must check its STATUS", () => {
  const { offenders, callSites } = findOffenders();

  /* The denominator. A regex that stopped matching would make the assertion
     below pass while scanning nothing, and this file would sit green forever
     over a codebase full of the bug. */
  it("actually found the sendEmail call sites", () => {
    expect(
      callSites,
      "no `const x = await sendEmail(` found anywhere in src — the scan is broken, " +
        "not the codebase clean",
    ).toBeGreaterThan(5);
  });

  it("no caller mistakes a truthy result for a successful send", () => {
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `These assign sendEmail's result, test it for truthiness, and never read ` +
          `.status — so a send that came back "failed" is treated as a success:\n` +
          offenders.map((o) => `  ${o.file} (${o.variable})`).join("\n") +
          `\n\nCheck \`${offenders[0]?.variable}.status !== "sent"\` instead. ` +
          `"stubbed" is not sent either — it means this deployment has no mail provider.`,
    ).toEqual([]);
  });
});
