#!/usr/bin/env node
/**
 * Do the public build-time values agree everywhere they are written down?  (files only)
 *
 *   node scripts/check-config-drift.mjs        # exit 0 = in step, exit 1 = drift
 *
 * NEXT_PUBLIC_* values are compiled into the browser bundle by `next build`, so each place
 * that runs a build carries its own copy:
 *
 *   production/Dockerfile           ARG defaults — the SOURCE OF TRUTH (a plain `docker build`)
 *   cloudbuild.yaml                 substitutions _SUPABASE_URL / _SUPABASE_ANON_KEY / _APP_URL
 *   .github/workflows/ci.yml        env of the "Build" step
 *
 * Why (WC-ci, 30 Sep 2026): ci.yml still built against https://ontpnqjoysjgrlsukecm.supabase.co
 * with a `sb_publishable_…` key while the Dockerfile had moved to https://api.anutech.in (the
 * Cloud SQL data plane). CI was green on a build that is not the one that ships. ci.yml's own
 * comment said "if the Dockerfile's values change, change these too" — a comment is not a check.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const unquote = (s) => s.trim().replace(/^["']|["']$/g, "");

/** `ARG NAME="value"` in the Dockerfile. */
function dockerArg(src, name) {
  const m = new RegExp(`^ARG\\s+${name}=(.*)$`, "m").exec(src);
  return m ? unquote(m[1]) : undefined;
}
/** `  KEY: value` anywhere in a YAML file (first match; keys used here are unique). */
function yamlValue(src, key) {
  const m = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m").exec(src);
  return m ? unquote(m[1]) : undefined;
}

const docker = read("production/Dockerfile");
const cloudbuild = read("cloudbuild.yaml");
const ci = read(".github/workflows/ci.yml");

const truth = {
  NEXT_PUBLIC_SUPABASE_URL: dockerArg(docker, "NEXT_PUBLIC_SUPABASE_URL"),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: dockerArg(docker, "NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  NEXT_PUBLIC_APP_URL: dockerArg(docker, "NEXT_PUBLIC_APP_URL"),
};

const checks = [
  ["cloudbuild.yaml _SUPABASE_URL", yamlValue(cloudbuild, "_SUPABASE_URL"), "NEXT_PUBLIC_SUPABASE_URL"],
  ["cloudbuild.yaml _SUPABASE_ANON_KEY", yamlValue(cloudbuild, "_SUPABASE_ANON_KEY"), "NEXT_PUBLIC_SUPABASE_ANON_KEY"],
  ["cloudbuild.yaml _APP_URL", yamlValue(cloudbuild, "_APP_URL"), "NEXT_PUBLIC_APP_URL"],
  ["ci.yml build env NEXT_PUBLIC_SUPABASE_URL", yamlValue(ci, "NEXT_PUBLIC_SUPABASE_URL"), "NEXT_PUBLIC_SUPABASE_URL"],
  ["ci.yml build env NEXT_PUBLIC_SUPABASE_ANON_KEY", yamlValue(ci, "NEXT_PUBLIC_SUPABASE_ANON_KEY"), "NEXT_PUBLIC_SUPABASE_ANON_KEY"],
];

let bad = 0;
for (const [k, v] of Object.entries(truth)) {
  if (!v) { console.error(`✖ production/Dockerfile has no ARG ${k}=… default — cannot compare`); bad++; }
}
const short = (s) => (s && s.length > 48 ? `${s.slice(0, 20)}…${s.slice(-12)}` : s);
for (const [where, got, key] of checks) {
  const want = truth[key];
  if (!want) continue;
  if (got === undefined) { console.error(`✖ ${where}: not found`); bad++; }
  else if (got !== want) { console.error(`✖ ${where} = ${short(got)}\n    Dockerfile ARG ${key} = ${short(want)}`); bad++; }
  else console.log(`✔ ${where}`);
}
if (bad) {
  console.error(`\n${bad} drift(s). The Dockerfile's ARG defaults are what production builds with — make the others match.`);
  process.exit(1);
}
console.log("\nconfig in step with production/Dockerfile");
