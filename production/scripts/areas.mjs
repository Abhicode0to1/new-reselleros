#!/usr/bin/env node
/**
 * Which areas did this branch touch? Run before every push (docs/TEAM-PROTOCOL.md).
 *
 *   node scripts/areas.mjs                 # diff of HEAD against the merge-base with origin/main-ish
 *   node scripts/areas.mjs --base origin/billing-abhishek
 *   node scripts/areas.mjs --files a.ts b.ts   # classify explicit paths (tests use this)
 *
 * Prints each changed file's owner (pardeep / abhishek / pawan / shared / unowned) and a
 * verdict for the CURRENT branch's owner (read from OWNERS.json by branch name). Exit code:
 *   0  everything is yours (or shared — which still needs a board 'changes' note)
 *   3  you changed another person's area: raise a request on the board instead, or name the
 *      R-nnn you were asked to do in the commit message (the script accepts that)
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const owners = JSON.parse(readFileSync(join(root, "OWNERS.json"), "utf8"));

export function ownerOf(path, cfg = owners) {
  const p = path.replace(/\\/g, "/");
  let best = { owner: "unowned", len: 0 };
  for (const [key, a] of Object.entries(cfg.areas)) {
    for (const pre of a.paths) if (p.startsWith(pre) && pre.length > best.len) best = { owner: key, len: pre.length };
  }
  for (const pre of cfg.shared.paths) if (p.startsWith(pre) && pre.length > best.len) best = { owner: "shared", len: pre.length };
  return best.owner;
}

export function ownerOfBranch(branch, cfg = owners) {
  for (const [key, a] of Object.entries(cfg.areas)) if (a.branch === branch) return key;
  return null;
}

function sh(cmd) { return execSync(cmd, { cwd: root, encoding: "utf8" }).trim(); }

const args = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  let files = [];
  let range = null;
  const fi = args.indexOf("--files");
  if (fi >= 0) files = args.slice(fi + 1);
  else {
    const bi = args.indexOf("--base");
    let base = bi >= 0 ? args[bi + 1] : null;
    if (!base) {
      for (const b of ["origin/main", "origin/master", "origin/deploy"]) { try { sh(`git rev-parse --verify ${b}`); base = b; break; } catch { /* next */ } }
    }
    const mb = base ? sh(`git merge-base HEAD ${base}`) : "HEAD~1";
    range = `${mb}..HEAD`;
    files = sh(`git diff --name-only ${mb}...HEAD`).split("\n").filter(Boolean);
  }
  let branch = "";
  try { branch = sh("git rev-parse --abbrev-ref HEAD"); } catch { /* detached */ }
  const me = ownerOfBranch(branch);
  /* Only THIS branch's own commits count as citing a request — not the last 20 of history. */
  const lastMsgs = range ? (() => { try { return sh(`git log ${range} --format=%B`); } catch { return ""; } })() : "";
  const byOwner = {};
  for (const f of files) (byOwner[ownerOf(f)] ??= []).push(f);
  console.log(`branch: ${branch || "?"} → owner: ${me ?? "unknown"}`);
  for (const [o, fs] of Object.entries(byOwner)) console.log(`\n${o} (${fs.length})\n  ${fs.slice(0, 40).join("\n  ")}${fs.length > 40 ? `\n  … +${fs.length - 40}` : ""}`);
  const foreign = Object.keys(byOwner).filter((o) => o !== me && o !== "shared" && o !== "unowned");
  if (byOwner.shared) console.log(`\n⚠ shared files changed — post a 'changes' entry on the board (${owners.board}) naming who is affected.`);
  if (foreign.length && me) {
    const cited = /\bR-0\d\d\b/.test(lastMsgs);
    console.log(`\n✖ you (${me}) changed ${foreign.join(", ")}'s area.${cited ? " A request id is cited in recent commits — allowed if that request asked you to." : " Raise a request on the board instead, or cite the R-nnn that asked for it."}`);
    process.exit(cited ? 0 : 3);
  }
  console.log("\n✔ all changes are in your area or shared.");
}
