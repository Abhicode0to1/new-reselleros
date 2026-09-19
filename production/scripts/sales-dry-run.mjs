#!/usr/bin/env node
/**
 * Sukha chalan — AI se poochho ki wo KYA likhta, bina kuch bheje.
 *
 *   npm run dry-run -- "mujhe 70 email id ka quote chahiye google workspace business starter"
 *   npm run dry-run -- "Quote required" --body "mujhe 25 email id chahiye starter ke liye"
 *   npm run dry-run -- "..." --seats 40
 *
 * Kuch banata nahi: koi lead, koi quote, koi invoice number, koi email. Database sirf
 * padha jata hai — catalogue aur Gemini ki chaabi ke liye. Poora vivaran aur wajah
 * src/lib/ai/sales-dry-run.test.ts me.
 *
 * Ye wrapper sirf isliye hai ki `.env.local` khud load ho jaye — vitest use nahi padhta,
 * aur bina uske har baar chaar env var haath se dene padte.
 */
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadEnvLocal } from "./lib/env-local.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
/* Pehla bina-flag wala hissa subject hai. */
const subject = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));

if (!subject) {
  console.error(`
Kya likhna hai, wo dijiye:

  npm run dry-run -- "mujhe 70 email id ka quote chahiye google workspace business starter"

  --body  "..."   email ka matn (na dein to khaali — jaisa asli test mail me tha)
  --seats 40      lead par kitni seats maani jayein (default 70)
`);
  process.exit(2);
}

/* .env.local - vitest ise khud nahi padhta. Sirf padha jata hai, likha nahi.
   Saajha parser se, apne haath ke regex se nahi: wo har line ke SIRE se quote
   hatata tha, to quote waali value ke baad ka comment andar hi reh jata. Yahan
   wo sirf EK chaabi par lagta tha, aur theek sabse buri chaabi par --
   SUPABASE_SERVICE_ROLE_KEY 164 ki jagah 214 akshar ka ban jata (JWT + comment),
   jise Supabase ByteString kehkar thukra deta. 16 Sep 2026 ko naapa gaya.
   Path script ke hisaab se, cwd ke hisaab se nahi - ye kahin se bhi chalta hai. */
const env = {
  ...process.env,
  ...loadEnvLocal({ path: fileURLToPath(new URL("../.env.local", import.meta.url)) }),
};

env.DRY_RUN = "1";
env.DRY_SUBJECT = subject;
env.DRY_BODY = flag("body") ?? "";
if (flag("seats")) env.DRY_SEATS = flag("seats");

try {
  execSync("npx vitest run src/lib/ai/sales-dry-run.test.ts", { stdio: "inherit", env });
} catch {
  /* vitest ne apna nateeja pehle hi chhaap diya hai; yahan dobara stack chhapna
     use dhak deta. Exit code aage badha dete hain. */
  process.exit(1);
}
