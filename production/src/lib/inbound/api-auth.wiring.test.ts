import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/* ─────────────────────────────────────────────────────────────────────────────
   HAR IN-APP API ROUTE APNA DARWAZA KHUD BAND KARE.

   30 Aug 2026 ko Enquiries page dekhte waqt do route mile jinme auth ki jaanch THI HI NAHI:

     · GET  /api/inbound-emails              → bina login ANUTECH ka poora inbox
     · POST /api/inbound-emails/[id]/convert → bina login kisi bhi enquiry se lead

   Dono `createAdminClient()` (service_role) use karte hain, jo RLS ko poori tarah bypass
   karta hai — yaani database wapas nahi rok sakta. Aur middleware bhi nahi rokta:
   PROTECTED_PREFIXES me `/enquiries` (PAGE) hai, `/api` nahi. To jaanch sirf route ke
   apne andar ho sakti hai, aur wahi gायab thi.

   Do padosi route — `[id]/state` aur `[id]/reply` — hamesha se theek the. Isliye ye
   bhoolne wali galti hai, soch-samajh kar liya faisla nahi — aur bhoolne wali galti
   dobara hoti hai. Ye file har baar khud padh kar poochhti hai.

   Ye test un route par NAHI chalta jinka auth kisi aur tarah ka hai — `/api/cron/*`
   (CRON_SECRET), `/api/public/*` (jaan-boojhkar khula), `/api/webhooks/*` (signature),
   `/api/v1/*` (API key), `/api/portal/*` (portal token). Unhe yahan kheenchna is test ko
   shor bana dega, aur shor macha-ne wala test band kar diya jata hai.
   ───────────────────────────────────────────────────────────────────────────── */

const API_DIR = join(process.cwd(), "src", "app", "api");

/** Jinka apna alag darwaza hai — inhe ye test nahi dekhta. */
const OTHER_DOORS = /^(cron|public|webhooks|v1|portal|auth)$/;

