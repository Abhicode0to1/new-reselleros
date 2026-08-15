/**
 * Put a Supabase personal access token into ~/.claude.json so the Supabase MCP server
 * (and the ops scripts in this folder) can reach the Management API.
 *
 * WHY THIS EXISTS RATHER THAN "just paste it into the command":
 * On 15 Aug the env var SUPABASE_ACCESS_TOKEN was found holding
 *     sbp_yahan_apna_token_paste_karo sbp_53e8413a…
 * — a placeholder with the real token stuck onto the END of it, because a previous
 * instruction had put a placeholder inside a copy-pasteable command. The CLI then
 * refused every request with "Invalid access token format", and it took three rounds
 * to find. So: this script ASKS for the token in your own terminal. The token never
 * appears in a command line, in shell history, or in a chat message.
 *
 *   node scripts/set-supabase-token.mjs
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

const CONFIG = (process.env.USERPROFILE || process.env.HOME) + "/.claude.json";

if (!existsSync(CONFIG)) {
  console.error(`Config not found: ${CONFIG}`);
  process.exit(2);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

const token = (await ask("Paste your Supabase access token (starts with sbp_): ")).trim();
rl.close();

if (!token.startsWith("sbp_")) {
  console.error(`\nThat does not look like an access token — it must start with "sbp_".`);
  console.error(`Get one at: https://supabase.com/dashboard/account/tokens`);
  process.exit(1);
}
/* Catch the exact failure that motivated this script: a token pasted after a
   placeholder, so the string contains "sbp_" twice. */
if (token.split("sbp_").length > 2) {
  console.error(`\nThat string contains "sbp_" more than once — it looks like two tokens`);
  console.error(`stuck together. Copy ONLY the token, nothing before or after it.`);
  process.exit(1);
}
if (/\s/.test(token)) {
  console.error(`\nThe token contains a space. Copy it again without any surrounding text.`);
  process.exit(1);
}

// Verify it actually works BEFORE writing it. A token that is saved but rejected is
// the worst outcome — everything then fails somewhere else, far from the cause.
process.stdout.write("\nChecking the token against the Supabase API… ");
const res = await fetch("https://api.supabase.com/v1/projects", {
  headers: { Authorization: `Bearer ${token}` },
});
if (!res.ok) {
  console.error(`REJECTED (HTTP ${res.status}).`);
  console.error(`Nothing was written. Generate a fresh token and try again.`);
  process.exit(1);
}
const projects = await res.json();
console.log(`OK — it can see ${projects.length} project(s).`);

const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
const entry = Object.entries(cfg.mcpServers || {}).find(([k]) => /supabase/i.test(k));
if (!entry) {
  console.error(`No Supabase MCP server found in ${CONFIG}. Nothing changed.`);
  process.exit(1);
}

// Back up first — this file holds every MCP server config; a bad write breaks the app.
copyFileSync(CONFIG, CONFIG + ".bak");

let updated = 0;
for (const [name, server] of Object.entries(cfg.mcpServers)) {
  if (!/supabase/i.test(name)) continue;
  server.env = server.env || {};
  server.env.SUPABASE_ACCESS_TOKEN = token;
  updated++;
}
writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));

console.log(`Updated ${updated} Supabase MCP server entry/entries.`);
console.log(`Backup saved as ${CONFIG}.bak`);
console.log(`\nNow restart Claude Code so it picks up the new token.`);
