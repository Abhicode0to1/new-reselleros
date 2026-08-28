#!/usr/bin/env node
/**
 * Production ne pichhle N ghanton me kya bigada — ek command me.
 *
 * ─── YE KYUN BANA ───────────────────────────────────────────────────────────
 * 28 Aug 2026. `gcloud auth login` hone ke baad maine haath se chaar-paanch log query
 * chalayi, aur unme TEEN asli bug nikle jo hafton se chup-chaap chal rahe the:
 *
 *   - Gemini call 15s par timeout → ek asli lead ka reply nahi gaya (usi din)
 *   - /api/webhooks/inbound-purchase 24 Aug se HAR request 401 kar raha tha (5 din)
 *   - inbound-email ne 24 Aug ko 5 baar 500 diya
 *
 * Teeno ka ek hi lakshan tha: **kisi screen par kuch nahi**. Sentry ka DSN lagi hai par
 * uska access nahi hai; DB me sirf woh dikhta hai jo code jaan-boojhkar likhta hai. Yaani
 * inhe dhoondhne ka ek hi raasta tha — kisi ka jaa kar dekhna.
 *
 * "Kisi ka jaa kar dekhna" ek plan nahi hai. Isliye ye script.
 *
 *     npm run health:prod            # pichhle 24 ghante
 *     npm run health:prod 168        # pichhle 7 din
 *
 * Ye kuch theek nahi karti — sirf woh teen sawaal poochhti hai jinke jawab aaj teen bug
 * de gaye, aur "sab theek hai" ko bhi SAAF likhti hai. Ek report jo hamesha lambi ho, wo
 * padhi nahi jaati.
 */
import { execSync } from "node:child_process";

const HOURS = Number(process.argv[2] ?? 24);
const SERVICE = "resellersos";
const REGION = "asia-south1";
const FRESH = `${HOURS}h`;

/**
 * gcloud ko bulane ka tareeka, aur uski do majboori.
 *
 * 1. `shell: true` chahiye. Windows par `gcloud` ek .cmd hai aur naya Node use bina shell
 *    spawn karne se mana kar deta hai (EINVAL) — `execFileSync` aur `spawn` dono.
 * 2. Isliye poori command EK string hai, aur us string me filter ko double-quote karna
 *    padta hai. Iska seedha nateeja: **filter ke andar double-quote nahi ho sakta**, warna
 *    cmd aur bash dono par tootega.
 *
 * Isliye neeche ke saare filter jaan-boojhkar quote-free tokens use karte hain —
 * `logName:stderr` (na ki `logName:"stderr"`), aur ek shabd wala
 * `textPayload:INBOUND_REQUIRE_HEADER` (na ki `textPayload:"URL me aaya"`). Dono thok kar
 * dekhe gaye hain, 28 Aug 2026.
 */
