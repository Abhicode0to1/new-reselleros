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
 * inhe dhoondhne ka ek hi raasta tha — kisi ka jaa kar dekhna. Woh ek plan nahi hai.
 *
 *     npm run health:prod            # pichhle 24 ghante
 *     npm run health:prod 168        # pichhle 7 din
 *
 * ─── AUR HAR LINE PAR "AAKHRI BAAR KAB" ─────────────────────────────────────
 * Ye column isliye juda ki pehla version ise CHHOD gaya tha, aur usi din us kami ne mujhe
 * galat nateeje par pahuncha diya. 7-din wale run me `429` ki ginti dikhi aur maine use
 * "abhi ho raha hai" padh liya — Pardeep ko batane tak pahunch gaya. Sach ye tha ki saare
 * 429 usne 24 Aug 12:33 par Gemini key badalne se PEHLE ke the, aur uske baad ek bhi nahi.
 *
 * Ginti batati hai ki kitna hua. **Ginti nahi batati ki abhi ho raha hai ya nipat gaya** —
 * aur health check me wahi sabse zaroori sawaal hai.
 */
import { execSync } from "node:child_process";

const HOURS = Number(process.argv[2] ?? 24);
const SERVICE = "resellersos";
const REGION = "asia-south1";
const FRESH = `${HOURS}h`;
const BASE = `resource.type=cloud_run_revision AND resource.labels.service_name=${SERVICE}`;

/**
 * gcloud ko bulane ka tareeka, aur uski do majboori.
 *
 * 1. `shell: true` chahiye. Windows par `gcloud` ek .cmd hai aur naya Node use bina shell
 *    spawn karne se mana kar deta hai (EINVAL) — `execFileSync` aur `spawn` dono.
 * 2. Isliye poori command EK string hai, aur us string me filter ko double-quote karna
 *    padta hai. Iska seedha nateeja: filter ke andar double-quote nahi ho sakta.
 *
 * Isliye neeche ke saare filter quote-free tokens use karte hain — `logName:stderr`
 * (na ki logName ke saath quote), aur ek shabd wala `textPayload:INBOUND_REQUIRE_HEADER`.
 * Dono thok kar dekhe gaye, 28 Aug 2026.
 */
