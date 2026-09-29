#!/usr/bin/env node
/**
 * Generated DB types current hain? — regenerate + diff (S21, 28 Sep 2026).
 *
 *   node scripts/check-db-types.mjs            check: exit 1 agar database.generated.ts purana hai
 *   node scripts/check-db-types.mjs --write    likh do (migration ke baad yahi chalao)
 *   node scripts/check-db-types.mjs --keep     throwaway DB mat giraao (debug ke liye)
 *
 * Kya karta hai: LOCAL supabase docker me ek THROWAWAY database (`types_check_<pid>`) banata
 * hai, usme baseline.sql + baseline-storage.sql + supabase/migrations/* (order me) chalata hai,
 * phir usi stack ke postgres-meta container se `gen types typescript` nikalta hai aur
 * src/lib/supabase/database.generated.ts se milata hai. Aakhir me DB drop — hamesha.
 *
 * Kyun alag DB, shared `postgres` nahi: local `postgres` DB baaki sessions / agents bhi use
 * karte hain; usme migrations chalana unka data aur schema badal deta. Yahan sirf ek READ hota
 * hai us DB par — `pg_dump -s -n auth -n storage`, taaki auth.users / storage.* naye DB me bhi
 * hon (baseline unhe reference karta hai).
 *
 * Kyun `supabase gen types --db-url` nahi: CLI apna postgres-meta image `docker run` se khinchta
 * hai (network + version drift). Yahan jo stack chal raha hai (`supabase start`), usi ka
 * `supabase_pg_meta_<project_id>` container use hota hai — wahi generator jo CLI ke andar hai.
 * `--linked` / `--project-id` KABHI nahi: wo remote (production) ko padhte hain.
 *
 * Docker chahiye, isliye CI me wired NAHI hai (CI me supabase stack nahi chalta). Gate:
 * migration likhne wala `--write` chalaye aur generated file usi commit me daale.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src", "lib", "supabase", "database.generated.ts");
const WRITE = process.argv.includes("--write");
const KEEP = process.argv.includes("--keep");

const projectId = /^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync(join(ROOT, "supabase", "config.toml"), "utf8"))?.[1];
if (!projectId) fail("supabase/config.toml se project_id nahi mila");
const DB_C = `supabase_db_${projectId}`;
const META_C = `supabase_pg_meta_${projectId}`;
const DB = `types_check_${process.pid}`;
if (/^(postgres|template[01]|_supabase)$/.test(DB)) fail(`refusing to touch ${DB}`);

function fail(msg) {
  console.error(`[check-db-types] ${msg}`);
  process.exit(2);
}
function docker(args, input) {
  return execFileSync("docker", args, { encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
}
const psql = (user, db, extra, input) =>
  docker(["exec", "-i", DB_C, "psql", "-X", "-q", "-U", user, "-d", db, "-v", "ON_ERROR_STOP=1", ...extra], input);

try {
  docker(["inspect", "-f", "{{.State.Running}}", DB_C]);
  docker(["inspect", "-f", "{{.State.Running}}", META_C]);
} catch {
  fail(`local supabase stack nahi chal raha (${DB_C} / ${META_C}). \`npx supabase start\` karke dobara chalao.`);
}

let created = false;
try {
  psql("supabase_admin", "postgres", ["-c", `create database ${DB} owner postgres`]);
  created = true;
  psql("supabase_admin", DB, ["-c", [
    "create schema if not exists extensions",
    'create extension if not exists "uuid-ossp" schema extensions',
    "create extension if not exists pgcrypto schema extensions",
    "create extension if not exists pg_stat_statements schema extensions",
    "create extension if not exists supabase_vault cascade",
    "create extension if not exists pg_net schema extensions",
    "grant usage on schema extensions to anon, authenticated, service_role",
  ].join("; ")]);

  // auth + storage schema (READ-only dump of the shared DB). Storage ki policies
  // public.current_tenant_id() maangti hain jo abhi nahi bana — wo errors expected hain;
  // baseline-storage.sql unhe dobara banata hai.
  const authStorage = docker(["exec", DB_C, "pg_dump", "-U", "supabase_admin", "-d", "postgres", "-s", "-n", "auth", "-n", "storage"]);
  try { docker(["exec", "-i", DB_C, "psql", "-X", "-q", "-U", "supabase_admin", "-d", DB], authStorage); } catch { /* see above */ }

  for (const f of ["baseline.sql", "baseline-storage.sql"]) {
    psql("supabase_admin", DB, ["-f", "-"], readFileSync(join(ROOT, "supabase", f), "utf8"));
  }
  const migDir = join(ROOT, "supabase", "migrations");
  const files = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    try {
      psql("postgres", DB, ["-f", "-"], readFileSync(join(migDir, f), "utf8"));
    } catch (e) {
      throw new Error(`migration ${f} failed on a fresh baseline:\n${String(e.stderr ?? e.message).slice(0, 800)}`);
    }
  }
  console.log(`[check-db-types] ${DB}: baseline + ${files.length} migrations applied`);

  const generated = docker([
    "exec",
    "-e", `PG_META_DB_URL=postgresql://postgres:postgres@${DB_C}:5432/${DB}`,
    "-e", "PG_META_GENERATE_TYPES=typescript",
    "-e", "PG_META_GENERATE_TYPES_INCLUDED_SCHEMAS=public",
    "-e", "PG_META_GENERATE_TYPES_DETECT_ONE_TO_ONE_RELATIONSHIPS=true",
    META_C, "node", "dist/server/server.js",
  ]);
  if (!/export type Database = \{/.test(generated)) throw new Error(`generator output unexpected:\n${generated.slice(0, 400)}`);

  const norm = (s) => s.replace(/\r\n/g, "\n");
  const current = existsSync(OUT) ? norm(readFileSync(OUT, "utf8")) : "";
  if (norm(generated) === current) {
    console.log("[check-db-types] database.generated.ts is current ✔");
  } else if (WRITE) {
    writeFileSync(OUT, norm(generated));
    console.log(`[check-db-types] wrote ${OUT} — ab \`npx tsc --noEmit\` chalao; overlay (database.types.ts) ki OverlayCheck batayegi agar koi patch purana pad gaya.`);
  } else {
    const a = current.split("\n"), b = norm(generated).split("\n");
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    console.error(`[check-db-types] database.generated.ts is STALE (first difference at line ${i + 1}):`);
    console.error(`  committed: ${a[i] ?? "<eof>"}`);
    console.error(`  generated: ${b[i] ?? "<eof>"}`);
    console.error("  Fix: node scripts/check-db-types.mjs --write, then commit the file.");
    process.exitCode = 1;
  }
} catch (e) {
  console.error(`[check-db-types] ${e.message}`);
  process.exitCode = 2;
} finally {
  if (created && !KEEP) {
    try {
      psql("supabase_admin", "postgres", ["-c", `drop database if exists ${DB} with (force)`]);
    } catch (e) {
      console.error(`[check-db-types] could not drop ${DB} — drop it by hand: ${e.message}`);
    }
  } else if (created) {
    console.log(`[check-db-types] --keep: ${DB} left in place`);
  }
}
