#!/usr/bin/env node
/**
 * ESLint ratchet — warnings may go DOWN, never UP.
 *
 *   node scripts/lint-ratchet.mjs            (or: npm run lint:ratchet)   check
 *   node scripts/lint-ratchet.mjs --update                                 lower the baseline
 *
 * Why: `next lint` exits 0 on warnings, so a rule set to "warn" never stops anything, and
 * flipping `no-explicit-any` / `max-lines` straight to "error" would turn CI red on code
 * nobody is touching today (S18, Sep 2026). So each rule's CURRENT warning count is written
 * down in lint-baseline.json and CI fails if any rule goes above its number. Fix some, run
 * `--update`, commit the smaller numbers — the ceiling only ever moves down.
 *
 * Any ESLint ERROR fails outright; errors are not baselined.
 * `--update` refuses to RAISE a number: a rule that grew must be fixed, or the baseline
 * edited by hand in a reviewed commit that says why.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(ROOT, "lint-baseline.json");
const require = createRequire(join(ROOT, "package.json"));
const { ESLint } = require("eslint");

// Same directories `next lint` walks by default; only src/ exists in this app.
const eslint = new ESLint({ cwd: ROOT });
const results = await eslint.lintFiles(["src/**/*.{js,jsx,ts,tsx}"]);

const counts = {};
let errors = 0;
for (const r of results) {
  for (const m of r.messages) {
    if (m.severity === 2) {
      errors++;
      console.error(`ERROR ${r.filePath.slice(ROOT.length + 1)}:${m.line}  ${m.ruleId ?? "(parse)"}  ${m.message}`);
      continue;
    }
    const k = m.ruleId ?? "(no-rule)";
    counts[k] = (counts[k] ?? 0) + 1;
  }
}
const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
const base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")).maxWarnings ?? {} : {};

if (process.argv.includes("--update")) {
  const next = {};
  const grew = [];
  for (const [rule, n] of Object.entries(sorted)) {
    if (rule in base && n > base[rule]) grew.push(`${rule}: ${base[rule]} -> ${n}`);
    next[rule] = rule in base ? Math.min(n, base[rule]) : n;
  }
  for (const rule of Object.keys(base)) if (!(rule in next)) next[rule] = 0;
  writeFileSync(BASELINE, JSON.stringify({
    _note: "Max ESLint WARNINGS per rule. CI fails above these. Lower only: node scripts/lint-ratchet.mjs --update",
    maxWarnings: next,
  }, null, 2) + "\n");
  console.log("baseline written:", next);
  if (grew.length) console.error("NOT raised (fix these first):\n  " + grew.join("\n  "));
  process.exit(grew.length || errors ? 1 : 0);
}

const over = [];
for (const [rule, n] of Object.entries(sorted)) {
  const max = base[rule] ?? 0; // a rule not in the baseline has a ceiling of 0
  const mark = n > max ? "OVER" : n < max ? "below (run --update)" : "ok";
  console.log(`${String(n).padStart(4)} / ${String(max).padEnd(4)} ${rule}  ${mark}`);
  if (n > max) over.push(rule);
}
if (errors) console.error(`\n${errors} ESLint error(s) — errors are never baselined.`);
if (over.length) {
  console.error(`\nLint ratchet FAILED — more warnings than baseline for: ${over.join(", ")}`);
  console.error("Fix the new ones (run `npx next lint` to see where). Do not raise lint-baseline.json to pass.");
}
process.exit(errors || over.length ? 1 : 0);
