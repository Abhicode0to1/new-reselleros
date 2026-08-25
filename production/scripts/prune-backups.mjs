/**
 * Delete database backups older than a window — and refuse to do it by accident.
 *
 * `backup-db.mjs` runs before every migration and each dump is ~2MB of the whole database. Seven
 * ran on 25 Aug 2026 alone. They accumulate, and every one of them holds live customer data:
 * measured on that day's file, 25 of 117 tables carry personal data, and `quotes.public_token` is
 * a capability token that opens a customer's quote without a login. Old copies of that lying
 * around a laptop is the risk this reduces.
 *
 * ─── IT PRINTS BY DEFAULT AND DELETES ONLY WHEN ASKED ───────────────────────
 * A script that deletes on its first invocation is a script somebody runs to find out what it
 * does. This one shows the plan and exits; `--delete` carries it out. On a free-plan project with
 * no PITR and no automatic backups (see backup-db.mjs's header), the cost of a wrong deletion is
 * the database.
 *
 * THE NEWEST TWO ARE NEVER DELETED, whatever their age. If nobody has backed up for three weeks
 * then EVERY file is past the window — and obeying only the window would erase the last copy
 * precisely because the situation was already bad. The rule and its reasoning live in
 * src/lib/backup/retention.ts, where tests can reach them.
 *
 * Usage:
 *   node scripts/prune-backups.mjs <dir>                 # show what would go
 *   node scripts/prune-backups.mjs <dir> --delete        # do it
 *   node scripts/prune-backups.mjs <dir> --keep-days 14 --keep-min 3
 *
 * NOTE ON WHERE BACKUPS SHOULD LIVE. backup-db.mjs's own header asks for "a folder outside the
 * git repo", and today's landed inside it at ./backups. The repo's .gitignore covers that now,
 * but outside the working tree is still the right place — a folder git never sees cannot be
 * committed by a future `git add .` whatever the ignore file says.
 */
import { readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { planCleanup, DEFAULT_KEEP_DAYS, DEFAULT_KEEP_MIN } from "../src/lib/backup/retention.ts";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) ? v : fallback;
};

const doDelete = args.includes("--delete");
const keepDays = flag("keep-days", DEFAULT_KEEP_DAYS);
const keepMin = flag("keep-min", DEFAULT_KEEP_MIN);

if (!dir) {
  console.error("usage: node scripts/prune-backups.mjs <dir> [--delete] [--keep-days N] [--keep-min N]");
  process.exit(1);
}

const target = resolve(dir);

/* Does NOT create the directory. `mkdir -p` here would let a typo produce an empty folder and a
   cheerful "nothing to do", which reads as success while the real backups sit untouched
   somewhere else. */
if (!existsSync(target)) {
  console.error(`No such directory: ${target}`);
  console.error("Nothing was deleted. Check the path — this script does not create folders.");
  process.exit(1);
}

const files = readdirSync(target, { withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => ({ name: e.name, size: statSync(join(target, e.name)).size }));

const plan = planCleanup(files, { now: new Date(), keepDays, keepMin });

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

console.log(`\n${target}`);
console.log(`keeping the newest ${keepMin}, and anything from the last ${keepDays} days\n`);

/* Keeps first. The reassuring half of the output should not be below the frightening half. */
for (const v of plan.verdicts.filter((x) => x.action === "keep")) {
  console.log(`  keep    ${v.name}  (${mb(v.size)})  — ${v.reason}`);
}
for (const v of plan.verdicts.filter((x) => x.action === "delete")) {
  console.log(`  ${doDelete ? "DELETE " : "would  "} ${v.name}  (${mb(v.size)})  — ${v.reason}`);
}

console.log(`\n${plan.summary}`);
if (plan.deleting > 0) console.log(`${mb(plan.bytesFreed)} ${doDelete ? "freed" : "would be freed"}.`);

if (!doDelete) {
  if (plan.deleting > 0) console.log("\nNothing deleted. Re-run with --delete to carry this out.");
  process.exit(0);
}

let removed = 0;
let failed = 0;
for (const v of plan.verdicts) {
  if (v.action !== "delete") continue;
  try {
    unlinkSync(join(target, v.name));
    removed += 1;
  } catch (err) {
    /* Reported and counted rather than thrown: one locked file must not stop the rest, and a
       half-finished prune that says so is better than one that stops silently. */
    failed += 1;
    console.error(`  FAILED  ${v.name} — ${err.message}`);
  }
}

console.log(`\nDeleted ${removed}${failed ? `, failed ${failed}` : ""}. ${plan.keeping} kept.`);
process.exit(failed ? 1 : 0);
