#!/usr/bin/env node
/**
 * supabase/tests/ ke saare SQL regression test ek saath chalao.
 *
 * ─── YE KYUN HAI ────────────────────────────────────────────────────────────
 * Ye test paise wale raaste ki hifazat karte hain — `record_payment` ka idempotency,
 * issued invoice ka immutable hona, invoice delete par serial dobara na milna, aur paanch
 * alag tenant-isolation. CLAUDE.md §25.2 khud kehta hai ki ye "not in CI and not in the
 * hook" hain, yaani inhe chalane ka ek hi tarika tha: koi haath se yaad rakhe.
 *
 * 29 Aug 2026: koi npm script tha hi nahi. Yaani inhe ek saath kabhi chalaya hi nahi gaya.
 *
 * ─── PRODUCTION PAR CHALTE HAIN, AUR YE SURAKSHIT HAI ───────────────────────
 * Har file `begin; … rollback;` me lipti hai, aur Postgres me DDL bhi transactional hai.
 * Chalane se pehle ye script khud jaanchti hai ki har file me `rollback` hai aur `commit`
 * NAHI hai — ek bhi file is shart par fail hui to kuch bhi nahi chalta.
 *
 * ─── EXIT 0 KA MATLAB ───────────────────────────────────────────────────────
 * Ye file `raise exception` se fail hoti hai aur exit 1 deti hai (24 Aug ko naapa). Par
 * exit 0 wo bhi deti hai jo chup-chaap kuch na kare. Isliye har run ke saath ek CANARY
 * chalta hai — ek file jo hamesha fail honi chahiye. Canary hara ho gaya to poori report
 * bekaar hai, aur script khud fail ho jaati hai.
 */
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const DIR = "supabase/tests";
const only = process.argv.slice(2).find((a) => !a.startsWith("-")) ?? null;

/* ── 1. Surakshit hai ya nahi — kuch chalane se pehle ── */
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const unsafe = files.filter((f) => {
  const s = readFileSync(join(DIR, f), "utf8");
  return !/^\s*rollback\s*;/im.test(s) || /^\s*commit\s*;/im.test(s);
});
if (unsafe.length) {
  console.error("RUKA — ye file production par rollback nahi karti:\n  " + unsafe.join("\n  "));
  process.exit(2);
}

/* ── 2. Canary — harness sach me fail hota hai? ── */
const tmp = mkdtempSync(join(tmpdir(), "sqlcanary-"));
const canary = join(tmp, "canary.sql");
writeFileSync(canary, "begin;\n  do $$ begin raise exception 'CANARY'; end $$;\nrollback;\n");

const TRANSIENT = /TransportError|LegacyDbConfigLoginRole|ECONNRESET|fetch failed/i;

function runOne(path) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = spawnSync("npx", ["supabase", "db", "query", "--linked", "-f", path], {
      encoding: "utf8", shell: true, timeout: 120_000,
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    /* Windows par process khatam ho jaane ka apna code hai — use "test fail" batana
       poori report ko jhootha bana dega. (backup:db isi par do baar mara tha.) */
    if (r.status === 3221225794) return { ok: false, out, fatal: "process launch (0xC0000142)" };
    /* CLI ki login-role step kabhi-kabhi network par mar jaati hai aur agli koshish me
       chal jaati hai — use bug samajh kar reh jana ek poora session kha sakta hai. */
    if (r.status !== 0 && TRANSIENT.test(out) && attempt === 1) continue;
    return { ok: r.status === 0, out };
  }
  return { ok: false, out: "" };
}

const c = runOne(canary);
if (c.ok) {
  console.error("RUKA — canary HARA hai. `raise exception` wali file bhi pass ho rahi hai,");
  console.error("       yaani neeche ka har green jhooth hota. Harness theek karo pehle.");
  process.exit(3);
}
console.log("canary laal — harness sach me fail hota hai. ab asli test.\n");