/** Service role — RLS bypass. Yahi wo cheez hai jo tenant filter ko suraksha banati hai. */
const USES_ADMIN = /createAdminClient\s*\(/;

/** Kya route ne poochha "tum kaun ho"? */
const CHECKS_USER = /auth\.getUser\s*\(/;

/* ── EK CHHOOT, NAAM SE, WAJAH KE SAATH ──────────────────────────────────────
   `attendance/punch` ek MACHINE ka darwaza hai — office ka biometric bridge ise call
   karta hai, uska koi login nahi hota. Uske paas apni chaabi hai: per-tenant
   `x-ingest-key` header, aur tenant USI chaabi se nikala jata hai (chaabi na ho to 401,
   galat ho to 401). Yaani jaanch maujood hai, bas `auth.getUser()` ki shakl me nahi.

   Ise regex dheela karke chhoot NAHI di gayi. Dheela regex agli baar chup-chaap kisi
   aur ko bhi chhoot de deta — aur wo agla shayad asli chhed ho. Naam se chhoot dikhti
   hai, aur is list me kuch jodne ke liye wajah likhni padti hai. */
/* ── DOOSRI CHHOOT: `dev/portal-signin` ──────────────────────────────────────
   11 Sep 2026. Ye route demo portal customer ko EK CLICK me andar karta hai —
   Pardeep: "shouldn't i be logged in directly like others login of owner and
   tenet". Wo SESSION BANATA hai, to us se `auth.getUser()` maangna ulta hai:
   call karne wale ke paas identity hoti hi nahi, wahi to ye de raha hai.

   Uski apni chaabi DO hai, aur dono alag-alag:
     1. `NODE_ENV === "production"` par 404 — 403 nahi, warna probe ko pata chal
        jata hai ki route hai.
     2. Email `.invalid` par khatam hona ZAROORI hai (RFC 2606). Yahi wo pehra
        hai jo akela bhi khada rehta hai: `.invalid` kisi asli insaan ka pata ho
        hi nahi sakta, to ye route KISI ASLI customer ko andar nahi kar sakta.
        "mushkil hai" nahi — aisa pata maujood hi nahi hai.
     3. Sirf POST. GET jo session banata ho, wo ek prefetch ki doori par hai.

   Regex dheela karke chhoot NAHI li — upar wali wajah wahi hai. Naam se, wajah
   ke saath. */
const MACHINE_DOORS = new Set([
  "attendance/punch/route.ts",
  "dev/portal-signin/route.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else if (d.name === "route.ts") out.push(p);
  }
  return out;
}

const inApp = walk(API_DIR)
  .filter((p) => {
    const rel = p.slice(API_DIR.length + 1).replace(/\\/g, "/");
    return !OTHER_DOORS.test(rel.split("/")[0]);
  })
  .map((path) => ({
    name: path.slice(API_DIR.length + 1).replace(/\\/g, "/"),
    src: readFileSync(path, "utf8"),
  }));

describe("in-app API routes jo service_role use karte hain, wo login maangte hain", () => {
  it("route mile hi — warna neeche ka loop zero baar chalega aur jhooth bol kar green hoga", () => {
    /* Khaali loop hamesha pass hota hai. Ginti pehle — 28 Aug wali seekh. */
    expect(inApp.length).toBeGreaterThanOrEqual(20);
  });

  const admins = inApp.filter((r) => USES_ADMIN.test(r.src) && !MACHINE_DOORS.has(r.name));

  it("machine wale darwaze abhi bhi maujood hain — chhoot ki list sadi hui na ho", () => {
    /* Agar `attendance/punch` ka naam badal gaya aur ye set khaali chhoot deta rahа, to
       chhoot ek murda niyam ban jaata. Naam maujood hai, ye jaanch us par zid karti hai. */
    for (const name of MACHINE_DOORS) {
      expect(inApp.some((r) => r.name === name)).toBe(true);
    }
  });

  it("chhoot pane wala route apni chaabi khud maangta hai", () => {
    const punch = inApp.find((r) => r.name === "attendance/punch/route.ts")!;
    expect(/x-ingest-key/.test(punch.src)).toBe(true);
    expect(/attendance_ingest_key/.test(punch.src)).toBe(true);
    expect(/401/.test(punch.src)).toBe(true);
  });

  /* Doosri chhoot ke dono pehre, naap kar. Chhoot dene ka matlab "jaanch nahi"
     nahi hai — matlab "jaanch doosri shakl me hai", aur wo shakl maujood rehni
     chahiye. Ye hat gaya to dev route asli customer ko andar kar sakta hai. */
  it("dev/portal-signin sirf dev me chalta hai aur sirf .invalid pata maanta hai", () => {
    const dev = inApp.find((r) => r.name === "dev/portal-signin/route.ts")!;
    /* Pehra 1 — production me 404. */
    expect(/NODE_ENV\s*===\s*"production"/.test(dev.src)).toBe(true);
    expect(/404/.test(dev.src)).toBe(true);
    /* Pehra 2 — asli pata kabhi nahi. Yahi akela bhi kaafi hai. */
    expect(/endsWith\(\s*"\.invalid"\s*\)/.test(dev.src)).toBe(true);
    /* Pehra 3 — GET nahi. */
    expect(/export\s+async\s+function\s+POST/.test(dev.src)).toBe(true);
    expect(/export\s+async\s+function\s+GET/.test(dev.src)).toBe(false);
    /* Aur session asli hai — hand-rolled cookie nahi. */
    expect(/verifyOtp/.test(dev.src)).toBe(true);
  });

  it("service_role wale route bhi mile", () => {
    expect(admins.length).toBeGreaterThanOrEqual(2);
  });

  for (const r of admins) {
    it(`${r.name} — admin client use karta hai, to auth.getUser() bhi karta hai`, () => {
      expect(CHECKS_USER.test(r.src)).toBe(true);
    });
  }
});

describe("inbound-emails ka har route tenant se scope karta hai", () => {
  const inbound = inApp.filter((r) => r.name.startsWith("inbound-emails/"));

  it("chaaron route mile", () => {
    /* list · [id]/state · [id]/reply · [id]/convert */
    expect(inbound.length).toBeGreaterThanOrEqual(4);
  });

  for (const r of inbound) {
    it(`${r.name} — tenant_id se scope karta hai`, () => {
      /* `.eq("id", …)` akela sirf ye saabit karta hai ki row maujood hai — ye nahi ki
         wo TUMHARI hai. Tenant filter hi wo lakeer hai, kyunki admin client par RLS
         nahi chalti. */
      expect(/tenant_id/.test(r.src)).toBe(true);
    });
  }
});
