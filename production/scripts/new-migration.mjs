/**
 * Create a new migration file with a timestamped name.
 *
 *   npm run migration:new -- add_customer_credit_limit
 *
 * ─── WHY TIMESTAMPS AND NOT 0249, 0250 ─────────────────────────────────────
 * The first 218 migrations here are sequential (`0001` … `0248`). That works for one
 * person. With two it breaks the first time both start a migration on the same day:
 * both write `0249_…`, both PRs pass CI on their own, and the collision only appears
 * after they are merged — by which point the intended ORDER of the two is lost, and
 * git has no way to tell you which was meant to run first.
 *
 * A timestamp cannot collide (it has seconds in it) and it sorts by when the work was
 * actually done, which is the order the author intended.
 *
 * ─── WHAT GOES IN THE HEADER ───────────────────────────────────────────────
 * The template asks for the two things this repo has repeatedly wished were written
 * down: what breaks if the migration is wrong, and how to check it worked. Both from
 * real cost — `0171` existed because a table was created out-of-band and nobody
 * recorded it, and `0239` because grants vanished and nothing said what to verify.
 */
import { writeFileSync, existsSync, mkdirSync } from "node:fs";

const raw = process.argv.slice(2).join(" ").trim();
if (!raw) {
  console.error("usage: npm run migration:new -- <short_description>");
  console.error("example: npm run migration:new -- add_customer_credit_limit");
  process.exit(2);
}

const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
if (!slug) { console.error("That description has no usable characters in it."); process.exit(2); }

const d = new Date();
const p = (n, w = 2) => String(n).padStart(w, "0");
const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;

const dir = "supabase/migrations";
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
const file = `${dir}/${stamp}_${slug}.sql`;

writeFileSync(file, `-- ${stamp}_${slug}
--
-- WHAT THIS CHANGES
--   (one or two sentences — the change itself, not the ticket number)
--
-- WHY
--   (what goes wrong without it. If this is a money or permissions change, say what
--    the wrong behaviour costs — that is what the next reader needs.)
--
-- HOW TO VERIFY
--   (a query or a step that proves it worked. Run it in a SEPARATE run from the DDL:
--    a verification SELECT in the same transaction sees uncommitted changes and will
--    report success for a change that is about to roll back. See AGENTS.md §5.)

begin;

-- your DDL here

commit;
`);

console.log(`Created ${file}`);
console.log(`\nRemember:`);
console.log(`  • small batches — one begin/commit per logical step`);
console.log(`  • verify in a SEPARATE run, never inside the same transaction`);
console.log(`  • only one person applies a migration at a time (the DB is shared)`);
