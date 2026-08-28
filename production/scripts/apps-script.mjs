#!/usr/bin/env node
/**
 * Apps Script padhne ka command. Likhna jaan-boojhkar yahan NAHI hai.
 *
 *   npm run apps-script:list          # saari script aur unki ID
 *   npm run apps-script:read <id>     # us script ka poora code
 *
 * Likhne ka function `apps-script-lib.mjs` me hai (`writeScript`) aur wo ek session ke
 * andar se hi bulaya jata hai — kyunki likhne se pehle padhna, sochna aur wapas padh kar
 * jaanchna chahiye. Ek `npm run ... --write` banane ka matlab hota ek galat paste ek
 * command ki doori par. 28 Aug ko secret rotate karte waqt yahi kram chala:
 * padho → badlo → likho → wapas padh kar mel jaancho.
 */
import { token, readScript } from "./apps-script-lib.mjs";

const [cmd, arg] = process.argv.slice(2);

if (cmd === "read" && arg) {
  const c = await readScript(await token(), arg);
  for (const f of c.files) {
    /* API `type` ko BADE akshar me lautata hai (SERVER_JS); Drive ka export chhote me. */
    const t = String(f.type).toLowerCase();
    console.log(`
──────── ${f.name}.${t === "server_js" ? "gs" : t} ────────`);
    console.log(f.source);
  }
} else {
  console.log(`
Apps Script ki ID Drive se milti hai (mimeType = application/vnd.google-apps.script).
28 Aug 2026 tak do thi:

  Lead Capture               1UV7RZ8oNkz1kxgUBbdtRDC73pCJg7mv4sFnlVedSGEXNlq0Pb19Bs5y4
  Amazon purchase forwarder  1SLqhJs-jvdse-S_hJEIK6pbxu4hZDwHhrdRYSENpY0q-IWN9RABJPkp8

  npm run apps-script:read 1UV7RZ8oNkz1kxgUBbdtRDC73pCJg7mv4sFnlVedSGEXNlq0Pb19Bs5y4
`);
  process.exit(cmd ? 1 : 0);
}