/* ── 3. Asli test ── */
const list = only ? files.filter((f) => f.includes(only)) : files;
if (!list.length) { console.error(`koi test "${only}" se mel nahi khata`); process.exit(2); }

const nameOf = (f) => f.replace(/\.test\.sql$|\.sql$/, "");
const t0 = Date.now();

/* ── EK HI CALL, jab tak sab hara hai ──────────────────────────────────────
 *
 * 29 Aug 2026 par naapa: `select 1` bhi **4.5 second** leta hai. Poora waqt CLI ke shuru
 * hone aur login-role ke handshake me jaata hai — SQL me nahi. Yaani 43 alag call ka 3+
 * minute lagbhag poora intezaar tha, kaam nahi.
 *
 * Pehle process SAMANANTAR chalane ki koshish ki. Wo **dheemi** nikli — 220s se 281s — aur
 * 6 test aapas ki takkar se laal ho gaye. Wo raasta chhod diya gaya, aur ye tippani isliye
 * hai ki koi use dobara na aazmaye.
 *
 * Sab kuch ek file me jod kar EK call: **8 second**. Har test apne `begin; … rollback;` me
 * lipta hai, isliye jodne se koi haalat ek se doosre me nahi behti.
 *
 * ── AUR YE KAISE PATA KI SAB CHALE ──
 * Ek call me CLI sirf AAKHRI statement ka nateeja dikhata hai, to 43 "PASS" line dikhti hi
 * nahi. Isliye sabse aakhir me ek MARKER lagta hai. Marker output me hai = script poori
 * chali. Marker nahi hai = beech me kahin ruk gayi, chahe exit code kuch bhi kahe — aur us
 * soorat me ye ek-ek karke dobara chalta hai, taaki naam pata chale.
 *
 * Yaani tez raasta sirf tab, jab sab hara ho. Kuch laal hua to poori keemat lagti hai —
 * aur us waqt keemat maayne nahi rakhti, naam maayne rakhta hai. */
const MARKER = "SQL_SUITE_REACHED_THE_END";
const bundle = join(tmp, "bundle.sql");
writeFileSync(
  bundle,
  list.map((f) => readFileSync(join(DIR, f), "utf8")).join("\n\n") +
    `\n\nselect '${MARKER}' as marker;\n`,
);

const fast = runOne(bundle);
const reachedEnd = fast.out.includes(MARKER);

const failed = [];
if (fast.ok && reachedEnd) {
  for (const f of list) console.log(` ok   ${nameOf(f)}`);
} else {
  console.log(
    fast.ok
      ? " ek-saath wala run beech me ruk gaya (marker nahi mila) — ab ek-ek karke\n"
      : " ek-saath wale run me kuch laal hai — ab ek-ek karke, taaki naam pata chale\n",
  );
  let n = 0;
  for (const f of list) {
    n++;
    const r = runOne(join(DIR, f));
    if (r.fatal) {
      console.error(`\n RUKA — ${nameOf(f)}: ${r.fatal}`);
      console.error(" Ye test ka fail nahi hai. Machine par process khatam ho gaye — dobara chalao.");
      process.exit(4);
    }
    console.log(`${r.ok ? " ok  " : " FAIL"} [${n}/${list.length}] ${nameOf(f)}`);
    if (!r.ok) failed.push({ name: nameOf(f), out: r.out });
  }
  if (failed.length === 0) {
    /* Ek saath laal, akele sab hare. Iska matlab test aapas me takra rahe hain — aur wo ek
       asli baat hai, chhupane wali nahi. */
    console.log("\n ⚠️  ek saath laal, akele sab hare — test aapas me takra rahe hain");
  }
}
console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)}s`);

/* ── 4. Nateeja ── */
console.log(`\n${list.length - failed.length}/${list.length} pass`);
for (const f of failed) {
  console.log(`\n───── ${f.name}`);
  const why = f.out.match(/ERROR:[^\\"]{0,400}/g);
  console.log((why ? why.join("\n") : f.out.slice(0, 600)).trim());
}
process.exit(failed.length ? 1 : 0);
