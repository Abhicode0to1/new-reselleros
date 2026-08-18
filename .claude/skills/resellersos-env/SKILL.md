---
name: resellersos-env
description: How to actually reach this project's database, deploy, and prove a change on THIS machine — the access paths that work, the ones that look like they work and do not, and the commands that have silently lied here before. Load this before running any Supabase command (`supabase db query`, `db push`, `migration repair`), before running a build or dev server, before deploying to Cloud Run, and before concluding "there is no data" or "I have no DB access" from a failed call. Not about code patterns — for multi-tenant/pricing/RLS conventions read production/CLAUDE.md, which loads on its own.
---

# ResellerOS — working environment

Everything here was **measured on this machine**, and most of it exists because a session
already got it wrong once. Full write-up: [docs/WORKING-ENVIRONMENT.md](../../../docs/WORKING-ENVIRONMENT.md).

**This file is about ACCESS, not about code.** Multi-tenant rules, the 2-tier pricing model,
commitments, RLS conventions, Indian-market formatting → `production/CLAUDE.md` (42KB, loads
automatically). Do not duplicate them here; a second copy is a second thing to go stale.

---

## 1. Supabase: two doors, and one of them is painted on

| Door | Works? | Use it for |
|---|---|---|
| `npx supabase db query --linked` (CLI) | ✅ reads **and** DML | anything that writes, and rollback-style proofs |
| MCP `supabase-db` (user-scoped) | ✅ but **read-only** | quick reads, schema, `pg_policies` |
| MCP `supabase` (project `.mcp.json`) | ❌ **always `Unauthorized`** | nothing — see below |

**Every CLI command needs `env -u SUPABASE_ACCESS_TOKEN`.** That variable is set to a wrong
value on this machine and the CLI reads it *before* the stored login:

```bash
env -u SUPABASE_ACCESS_TOKEN npx supabase db query --linked "select 1"
```

Without it: `Invalid access token format`. This is **not** a version problem — same CLI
2.115.0 on both machines. It can also break mid-session, so if a command that worked earlier
starts failing, try `env -u` first before theorising.

**Do not ask Pardeep for a token.** He is already logged in (`npx supabase login`). Asking is
the failure mode, not the fix.

### ⚠️ `Unauthorized` does not mean "no database access"

The project `.mcp.json` server declares `"${SUPABASE_ACCESS_TOKEN}"`, which does not expand
here. On 14 Aug a session read a failure like that as "I have no DB access", started guessing
at schema, and invented tables (`payroll_runs`, `quote_items`) that do not exist. **Read
`Unauthorized` as "wrong door", walk to the CLI, and keep going.**

## 2. What you may and may not run

- **DDL is blocked by the auto-mode permission classifier** — `create function`, `create
  policy`, and any `-f` file containing them. One attempt, then ask; do not go around it via
  another tool. (MCP is genuinely read-only, so that is not a way around either.)
- **`supabase db push` is dangerous in this repo.** 29 local migrations are missing from
  remote tracking while their objects already exist in the DB — tracking drift, not missing
  changes. A push re-applies ~28 already-applied files. `supabase migration repair` is the
  right tool, and it is a decision, not a reflex.

## 3. Proving DB behaviour without DDL — the pattern that works

DDL is transactional in Postgres and `db query -f` honours transaction boundaries, so a test
file can build a scenario, assert against it, and `rollback` — **safe on production**.

```
begin;
  -- synthetic rows in a synthetic tenant
  set local role authenticated;                       -- so RLS is actually enforced
  perform set_config('request.jwt.claims',
    json_build_object('sub', <uuid>, 'role','authenticated')::text, true);  -- becomes auth.uid()
  -- assertions: raise exception on FAIL
rollback;
```

Worked examples:
[users_privileged_columns_owner_only.test.sql](../../../production/supabase/tests/users_privileged_columns_owner_only.test.sql) ·
[portal_customer_users_no_self_update.test.sql](../../../production/supabase/tests/portal_customer_users_no_self_update.test.sql)

**Two rules that came out of writing these.** A superuser connection is not useless for
RLS/`auth.uid()` tests — it takes carve-outs only because it has no `auth.uid()`, and
`set_config` supplies one. And **assert on the specific error message, not on "0 rows
changed"** — a row-count assertion passes for the wrong reason when RLS refuses the row, and
keeps passing the day the trigger it was meant to guard is dropped.

## 4. Commands that have lied here

- **`npm run build` while the dev server is up wipes `.next`** — the running page then 404s
  its own chunks and looks broken. Stop the dev server first, or do not build.
- **Never pipe a command whose exit code matters.** `… | tail` hid a deploy failure and the
  session reported success. Use `${PIPESTATUS[0]}`, or do not pipe.
- **The DB backup fails loudly now, but used to fail quietly** — see §5.

## 5. Backups (free plan: no PITR, no automatic backups)

`cd production && npm run backup:db` → timestamped JSON in `C:/dev/resellersos-backups/`
(outside git — it contains customer PII).

It ran on the MCP server until 19 Aug 2026 and was **silently broken for six days** — the
malformed token above meant `Unauthorized`, and the parser degraded that to an empty result.
It now runs on the CLI (no token) and **throws on any unparseable response**.

Last known-good: **96 tables / 933 rows** (19 Aug 2026). If a dump comes back smaller, do not
assume either way — compare per-table counts against a live `count(*)` through a different
connection. A shrinking dump and a broken dump look identical.

## 6. Which Supabase project

`ontpnqjoysjgrlsukecm` is the real one (`--linked` already points there). A second project
exists whose **branch is labelled "PRODUCTION" and is not** — open by ref, never by name.

## 7. Tenants: never identify one by name

Tenant names are auto-derived from an email domain, so a wrong tenant can look like the right
one. Two exist: **ANUTECH DIGITAL PVT LTD** (10 users, the live business) and **Excel
Technologies** (1 user, historical). Always check `tenant_id`.