function logRead(filter, fields, limit = 300) {
  if (filter.includes('"')) throw new Error(`filter me double-quote nahi chal sakta: ${filter}`);
  /* timestamp hamesha pehla field — "aakhri baar kab" isi se banta hai. */
  const cmd = `gcloud logging read "${filter}" --limit=${limit} --freshness=${FRESH} --format="value(timestamp,${fields})"`;
  try {
    return execSync(cmd, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
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

/** ISO timestamp → `24 Aug 09:03` (IST). */
function ist(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "?";
  const d = new Date(t + 5.5 * 3600 * 1000);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())} ${mon} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** Log ki line → { ts, rest }. gcloud fields ko tab se alag karta hai. */
function rows(text) {
  return text.split("\n").map((l) => l.trimEnd()).filter(Boolean).map((l) => {
    const i = l.indexOf("\t");
    return i < 0 ? { ts: "", rest: l.trim() } : { ts: l.slice(0, i), rest: l.slice(i + 1).trim() };
  });
}

/** Ginti + aakhri baar kab, dono. */
function tally(items) {
  const m = new Map();
  for (const { ts, key } of items) {
    const cur = m.get(key) ?? { n: 0, last: "" };
    cur.n += 1;
    if (ts > cur.last) cur.last = ts;
    m.set(key, cur);
  }
  return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
}

function show(title, items, cap = 12) {
  if (!items.length) return false;
  console.log(`\n${title}`);
  const t = tally(items);
  for (const [k, { n, last }] of t.slice(0, cap)) {
    console.log(`  ${String(n).padStart(3)} ×  ${ist(last).padEnd(13)} ${k}`);
  }
  if (t.length > cap) console.log(`  (+ ${t.length - cap} aur tarah ki line)`);
  return true;
}

/* Secret query param me aata hai — report me use kaat do, warna ye script khud wahi leak
   dohra degi jise band karne ki koshish chal rahi hai. Aur URL line ke BEECH me hai, isliye
   `^` anchor nahi; aur koi backslash-escape nahi (`[^/` + `\s]` likhne par backslash raaste
   me kho gaya tha aur class ne literal `s` ko exclude kar diya). Host me `/` hota hi nahi. */
const scrub = (s) => s.replace(/https?:[/][/][^/]+/g, "").replace(/([?&](key|token|secret)=)[^&\s]+/gi, "$1***");

console.log(`\nProduction — pichhle ${HOURS} ghante · ${SERVICE} · ${REGION}`);
console.log(`${"─".repeat(66)}\n  ginti    aakhri baar    kya`);
const clean = [];

/* ── 1. 5xx ── aaj isi ne inbound-email ke 5 × 500 dikhaye. */
const five = rows(logRead(`${BASE} AND httpRequest.status>=500`, "httpRequest.status,httpRequest.requestUrl"))
  .map(({ ts, rest }) => ({ ts, key: scrub(rest).replace(/\s+/g, " ") }));
if (!show("5xx:", five)) clean.push("koi 5xx nahi");

/* ── 2. 401 ── aaj isi ne 5 din se chup-chaap reject ho raha purchase webhook pakda.
   Ek public endpoint par thoda 401 normal hai; ek hi path par LAGATAR 401 normal nahi. */
const un = rows(logRead(`${BASE} AND httpRequest.status=401`, "httpRequest.requestUrl"))
  .map(({ ts, rest }) => ({ ts, key: scrub(rest).split("?")[0] }));
if (!show("401 (ek hi path par lagatar = kuch toota hai):", un)) clean.push("koi 401 nahi");

/* ── 3. App ne khud kya likha ── aaj isi ne Gemini ka timeout dikhaya.
   Multi-line dump ko line-ke-hisaab se ginna is section ko report se LOG bana deta hai —
   pehle run me top par `}` (36 baar) aur `{` (12 baar) aa gaye the. Isliye do tarah ki
   line rakhi jaati hain: hamare apne [label] wale log, aur wo line jo poora vaakya lagti
   hai. Baaki chup-chaap nahi girti — ginti neeche likhi jaati hai, kyunki "kuch chhupa
   liya" aur "kuch nahi tha" ek jaise nahi dikhne chahiye. */
const raw = rows(logRead(`${BASE} AND logName:stderr`, "textPayload"))
  /* Header-migration ki chetavni yahan NAHI — wo error nahi hai, section 4 use ginta hai. */
  .filter(({ rest }) => !rest.includes("INBOUND_REQUIRE_HEADER"));
const worth = ({ rest: l }) =>
  l.startsWith("[") || (l.length >= 30 && l.trim().split(" ").filter(Boolean).length >= 4);
const err = raw.filter(worth).map(({ ts, rest: l }) => {
  if (!l.startsWith("[")) return { ts, key: l.slice(0, 62) };
  const e = l.indexOf("]");
  return { ts, key: `${l.slice(0, e + 1)} ${l.slice(e + 1).trim().slice(0, 52)}` };
});
const dropped = raw.length - err.length;
if (show("app ke apne error:", err)) {
  if (dropped) console.log(`  (+ ${dropped} aur line — stack/JSON dump ke tukde)`);
} else if (dropped) {
  console.log(`\napp ke apne error: sirf ${dropped} stack/JSON tukde, koi padhne layak line nahi`);
} else clean.push("app ne koi error nahi likha");

/* ── 4. Secret abhi bhi URL me? Header wali migration kab poori hui, ye isse naapa jayega. */
const q = rows(logRead(`${BASE} AND textPayload:INBOUND_REQUIRE_HEADER`, "textPayload", 100));
if (q.length) {
  const last = q.reduce((a, b) => (b.ts > a ? b.ts : a), "");
  console.log(`\nsecret abhi bhi URL me: ${q.length} baar, aakhri ${ist(last)} — forwarder migrate nahi hua`);
} else clean.push("secret URL me nahi aaya");

if (clean.length) console.log(`\nSAAF: ${clean.join(" · ")}`);
console.log("");
