#!/usr/bin/env node
/**
 * Kya deploy live hai? — ek command, aur ye jhoot nahi bolta.
 *
 * ─── YE KYUN BANA ───────────────────────────────────────────────────────────
 * 28 Aug 2026. Maine deploy verify karne ke liye 10 minute haath se curl chalaya, aur
 * GALAT URL par. Wo URL ek mar chuki Cloud Run service ka tha (purana GCP project) aur
 * `503` ka HTML lautata tha. Mera sed usme se `sha` nikalta tha — HTML me sha nahi hota,
 * to screen par `sha=` dikha: khaali, purana sha nahi. Khaali sha "abhi deploy ho raha
 * hai" jaisa padha gaya, aur Cloud Run ka apna 503 message use pakka kar deta hai —
 * "The service you requested is not available yet. Please try again in 30 seconds."
 *
 * Deploy pehle se live tha. Pardeep ko poochhna pada ki itna waqt kyun lag raha hai.
 *
 * Do sabak, dono is script me bandhe hue hain:
 *   1. URL ek hi jagah likha ho. Repo ke 6 doc me maru URL likha tha aur AGENTS.md me
 *      sahi — yaani repo khud galat pata bata raha tha.
 *   2. HTTP code pehle dekho, body baad me. Non-200 par "pata nahi" kehna hai,
 *      "deploy ho raha hai" NAHI — wo andaza hai, naap nahi.
 */

/**
 * Prod — wahi host jo Cloud Run khud batata hai (`services describe`) aur jo service ke
 * apne `NEXT_PUBLIC_APP_URL` me set hai, yaani OAuth redirect aur email ke link isi par
 * bante hain.
 *
 * Ek ALIAS bhi zinda hai — `resellersos-1005662057478.asia-south1.run.app` — aur Cloud
 * Scheduler ke jobs usi ko call karte hain, to use "galat" samajh kar theek karne mat baith
 * jao. Par likhne ke liye ye host behtar hai: usme PROJECT NUMBER nahi hai, aur theek wahi
 * number aaj 10 minute kha gaya tha, kyunki purane project ka wahi shakl ka host 503 deta
 * hai aur dono ek jaise dikhte hain.
 */
export const PROD_URL = "https://anutech.in";

/** 28 Aug 2026 tak zinda tha, ab 503 deta hai — dobara na likha jaye. */
const DEAD_URL = "https://resellersos-490252291080.asia-south1.run.app";

const args = process.argv.slice(2);
const want = args.find((a) => !a.startsWith("-")) ?? null;   // jis sha ka intezaar hai
const timeoutMin = Number(args.find((a) => a.startsWith("--minutes="))?.split("=")[1] ?? 12);

if (args.some((a) => a.includes(DEAD_URL))) {
  console.error("Ye URL mar chuka hai. PROD_URL use karo.");
  process.exit(2);
}

async function probe() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(`${PROD_URL}/api/version`, {
      cache: "no-store", signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, note: `HTTP ${res.status}` };
    try {
      const body = JSON.parse(text);
      return { ok: true, status: res.status, sha: body.sha, buildId: body.buildId, node: body.node };
    } catch {
      /* 200 par bhi JSON na ho — to bolo, chup mat raho. */
      return { ok: false, status: res.status, note: "200 aaya par JSON nahi" };
    }
  } catch (e) {
    return { ok: false, status: 0, note: e.name === "AbortError" ? "20s me jawab nahi" : String(e.message ?? e) };
  } finally { clearTimeout(t); }
}

const started = Date.now();
const deadline = started + timeoutMin * 60_000;
let attempt = 0;

for (;;) {
  attempt += 1;
  const r = await probe();
  const mins = ((Date.now() - started) / 60_000).toFixed(1);

  if (!r.ok) {
    /* Yahi wo line hai jo pichhli baar nahi thi: failure ko failure kaho. */
    console.log(`[${mins}m] NAHI PADH SAKA — ${r.note}  (${PROD_URL})`);
  } else if (!want) {
    console.log(`[${mins}m] live: sha=${r.sha} build=${r.buildId} node=${r.node}`);
    process.exit(0);
  } else if (r.sha === want || r.sha?.startsWith(want)) {
    console.log(`[${mins}m] LIVE — sha=${r.sha} (${attempt} probe me)`);
    process.exit(0);
  } else {
    console.log(`[${mins}m] purana chal raha hai: sha=${r.sha}, chahiye ${want}`);
  }

  if (Date.now() >= deadline) {
    console.error(`\n${timeoutMin} minute me nahi hua. Ye "fail" ka saboot NAHI hai — build ka status`);
    console.error(`gcloud se dekho:  gcloud builds list --limit=3`);
    console.error(`(agar wo reauth maange to: gcloud auth login)`);
    process.exit(1);
  }
  await new Promise((s) => setTimeout(s, 30_000));
}
