#!/usr/bin/env node
/**
 * The three audit sweeps, in one command.
 *
 *     npm run sweep
 *
 * ─── WHY THESE ARE NOT IN `npm run gate` ────────────────────────────────────
 * The gate is binary: four steps, each ok or FAIL, and a FAIL means do not
 * ship. These three are not that. Every row they print is a CANDIDATE that
 * needs a person to read the line — measured 12 Sep 2026, the raw runs were
 * 13 fake actions (all real), 61 fabricated-data candidates (2 real), and 46
 * stale-claim candidates (2 real).
 *
 * A check that needs judgement does not belong in a blocking gate. Put it
 * there and the first false positive on a Friday gets the whole step commented
 * out, and then it protects nothing. So this reports, and a person decides.
 *
 * ─── WHY THEY ARE NOT JUST THREE SCRIPTS IN A FOLDER EITHER ─────────────────
 * Because that is how the last four checks were forgotten. The gate's own
 * header says it exists for exactly this reason — "chaar me se ek bhool jana
 * khatam karna hai" — after a missed `build` held production for days while
 * the other three were green. One command that runs all three is the smallest
 * thing that keeps them from rotting.
 *
 * Each script documents the baseline it SHOULD report, so a future run can
 * tell "clean" from "the parser broke". That distinction is not theoretical:
 * find-stale-claims.py returned 0 on every run for its first hour because its
 * haystack included comments, which made every name in a comment "exist".
 */
import { spawn } from "node:child_process";

const SWEEPS = [
  {
    name: "fake-actions",
    file: "scripts/find-fake-actions.py",
    expect: "1 finding — enquiries' toast.error, which correctly explains why nothing happened",
  },
  {
    name: "fake-data",
    file: "scripts/find-fake-data.py",
    expect: "22 candidates — CSV templates and format examples; read them, do not assume",
    // Its baseline is noisy BY DESIGN: telling a CSV template apart from a
    // fabricated metric needs a person. The COUNT moving is the signal.
    quiet: true,
  },
  {
    name: "stale-claims",
    file: "scripts/find-stale-claims.py",
    expect: "0 files, 0 identifiers",
  },
];

function run(s) {
  return new Promise((resolve) => {
    /* shell:true because `python` is a .exe on PATH here and Windows needs the
       shell to find it — the same reason gate.mjs spawns npm that way. The args
       are written in this file, never passed in. */
    const p = spawn("python", [s.file], {
      shell: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ ...s, code, out }));
  });
}

console.log("sweep — fake-actions · fake-data · stale-claims");
console.log("(advisory: every row is a candidate, not a verdict)\n");

let crashed = 0;
for (const s of SWEEPS) {
  const r = await run(s);
  if (r.code !== 0) {
    crashed++;
    console.log(`\n─── ${r.name}  CRASHED (exit ${r.code})`);
    console.log(r.out.split(/\r?\n/).slice(-12).join("\n"));
    continue;
  }
  /* Counts, not contents. fake-data alone prints 23 candidates over ~50 lines,
     and a command that answers "is anything new?" with fifty lines is one
     nobody runs twice. Detail is shown only where the baseline is CLEAN — there
     any row at all is news. Where the baseline is noisy by design, the count is
     the signal and the script name is the way in. */
  const lines = r.out.split(/\r?\n/).filter((l) => l.trim());
  const counts = lines.filter((l) => /:\s*\d+\s*$/.test(l));
  const total = counts.reduce(
    (n, l) => n + (Number((l.match(/(\d+)\s*$/) || [])[1]) || 0), 0);

  console.log(`─── ${r.name}${total === 0 ? "  — clean" : ""}`);
  console.log(`    expected: ${r.expect}`);
  for (const c of counts) console.log(`    ${c.trim()}`);

  if (total > 0 && !r.quiet) {
    const detail = lines.filter((l) => /^\s{2,}/.test(l) && !counts.includes(l));
    if (detail.length && detail.length <= 12) for (const d of detail) console.log(`      ${d.trim()}`);
    else if (detail.length) console.log(`      … ${detail.length} lines — run: python ${r.file}`);
  } else if (total > 0) {
    console.log(`      (noisy by design — run: python ${r.file})`);
  }
  console.log("");
}

/* Exit 0 even with findings — see the header. A non-zero here would turn an
   advisory sweep into a gate by the back door, and CI would start failing on
   a comment somebody wrote correctly. Only a CRASHED script is an error,
   because that means the check is not checking. */
if (crashed) {
  console.log(`${crashed} sweep(s) crashed — the check is not checking.`);
  process.exit(1);
}
