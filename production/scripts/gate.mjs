#!/usr/bin/env node
/**
 * Ek command jo poora gate chalati hai — CLAUDE.md §25.2 wala gate.
 *
 * ─── YE KYUN HAI ────────────────────────────────────────────────────────────
 * Chaar cheezein chalani hoti hain aur unhe yaad rakhna padta tha. 16 Aug 2026 ko `build`
 * chhoot gaya tha aur production kai din release ho hi nahi sakta tha, jabki baaki teen hare
 * the. Yaad-daasht ko gate banana kaam nahi karta.
 *
 * ─── CHAARON ZAROORI HAIN, KOI DOOSRE KA KAAM NAHI KARTA ────────────────────
 * Maan kar nahi, thok kar dekha (29 Aug 2026): ek test file me type error daali —
 * `tsc --noEmit` ne pakdi, **`next build` ne nahi**, aur build exit 0 de kar nikal gaya.
 * Build sirf app ke graph tak dekhta hai, aur test file wahan hai hi nahi. Ulta bhi sach hai
 * aur pehle se likha tha: `typedRoutes` ke types build par bante hain, isliye ek galat
 * `<Link href>` sirf build pakadta hai.
 *
 * ─── EK KE BAAD EK. SAMANANTAR DO BAAR AAZMAYA, DONO BAAR DHEEMA. ───────────
 * Naapa, is machine par akele-akele: typecheck 52s · build 100s · vitest 32s · lint 4s.
 * Jod = 188s. Ye tippani isliye lambi hai ki agla padhne wala "inhe parallel kyun nahi
 * chalate" sochega — do baar aazmaya ja chuka hai.
 *
 * **Koshish 1 — chaaron ek saath.** Toot gaya, aur jhoothi error ke saath:
 *
 *     error TS6053: File '.next/types/app/(app)/accounting/gst/page.ts' not found   × 40+
 *
 * `tsc` `.next/types` PADHTA hai; `next build` usi folder ko MITA kar dobara banata hai. Ek
 * padh raha, ek likh raha. Kul waqt bhi 244s. (Yahi takkar dev server ke saath bhi hoti hai
 * — wahan app tooti hui dikhti hai, aur wo alag se likhi ja chuki hai.)
 *
 * **Koshish 2 — build+test+lint saath, phir typecheck.** Takkar khatam, par waqt **243s** —
 * phir bhi 188s se zyada. Wajah numbers me saaf hai: build akela 100s leta hai, saath me
 * **169s**; typecheck 52s se 74s. Kuch tez nahi hua, sab dheema ho gaya.
 *
 * Wajah core nahi hai — is machine par 22 logical CPU hain. **RAM hai:** 23.5 GB me se us
 * waqt sirf ~9 GB khaali the. `next build` ko akele hi itna chahiye ki CI me
 * `--max-old-space-size=4096` dena pada tha, aur vitest 283 file par apne worker kholta hai.
 * Dono ek saath us 9 GB me ghusne ki koshish karte hain.
 *
 * Isliye ek ke baad ek. Aur kram me build PEHLE, typecheck BAAD me — build ke baad
 * `.next/types` taaza hote hain, aur typecheck ko usi ke against chalna chahiye.
 *
 * **Is command ka faayda tez hona nahi hai — chaar me se ek bhool jana khatam karna hai.**
 * 16 Aug 2026 ko `build` chhoot gaya tha, baaki teen hare the, aur production kai din
 * release ho hi nahi sakta tha.
 *
 * ─── DHYAN ─────────────────────────────────────────────────────────────────
 * Dev server band karke chalao — `next build` `.next` uda deta hai aur chalta hua page apne
 * hi chunk par 404 dene lagta hai.
 *
 * SQL test isme jaan-boojhkar NAHI hain: wo production ko chhoote hain aur sirf DB/RPC
 * badalne par chahiye. `npm run test:sql` alag se.
 */
import { spawn } from "node:child_process";

/* Kram maayne rakhta hai: build PEHLE, taaki typecheck ko taaza `.next/types` milen. */
const STEPS = [
  { name: "build",     cmd: "npm", args: ["run", "build"] },
  { name: "typecheck", cmd: "npx", args: ["tsc", "--noEmit"] },
  { name: "test",      cmd: "npx", args: ["vitest", "run"] },
  { name: "lint",      cmd: "npm", args: ["run", "lint"] },
];

function run(step) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    /* `shell: true` chahiye — Windows par `npm`/`npx` asal me .cmd hain aur bina shell ke
       nahi chalte. Node isspar DEP0190 chetavni deta hai (args escape nahi hote), par yahan
       args is file me likhe hue hain, bahar se nahi aate. Chetavni PARENT process se aati
       hai, isliye wo `node --no-warnings` se chup karayi gayi hai (package.json me) — har
       run ki pehli do line kachra hone se bachane ke liye. */
    const p = spawn(step.cmd, step.args, { shell: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => {
      const secs = Math.round((Date.now() - t0) / 1000);
      /* lint ki WARNING roknay layak nahi hai (§25.2 — "lint warnings OK, errors not").
         `next lint` warning par 0 hi lautata hai, isliye exit code hi sahi pemana hai. */
      const ok = code === 0;
      console.log(`${ok ? " ok  " : " FAIL"} ${step.name.padEnd(10)} ${String(secs).padStart(3)}s`);
      resolve({ ...step, ok, out, secs });
    });
  });
}

const t0 = Date.now();
console.log("gate — build · typecheck · test · lint\n");
const results = [];
for (const step of STEPS) results.push(await run(step));
const total = Math.round((Date.now() - t0) / 1000);

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} · ${total}s`);

for (const r of bad) {
  console.log(`\n───── ${r.name}`);
  /* Sirf kaam ki line. Poora build output 200+ line ka hota hai aur usme asli error
     dhoondhna khud ek kaam ban jata hai. */
  const lines = r.out.split(/\r?\n/).filter((l) => /error|Error|✗|×|FAIL|failed/.test(l));
  console.log((lines.length ? lines.slice(0, 25) : r.out.split(/\r?\n/).slice(-25)).join("\n"));
}

process.exit(bad.length ? 1 : 0);
