/**
 * Read `.env.local` the way dotenv does — one implementation for every script.
 *
 * ─── THE BUG THIS ENDS ──────────────────────────────────────────────────────
 * Eight scripts in this directory each carried their own copy of:
 *
 *     env[key] = value.trim().replace(/^["']|["']$/g, "")
 *
 * which strips ONE quote from each end of the LINE. A quoted value followed by
 * a comment therefore kept the comment:
 *
 *     SUPABASE_SERVICE_ROLE_KEY="ey…"  # LOCAL demo key — same on every local supabase
 *
 * parsed as 217 characters of JWT plus that sentence. Sent as an HTTP header,
 * Node refuses it:
 *
 *     TypeError: Cannot convert argument to a ByteString because the character
 *     at index 191 has a value of 8212
 *
 * 8212 is the em dash in the comment. The message names a character offset and
 * no file, so it reads as a corrupt service-role key — which sends you rotating
 * a key that was never wrong. Through `supabase.auth.admin` it surfaced instead
 * as `AuthRetryableFetchError` with `status: 0`, i.e. indistinguishable from the
 * local stack being down.
 *
 * ─── THE RULES, WHICH ARE DOTENV'S ──────────────────────────────────────────
 *   · a quoted value ends at its CLOSING quote; anything after it is a comment
 *   · an unquoted value ends at whitespace followed by `#` — the space is
 *     required, so a `#` inside an unquoted value survives (passwords use them)
 *   · `=` inside a value is kept: the key ends at the FIRST `=`
 *   · `export FOO=bar` is accepted, because .env files are often sourced
 *   · blank lines and `#` comment lines are skipped
 */
import { readFileSync } from "node:fs";

/** Parse the text of a .env file. Exported separately so it is testable. */
export function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;

    let key = trimmed.slice(0, idx).trim();
    if (key.startsWith("export ")) key = key.slice(7).trim();
    if (!key) continue;

    const raw = trimmed.slice(idx + 1).trim();

    /* A quoted value ends at its closing quote. `[^"]*` and not `.*` on
       purpose: greedy would run to the last quote on the line, swallowing a
       quoted word in the trailing comment. */
    const quoted = raw.match(/^"([^"]*)"/) ?? raw.match(/^'([^']*)'/);
    out[key] = quoted ? quoted[1] : raw.replace(/\s+#.*$/, "");
  }
  return out;
}

/**
 * Read and parse `.env.local` from the current working directory.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.require] keys that must be present and non-empty.
 *   Missing ones are reported together, by NAME, and the process exits 1 —
 *   one message naming what to add beats a stack trace from the first `undefined`
 *   to reach an SDK.
 * @param {string} [opts.path] defaults to ".env.local"
 */
export function loadEnvLocal(opts = {}) {
  const path = opts.path ?? ".env.local";
  let text;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    console.error(`❌ Could not read ${path} — run this from the production/ directory.`);
    process.exit(1);
  }

  const env = parseEnv(text);

  const missing = (opts.require ?? []).filter((k) => !env[k]?.trim());
  if (missing.length) {
    console.error(`❌ ${path} is missing: ${missing.join(", ")}`);
    process.exit(1);
  }
  return env;
}
