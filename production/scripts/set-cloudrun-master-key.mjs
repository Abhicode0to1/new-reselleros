/**
 * Push SECRETS_MASTER_KEY from .env.local to the Cloud Run service.
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The same mistake has now happened twice in this project, both times through
 * copy-paste of a secret:
 *
 *   1. A CRON_SECRET rotation had its PLACEHOLDER pasted verbatim into
 *      `gcloud run services update`, so the live service expected the literal
 *      string "NAYA_SECRET" while six scheduler jobs sent the real one. Every cron
 *      401'd, silently, until someone noticed a missed renewal.
 *   2. A freshly generated master key was printed to a terminal, and that terminal
 *      appeared in a screenshot — burning the key before it was ever used.
 *
 * So the value is read from `.env.local` and never printed. There is no
 * placeholder to get wrong.
 *
 * ─── CORRECTION, FOUND WHEN THIS FIRST RAN ───────────────────────────────────
 * An earlier version of this comment claimed the value "never reaches a shell
 * string, so it does not reach shell history". Node itself proved that wrong on
 * the first real run:
 *
 *   DEP0190: Passing args to a child process with shell option true can lead to
 *   security vulnerabilities, as the arguments are not escaped, only concatenated.
 *
 * With `shell: true` the argv array IS concatenated into a command string, so the
 * value does pass through the shell. `shell: true` is unavoidable on Windows,
 * where `gcloud` is a `.cmd` wrapper.
 *
 * What that does and does not mean, stated honestly:
 *   • No injection risk. base64 is [A-Za-z0-9+/=] — none of those are shell
 *     metacharacters, so a key cannot break out of the command.
 *   • It is NOT written to shell history here: this runs non-interactively, and
 *     non-interactive shells do not append to history.
 *   • It IS briefly visible in a process listing (Task Manager, `ps`) while gcloud
 *     runs. On a personal machine that is a small window; on a shared or
 *     multi-user box it is a real exposure.
 *
 * THE PROPER FIX, when this matters more: keep the key in Google Secret Manager
 * and have Cloud Run reference it (`--set-secrets`), so the value never appears in
 * any command line at all. Not done here because it is a different setup task with
 * its own IAM, and shipping a half-configured secret reference would be worse than
 * this.
 *
 * Written in Node rather than bash because this machine drives cmd.exe, and an
 * earlier bash-only instruction (`VAR=1 ./script.sh`) simply failed there. `node`
 * behaves identically in cmd.exe, PowerShell and Git Bash.
 *
 * ─── THE ORDER THIS ENFORCES ─────────────────────────────────────────────────
 * `decryptTenantSecrets` THROWS when a stored value is an envelope but the key is
 * absent (lib/crypto/vault.ts) — deliberately, since returning null would hide a
 * broken integration. So the key must reach Cloud Run BEFORE anything is sealed.
 * Sealing first would break Razorpay checkout and inbound email triage in
 * production. This script is that "before".
 *
 * Usage, from the `production` folder:
 *
 *   node scripts/set-cloudrun-master-key.mjs
 *
 * Add --dry-run to see exactly what would be executed, with the value masked.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { loadEnvLocal } from "./lib/env-local.mjs";

const REGION = process.env.REGION ?? "asia-south1";
const SERVICE = process.env.SERVICE ?? "resellersos";
const VAR = "SECRETS_MASTER_KEY";
const DRY = process.argv.includes("--dry-run");

if (!existsSync(".env.local")) {
  console.error('.env.local not found. Run this from the "production" folder:');
  console.error('  cd "C:/dev/ResellerOSv3 - Copy/production"');
  process.exit(2);
}

/* Through the shared parser, not `line.slice(VAR.length + 1)`. That kept the
   surrounding quotes AND any trailing comment, and this value is pushed to
   Cloud Run as a production secret. The 32-byte check below would have refused
   it — but its message ("decodes to N bytes … Regenerate") sends you to replace
   a key that was never wrong, which is the same wrong turn the service-role key
   sent people on. See scripts/lib/env-local.mjs. */
const value = (loadEnvLocal()[VAR] ?? "").trim();

if (!value) {
  console.error(`${VAR} is not set in .env.local.`);
  console.error("Generate it first:  node scripts/set-master-key.mjs");
  process.exit(2);
}

// Validate before touching production. A key of the wrong length would be
// accepted by gcloud and then rejected by vault.ts at runtime, which is a much
// more confusing place to find out.
let decoded;
try {
  decoded = Buffer.from(value, "base64");
} catch {
  console.error(`${VAR} in .env.local is not valid base64.`);
  process.exit(1);
}
if (decoded.length !== 32) {
  console.error(`${VAR} decodes to ${decoded.length} bytes; AES-256 needs exactly 32.`);
  console.error("Do NOT push this. Regenerate with: node scripts/set-master-key.mjs");
  process.exit(1);
}

console.log(`Key read from .env.local: valid base64, 32 bytes. Value not shown.`);
console.log(`Target: service "${SERVICE}" in ${REGION}`);
console.log("");

const args = [
  "run", "services", "update", SERVICE,
  `--region=${REGION}`,
  "--update-env-vars", `${VAR}=${value}`,
  "--quiet",
];

if (DRY) {
  console.log("Dry run. Would execute:");
  console.log(`  gcloud ${args.map((a) => (a.startsWith(`${VAR}=`) ? `${VAR}=<32-byte key, masked>` : a)).join(" ")}`);
  process.exit(0);
}

// shell: true is required on Windows, where gcloud is a .cmd wrapper. Node warns
// (DEP0190) that this concatenates args into a command string rather than passing
// them separately — see the CORRECTION block at the top of this file for what that
// does and does not expose. Kept because there is no portable alternative here, and
// documented rather than glossed over.
const res = spawnSync("gcloud", args, { encoding: "utf8", shell: true });

const scrub = (s) => (s ?? "").split(value).join("<masked>");
const out = scrub(res.stdout) + scrub(res.stderr);

// Only the lines that say what happened. Filtered so that a future gcloud version
// echoing env vars cannot leak the value into a terminal that ends up screenshotted.
for (const l of out.split(/\r?\n/)) {
  if (/revision|Deploying|Done|ERROR|WARNING|serving/i.test(l)) console.log(l.trim());
}

if (res.status !== 0) {
  console.error("");
  console.error(`gcloud exited ${res.status}. The key was NOT applied.`);
  console.error("If it says you are not authenticated:  gcloud auth login");
  process.exit(res.status ?? 1);
}

console.log("");
console.log("Applied. NOW, and only now, seal the plaintext credentials:");
console.log("  Settings -> Integrations -> Razorpay -> Save");
console.log("  Settings -> Integrations -> Gemini   -> Save");
console.log("");
console.log('Then check the server log: "stored in PLAINTEXT" must NOT appear.');
console.log("If it does, the key did not reach the running revision — re-run this script.");
