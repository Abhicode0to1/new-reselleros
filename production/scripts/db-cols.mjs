#!/usr/bin/env node
/**
 * Table ke column ke naam — ek command me.
 *
 * ─── YE KYUN BANA ───────────────────────────────────────────────────────────
 * 28 Aug 2026 ko main CHAAR baar column ka naam galat likh kar query fail karwa chuka tha:
 *
 *     user_google_tokens.scope        → asli naam `scopes`
 *     user_google_tokens.expires_at   → asli naam `token_expiry`
 *     ai_action_log.status            → asli naam `outcome`
 *     leads.display_id                → aisa column hai hi nahi
 *
 * Har galti ek poora round trip khaati hai: query bhejo, error padho, information_schema
 * se naam nikaalo, phir asli query likho. Chaar baar me wo kaafi waqt ho jata hai, aur
 * error ka message har baar sirf PEHLA galat column batata hai — to do galtiyan do round
 * trip hain.
 *
 * Isliye guess band, ek command:
 *     npm run db:cols leads
 *     npm run db:cols            # saari tables
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const filter = process.argv[2] ?? null;

/* information_schema se, kyunki ye hamesha sach bolta hai — koi generated type file nahi
   jo migration ke baad purani pad jaye. */
const sql = `
select table_name,
       string_agg(column_name, ' · ' order by ordinal_position) as cols
from information_schema.columns
where table_schema = 'public'
  ${filter ? `and table_name like '%${filter.replace(/[^a-zA-Z0-9_]/g, "")}%'` : ""}
group by table_name
order by table_name;
`;

const dir = mkdtempSync(join(tmpdir(), "dbcols-"));
const file = join(dir, "q.sql");
writeFileSync(file, sql);

/* CLI, MCP nahi — MCP read-only hai aur ye read hi hai, par CLI wahi darwaza hai jo
   skills/resellersos-env me naapa gaya hai. `env -u` ki zaroorat nahi rahi (28 Aug). */
/* shell: true CHAHIYE — Windows par `npx` ek .cmd hai aur naya Node use bina shell
   spawn karne se mana kar deta hai (EINVAL). Par args ARRAY ke saath shell dene par
   DEP0190 warning aati hai, to poori command ek hi string me deta hoon. Path mera banaya
   hua tmpdir ka hai, isliye quote kaafi hai. */
const child = spawn(`npx supabase db query --linked -f "${file}"`, { shell: true });

let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", () => {});
child.on("exit", (code) => {
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) {
    console.error(`Kuch nahi mila (exit ${code}). Kaccha jawab:\n${out.slice(0, 500)}`);
    process.exit(1);
  }
  const rows = JSON.parse(m[0]).rows ?? [];
  if (!rows.length) {
    console.log(filter ? `Koi table "${filter}" se match nahi hui.` : "Koi table nahi mili.");
    process.exit(1);
  }
  for (const r of rows) console.log(`\n── ${r.table_name}\n   ${r.cols}`);
  console.log(`\n${rows.length} table${rows.length > 1 ? "s" : ""}.`);
});
