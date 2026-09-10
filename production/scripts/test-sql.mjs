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

/* ── KAUNSA DATABASE ─────────────────────────────────────────────────────────
 *
 * 10 Sep 2026 tak yahan `--linked` HARDCODED tha, yaani ye script sirf production
 * par chal sakti thi. Local stack par har ek file `LegacyProjectNotLinkedError`
 * deti thi — 53 me se 53. Aur is repo me TASKS.md me likha "47/53 pass" bhi isi
 * script se nahi, `docker exec psql` se nikala gaya tha.
 *
 * Wahi shakl jo `npm run setup` me thi: jo command likhi hui hai, wahi chal nahi
 * sakti. Naye developer ke paas local DB hai aur suite chalane ka koi raasta nahi.
 *
 * Default `--linked` hi raha, jaan-boojh kar — usse badalne se `npm run test:sql`
 * ka matlab chupchaap badal jaata, aur "maine test chalaye" kehne wala aadmi ye
 * na jaan pata ki kis database par chalaye. Naya raasta maangna padta hai:
 *   npm run test:sql          → production (jaisa pehle tha)
 *   npm run test:sql:local    → local stack
 */
const LOCAL = process.argv.slice(2).includes("--local");
const TARGET_NAME = LOCAL ? "LOCAL stack" : "PRODUCTION (linked)";

/* ── LOCAL PAR CLI KAAM NAHI KARTI, AUR YE NAAPA HUA HAI ─────────────────────
 *
 * Pehli koshish `supabase db query --local` thi. Wo ek hi statement chala sakti
 * hai: har test file `begin; … rollback;` hai, to CLI kehti hai
 *
 *     cannot insert multiple commands into a prepared statement
 *
 * `--db-url` bhi wahi deti hai — dono ek hi prepared-statement raaste se jaate
 * hain. Management API (yaani `--linked`) multi-statement sambhal leta hai,
 * local wala nahi. Isliye local ke liye seedha `psql`, container ke andar.
 *
 * Container ka naam config.toml ke `project_id` se banta hai — hardcode nahi,
 * warna doosre developer ki machine par (jahan project_id alag hai) ye chup-chaap
 * "docker error" degi aur wo isse test-failure samjhega.
 *
 * ─── ON_ERROR_STOP=1 KYUN, AUR YE SABSE ZAROORI LINE HAI ────────────────────
 * Iske BINA psql exception par bhi **exit 0** deta hai. Naapa:
 *     canary (raise exception) bina flag → exit 0   ← poori suite jhooth
 *     canary (raise exception) flag ke saath → exit 3
 * Yaani bina is flag ke ye script 53/53 "pass" chhaap deti aur ek bhi test
 * chala hi nahi hota. Canary isi ke liye hai, aur usne isi ko pakda.
 */
const PROJECT_ID = (() => {
  try {
    const toml = readFileSync("supabase/config.toml", "utf8");
    return /^\s*project_id\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
  } catch {
    return null;
  }
})();
const DB_CONTAINER = PROJECT_ID ? `supabase_db_${PROJECT_ID}` : null;

if (LOCAL && !DB_CONTAINER) {
  console.error("RUKA — supabase/config.toml me `project_id` nahi mila, to local");
  console.error("       database ka container naam pata nahi chal raha.");
  process.exit(6);
}

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
    const r = LOCAL
      ? spawnSync(
          "docker",
          ["exec", "-i", DB_CONTAINER, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", "-f", "-"],
          { encoding: "utf8", input: readFileSync(path, "utf8"), timeout: 120_000 },
        )
      : spawnSync("npx", ["supabase", "db", "query", "--linked", "-f", path], {
          encoding: "utf8", shell: true, timeout: 120_000,
        });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    /* Docker khud band ho to wo test ka fail nahi hai. Naam se batao, warna
       aadmi 53 "FAIL" dekh kar apne SQL me galti dhoondhta rahega. */
    if (LOCAL && /Cannot connect to the Docker daemon|No such container|docker: not found|error during connect/i.test(out)) {
      console.error(`\nRUKA — local database tak pahunch nahi: ${DB_CONTAINER}`);
      console.error("       Docker Desktop chalu hai? Phir:  npx supabase start");
      console.error("       Ye test ka fail NAHI hai.");
      process.exit(7);
    }
    /* Ek deewar jo kisi ka poora session kha sakti hai. Bina `--local` ke, jis
       machine par project linked nahi hai, HAR file yahi error deti hai — aur
       error khud ye nahi batata ki local ka raasta maujood hai. Isliye yahan
       batata hai, ek baar, aur ruk jaata hai. */
    if (!LOCAL && /LegacyProjectNotLinkedError|Cannot find project ref/i.test(out)) {
      console.error("\nRUKA — is machine par koi Supabase project linked nahi hai.");
      console.error("       Local stack par chalane ke liye:  npm run test:sql:local");
      console.error("       Production par chalane ke liye:    npx supabase link  (interactive)");
      process.exit(5);
    }
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
console.log(`canary laal — harness sach me fail hota hai. ab asli test.`);
/* Target ka naam har run me, shuru me AUR aakhir me. "Maine test chalaye" ek
   adhoora vaakya hai jab tak ye pata na ho ki kis database par — aur ek hi flag
   ka farq hai production aur local me. */
console.log(`chal raha hai: ${TARGET_NAME}\n`);

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
console.log(`\n${list.length - failed.length}/${list.length} pass  ·  ${TARGET_NAME}`);
for (const f of failed) {
  console.log(`\n───── ${f.name}`);
  /* Quote par NA rukna, local par.
   *
   * Purana pattern `/ERROR:[^\\"]{0,400}/` tha, jo `"` par ruk jaata hai. Prod ke
   * JSON output me wo theek tha; psql ke saade output me wo theek WAHI cheez kaat
   * deta hai jo chahiye:
   *     ERROR:  relation "backup.snapshots" does not exist
   * chhap kar aata tha  ->  `ERROR:  relation`
   * Do failure ka pata isi wajah se nahi chal raha tha. DETAIL bhi saath, kyunki
   * duplicate-key me asli khabar ("Key (id)=(1111…) already exists") wahin hoti hai. */
  const why = LOCAL
    ? f.out.match(/^(?:psql:[^:]*:\d+: )?(?:ERROR|DETAIL|HINT):.*$/gm)
    : f.out.match(/ERROR:[^\\"]{0,400}/g);
  console.log((why ? why.join("\n") : f.out.slice(0, 600)).trim());
}
process.exit(failed.length ? 1 : 0);
