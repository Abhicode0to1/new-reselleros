#!/usr/bin/env node
/**
 * Gate ka build — chalte dev server ko chhuye bina.
 *
 * `next dev` aur `next build` dono `.next` likhte hain, to gate chalane ke liye kiya gaya
 * ek build dev server ka bundle mita deta hai; page apne hi chunk par 404 deta hai aur
 * "toota hua" dikhta hai. 28 Aug 2026 ko iske liye Pardeep ka chalta dev server band
 * karna pada aur baad me wapas chalu karna pada.
 *
 * Ye `NEXT_DIST_DIR=.next-check` set karke `next build` chalata hai (next.config us env
 * ko padhta hai). Docker/Cloud Build ise set NAHI karte, to prod ka raasta waisa hi hai.
 *
 * `cross-env` nahi use kiya — wo installed nahi hai, aur CLAUDE.md §17 bina zaroorat nayi
 * dependency se mana karta hai. Node khud env de sakta hai.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/* fileURLToPath, kachcha `.pathname` NAHI — is folder ke naam me space hai ("ResellerOSv3
   - Copy") aur .pathname use `%20` me badal deta hai, jisse Node module dhoondh hi nahi
   pata: MODULE_NOT_FOUND on ...ResellerOSv3%20-%20Copy... Pehli koshish isi par gir gayi. */
const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));

const child = spawn(process.execPath, [nextBin, "build"], {
  stdio: "inherit",
  env: { ...process.env, NEXT_DIST_DIR: ".next-check" },
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