function logRead(filter, fields, limit = 200) {
  if (filter.includes('"')) throw new Error(`filter me double-quote nahi chal sakta: ${filter}`);
  const cmd = `gcloud logging read "${filter}" --limit=${limit} --freshness=${FRESH} --format="value(${fields})"`;
  try {
    return execSync(cmd, {
      encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const msg = String(e.stderr || e.message || "");
    if (/Reauthentication|credentials/i.test(msg)) {
      console.error("gcloud ka login expire hai. Pardeep ko: gcloud auth login");
      process.exit(2);
    }
    console.error(`gcloud fail hua: ${msg.split("\n")[0]}`);
    process.exit(2);
  }
}

const BASE = `resource.type=cloud_run_revision AND resource.labels.service_name=${SERVICE}`;
const lines = (t) => t.split("\n").map((x) => x.trim()).filter(Boolean);
const tally = (arr) => {
  const m = new Map();
  for (const k of arr) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

console.log(`\nProduction — pichhle ${HOURS} ghante · ${SERVICE} · ${REGION}\n${"─".repeat(60)}`);
const clean = [];

/* ── 1. 5xx, path ke hisaab se ─────────────────────────────────────────────
   Aaj isi ne inbound-email ke 5 × 500 dikhaye. */
const five = lines(logRead(`${BASE} AND httpRequest.status>=500`, "httpRequest.status,httpRequest.requestUrl"))
  /* Secret query param me aata hai — report me use kaat do, warna ye script khud wahi
     leak dohra degi jise band karne ki koshish chal rahi hai. */
  /* URL line ke BEECH me hai ("500<TAB>https://..."), isliye ^ anchor nahi chalta.
     Pehli koshish me wahi galti thi aur report me poora host chhap gaya. */
  /* URL line ke BEECH me hai ("500<TAB>https://host/path"), isliye ^ anchor nahi chalta —
     pehli koshish me wahi galti thi aur report me poora host chhap gaya.

     Aur koi backslash-escape NAHI: doosri koshish me `[^/\s]` likha tha, backslash raaste
     me kho gaya, aur class ne literal `s` ko exclude kar diya — regex `https://re` par ruk
     gayi kyunki "resellersos" ka teesra akshar `s` hai. Host me `/` hota hi nahi, to sirf
     `/` exclude karna kaafi aur surakshit hai. */
  .map((l) => l.replace(/https?:[/][/][^/]+/g, "").replace(/([?&](key|token|secret)=)[^&]+/gi, "$1***"));
if (five.length) {
  console.log("\n5xx:");
  for (const [k, n] of tally(five)) console.log(`  ${String(n).padStart(3)} × ${k}`);
} else clean.push("koi 5xx nahi");

/* ── 2. 401, path ke hisaab se ─────────────────────────────────────────────
   Aaj isi ne 5 din se chup-chaap reject ho raha purchase webhook pakda. Ek public
   endpoint par thoda 401 normal hai; ek hi path par LAGATAR 401 normal nahi hai. */
const un = lines(logRead(`${BASE} AND httpRequest.status=401`, "httpRequest.requestUrl"))
  /* URL line ke BEECH me hai ("500<TAB>https://..."), isliye ^ anchor nahi chalta.
     Pehli koshish me wahi galti thi aur report me poora host chhap gaya. */
  /* URL line ke BEECH me hai ("500<TAB>https://host/path"), isliye ^ anchor nahi chalta —
     pehli koshish me wahi galti thi aur report me poora host chhap gaya.

     Aur koi backslash-escape NAHI: doosri koshish me `[^/\s]` likha tha, backslash raaste
     me kho gaya, aur class ne literal `s` ko exclude kar diya — regex `https://re` par ruk
     gayi kyunki "resellersos" ka teesra akshar `s` hai. Host me `/` hota hi nahi, to sirf
     `/` exclude karna kaafi aur surakshit hai. */
  .map((l) => l.replace(/https?:[/][/][^/]+/g, "").replace(/([?&](key|token|secret)=)[^&]+/gi, "$1***"))
  .map((l) => l.split("?")[0]);
if (un.length) {
  console.log("\n401 (ek hi path par lagatar = kuch toota hai):");
  for (const [k, n] of tally(un)) console.log(`  ${String(n).padStart(3)} × ${k}`);
} else clean.push("koi 401 nahi");

/* ── 3. App ne khud kya likha ─────────────────────────────────────────────
   Aaj isi ne Gemini ka timeout dikhaya.

   Multi-line dump ko line-ke-hisaab se ginna is section ko report se LOG bana deta hai —
   28 Aug ko 7-din wale run me top par `}` (36 baar) aur `{` (12 baar) aa gaye the. Isliye
   do tarah ki line rakhi jaati hain: hamare apne `[label]` wale log, aur wo line jo ek
   poora vaakya lagti hai (jaise Gemini ka "This model is currently experiencing high
   demand"). Baaki chup-chaap nahi girti — unki ginti neeche ek line me likhi jaati hai,
   kyunki "kuch chhupa liya" aur "kuch nahi tha" ek jaise nahi dikhne chahiye. */
const rawErr = lines(logRead(`${BASE} AND logName:stderr`, "textPayload"))
  /* Header-migration ki chetavni yahan NAHI — wo error nahi hai, aur section 4 use apne
     naam se ginta hai. Do jagah ginne se report me ek hi baat do baar dikhti thi. */
  .filter((l) => !l.includes("INBOUND_REQUIRE_HEADER"));

const worthReading = (l) =>
  l.startsWith("[") ||
  (l.length >= 30 && l.trim().split(" ").filter(Boolean).length >= 4);

const err = rawErr.filter(worthReading).map((l) => {
  if (!l.startsWith("[")) return l.slice(0, 70);
  const end = l.indexOf("]");
  return `${l.slice(0, end + 1)} ${l.slice(end + 1).trim().slice(0, 60)}`;
});
const dropped = rawErr.length - err.length;

if (err.length) {
  console.log("\napp ke apne error:");
  for (const [k, n] of tally(err).slice(0, 12)) console.log(`  ${String(n).padStart(3)} × ${k}`);
  if (dropped) console.log(`  (+ ${dropped} aur line — stack/JSON dump ke tukde)`);
} else if (dropped) {
  console.log(`\napp ke apne error: sirf ${dropped} stack/JSON tukde, koi padhne layak line nahi`);
} else clean.push("app ne koi error nahi likha");

/* ── 4. Secret abhi bhi URL me aa raha hai? ────────────────────────────────
   Header wali migration kab poori hui, ye isse naapa jayega. */
const q = lines(logRead(`${BASE} AND textPayload:INBOUND_REQUIRE_HEADER`, "textPayload", 50));
if (q.length) console.log(`\nsecret abhi bhi URL me: ${q.length} baar — forwarder migrate nahi hua`);
else clean.push("secret URL me nahi aaya");

if (clean.length) console.log(`\nSAAF: ${clean.join(" · ")}`);
console.log("");
