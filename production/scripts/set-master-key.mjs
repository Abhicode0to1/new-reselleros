/**
 * Generate SECRETS_MASTER_KEY and write it into .env.local.
 *
 * ─── WHY THIS IS A SCRIPT AND NOT AN INSTRUCTION ─────────────────────────────
 * Twice in this project a secret has gone wrong through copy-paste. A `CRON_SECRET`
 * rotation had its PLACEHOLDER pasted verbatim into a live service, so the app
 * expected the literal string "NAYA_SECRET" while six scheduler jobs sent the real
 * one — every cron 401'd, silently. And a generated master key was printed to a
 * terminal that then appeared in a screenshot, burning it before it was ever used.
 *
 * So this script generates the value itself, writes it straight to the file, and
 * NEVER prints it. There is no placeholder to get wrong and nothing on screen to
 * capture.
 *
 * ─── WHAT THE KEY IS FOR ─────────────────────────────────────────────────────
 * `lib/crypto/vault.ts` wraps each stored credential in an AES-256-GCM envelope
 * keyed by this value. Without it, `sealTenantSecrets` stores credentials in
 * PLAINTEXT — which is the state this workspace is in right now, with a live
 * Razorpay key_secret, a live Razorpay webhook_secret and a Gemini API key sitting
 * unencrypted in `tenant_secrets`.
 *
 * ─── THE ORDER THAT MATTERS ──────────────────────────────────────────────────
 * `decryptTenantSecrets` THROWS when a value is an envelope but the key is absent
 * (vault.ts:138) — deliberately, because silently returning null would hide a
 * broken integration. So the key must be present EVERYWHERE the app runs before
 * anything is sealed. Set it locally (this script) AND on Cloud Run, and only then
 * re-save the integrations. Sealing with a key the live service lacks would break
 * Razorpay checkout and email triage in production.
 *
 * Usage, from the `production` folder:
 *
 *   node scripts/set-master-key.mjs
 *
 * Refuses to overwrite an existing key: losing the old one makes every already
 * sealed secret permanently unreadable, and there is no recovery.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";

const ENV_FILE = ".env.local";
const VAR = "SECRETS_MASTER_KEY";

if (!existsSync(ENV_FILE)) {
  console.error(`${ENV_FILE} not found. Run this from the "production" folder:`);
  console.error(`  cd "C:/dev/ResellerOSv3 - Copy/production"`);
  process.exit(2);
}

const original = readFileSync(ENV_FILE, "utf8");

// An existing key must never be replaced by accident. Every secret already
// sealed with it becomes unreadable the moment it changes.
const existing = original
  .split(/\r?\n/)
  .find((l) => l.startsWith(`${VAR}=`) && l.slice(VAR.length + 1).trim().length > 0);

if (existing) {
  console.log(`${VAR} is already set in ${ENV_FILE}. Nothing changed.`);
  console.log("");
  console.log("Replacing it would make every secret already sealed with the old key");
  console.log("permanently unreadable. If you genuinely need to rotate, that is a");
  console.log("separate job: decrypt with the old key first, then re-seal with the new one.");
  process.exit(0);
}

// 32 bytes, base64 — the format masterKey() expects (vault.ts:65).
const key = randomBytes(32).toString("base64");

// Keep a timestamped copy of the file before touching it. Cheap, and .env.local
// is not in git, so there is no other way back.
const backup = `${ENV_FILE}.bak-${Date.now()}`;
copyFileSync(ENV_FILE, backup);

const needsNewline = original.length > 0 && !original.endsWith("\n");
writeFileSync(
  ENV_FILE,
  `${original}${needsNewline ? "\n" : ""}\n# Envelope-encryption master key for tenant_secrets (AES-256-GCM).\n`
    + `# KEEP AN OFFLINE COPY. Lose this and every sealed secret is unrecoverable.\n`
    + `${VAR}=${key}\n`,
  "utf8",
);

console.log(`Done. ${VAR} written to ${ENV_FILE} (32 bytes, base64).`);
console.log(`Previous file saved as ${backup}`);
console.log("");
console.log("The value was NOT printed here on purpose — a terminal ends up in screenshots.");
console.log("");
console.log("NEXT, in this order. Doing 3 before 2 breaks production:");
console.log("");
console.log("  1. Open .env.local in an editor, copy the SECRETS_MASTER_KEY value into");
console.log("     your password manager. There is no recovery if it is lost.");
console.log("");
console.log("  2. Set the SAME value on Cloud Run:");
console.log("       gcloud run services update resellersos --region=asia-south1 \\");
console.log("         --update-env-vars \"SECRETS_MASTER_KEY=<paste the value from the file>\"");
console.log("");
console.log("  3. ONLY THEN re-save the integrations so the plaintext credentials get");
console.log("     sealed: Settings -> Integrations -> Razorpay -> Save, then Gemini -> Save.");
console.log("     Watch the server log: \"stored in PLAINTEXT\" must NOT appear.");
