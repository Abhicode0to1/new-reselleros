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

**`env -u SUPABASE_ACCESS_TOKEN` is no longer needed. Measured 28 Aug 2026.** The variable
is set NOWHERE — not in the shell, not in the Windows User env, not in Machine env — and
`npx supabase projects list` returned all three projects with no prefix at all.

> This paragraph previously read "**Every CLI command needs `env -u SUPABASE_ACCESS_TOKEN`**
> — that variable is set to a wrong value on this machine and the CLI reads it *before* the
> stored login." That was true when written. It is the third claim in this file to go stale,
> which is the point §2 makes below: **do not remember the door, try it.**

The prefix is harmless if you keep typing it, so old copy-pasted commands are not wrong —
just be clear that it treats a disease this machine no longer has.

```bash
npx supabase db query --linked "select 1"
```

If `Invalid access token format` ever appears again, check the variable FIRST — it is not a
version problem (same CLI 2.115.0 on both machines):

```powershell
[Environment]::GetEnvironmentVariable("SUPABASE_ACCESS_TOKEN","User")
```

And keep the two failures apart: that error is a bad token, while
`LegacyDbConfigLoginRoleNetworkError` is transient — **retry once** before diagnosing.

**Retry once before diagnosing.** Measured 24 Aug: `migration repair` failed with
`LegacyDbConfigLoginRoleNetworkError: failed to initialise login role: TransportError` and the
identical command succeeded on the next attempt, seconds later. It is a transient network
failure on the CLI's login-role step, not a wrong token and not a wrong command — and it looks
alarming enough to send you rewriting something that was already correct.

**Do not ask Pardeep for a token.** He is already logged in (`npx supabase login`). Asking is
the failure mode, not the fix.

### ⚠️ `Unauthorized` does not mean "no database access"

The project `.mcp.json` server declares `"${SUPABASE_ACCESS_TOKEN}"`, which does not expand
here. On 14 Aug a session read a failure like that as "I have no DB access", started guessing
at schema, and invented tables (`payroll_runs`, `quote_items`) that do not exist. **Read
`Unauthorized` as "wrong door", walk to the CLI, and keep going.**

## 2. What you may and may not run

> **Both bullets below were rewritten on 24 Aug 2026 because both had gone false.** They are
> left visible rather than quietly replaced: this file's own value depends on knowing that its
> claims decay, and a reader who has memorised the old version needs to see it change.

- **DDL through the CLI works.** The previous version said "DDL is blocked by the auto-mode
  permission classifier — `create function`, `create policy`, and any `-f` file containing
  them". Measured 24 Aug: `db query --linked -f` ran a migration containing `create table`,
  `alter table`, `create policy` and `create index` and returned exit 0, and every object was
  verified present afterwards. Whatever blocked it before does not block it now.
  **MCP is still genuinely read-only** — that half was and remains true.
- **`supabase db push` was dangerous here. As of 24 Aug 2026 the drift is 0.** The old text
  said "29 local migrations are missing from remote tracking… a push re-applies ~28
  already-applied files". That was true and it was worth obeying — on 24 Aug the drift was
  down to 5, and pushing would have run a **money data-repair migration** as a side effect of
  wanting one unrelated schema change. All five are now applied-and-tracked, and
  `migration list --linked` shows `local == remote` for every local file.
- **Do not trust the sentence above either — run the check.** It costs one command:

  ```bash
  cd production && env -u SUPABASE_ACCESS_TOKEN npx supabase migration list --linked
  ```

  Any row with a `remote` and no `local` is history (pre-Aug migrations live in
  `supabase/migrations-archive/`) and push ignores it. Any row with a `local` and no `remote`
  is what push would run. **Read that list, not this paragraph.**

- **Applying one migration without pushing all of them:**

  ```bash
  cd production && env -u SUPABASE_ACCESS_TOKEN npx supabase db query --linked -f supabase/migrations/<file>.sql
  env -u SUPABASE_ACCESS_TOKEN npx supabase migration repair --status applied <version>
  ```

  `migration repair` only writes the tracking table — it runs none of the migration's SQL. So
  **verify the objects actually exist before repairing**, or you permanently mark an unapplied
  change as applied and it can never run again. On 24 Aug two of four "already applied"
  migrations turned out genuinely unapplied; marking all four would have buried both.

## 3. Proving DB behaviour without leaving a trace — the pattern that works

> Was titled "without DDL" while §2 believed DDL was blocked. The pattern never depended on
> that, and it matters more now that DDL *does* go through: the reason to wrap a proof in
> `rollback` is that this is the production database, not that the tool would stop you.

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
[portal_customer_users_no_self_update.test.sql](../../../production/supabase/tests/portal_customer_users_no_self_update.test.sql) ·
[ai_sales_agent_tenant_isolation.test.sql](../../../production/supabase/tests/ai_sales_agent_tenant_isolation.test.sql)
(composite-FK tenant isolation, and `on delete` behaviour — the pattern for asserting that a
DELETE *succeeds*, not just that it is refused)

**Prove the harness fails before believing that it passed.** These files report success by
exiting 0, which is also what a file that silently did nothing returns. Measured 24 Aug: a
one-line file containing `raise exception` exits **1** with the message surfaced, so exit 0 is
a real pass here. Then mutate one assertion and confirm it goes red — two mutations on the
file above turned up red, which is what makes its green meaningful.

**Two rules that came out of writing these.** A superuser connection is not useless for
RLS/`auth.uid()` tests — it takes carve-outs only because it has no `auth.uid()`, and
`set_config` supplies one. And **assert on the specific error message, not on "0 rows
changed"** — a row-count assertion passes for the wrong reason when RLS refuses the row, and
keeps passing the day the trigger it was meant to guard is dropped.

## 4. Commands that have lied here

- **`npm run build` while the dev server is up wipes `.next`** — the running page then 404s
  its own chunks and looks broken. Stop the dev server first, or do not build.
- **And an INTERRUPTED build leaves a `.next` that `next dev` cannot use.** Measured 17 Sep
  2026: dev started clean, said `✓ Ready in 1.5s`, and served HTTP 500 on every route with
  `Cannot find module '../webpack-runtime.js'` in the payload. Nothing in the dev log said
  anything was wrong. `rm -rf .next` and restart — and treat "Ready" as meaning the process
  booted, never as meaning the app works.
- **`npm run lint` exits 139 with NO OUTPUT AT ALL.** Measured 17 Sep 2026, twice in a row:
  `npm run lint` → `Segmentation fault "$NODE_EXE" "$NPM_CLI_JS"`, 141 bytes of output, exit
  139 — while `npx next lint` on the same tree exits 0 with the usual 26 warnings and 0
  errors. It is npm's shell shim crashing, not a lint failure, and reading 139 as "lint
  failed" would send you hunting a defect that is not there. **Run `npx next lint` and record
  that.** If any other `npm run <x>` returns 139 with no output, suspect the same thing and
  re-run the underlying binary directly.
- **`next build` itself segfaults sometimes, and it is NOT your code.** Measured 17 Sep 2026:
  exit 139, preceded by a Rust panic from inside SWC —
  `thread 'libuv-worker' panicked at petgraph-0.6.3\srclgo\mod.rs: range start index 7184
  out of range for slice of length 1`. The identical tree built clean on the retry after
  `rm -rf .next node_modules/.cache`. Seen roughly half a dozen times across a long session,
  sometimes as exit 1 with "Cannot read properties of undefined" instead. **Retry once with
  the caches cleared before believing the build is broken** — and if it fails twice, isolate
  it by stashing the change and building at HEAD, which is how this was first pinned down
  (HEAD crashed identically).
- **⚠️ But `rm -rf node_modules/.cache` is NOT free — it throws away the `next/font` cache.**
  Measured 17 Sep 2026, immediately after doing exactly what the line above says: the retry
  failed with five errors that look like code faults —

  ```
  srcpp\layout.tsx
  `next/font` error:
  Failed to fetch `Plus Jakarta Sans` from Google Fonts.
  ```

  Nothing was wrong with the code. `next/font` downloads the faces at build time and caches
  them there, so clearing it makes the next build depend on reaching
  `fonts.googleapis.com` — and one blocked or flaky moment fails the whole build. Rebuilding
  with only `.next` cleared succeeded, 193/193.
  **So: clear `.next` first and alone. Add `node_modules/.cache` only if that was not enough,
  and if fonts then fail, check reachability (`curl -o /dev/null -w "%{http_code}"
  "https://fonts.googleapis.com/css2?family=Archivo"`) before suspecting the change.**
- **Never pipe a command whose exit code matters.** `… | tail` hid a deploy failure and the
  session reported success. Use `${PIPESTATUS[0]}`, or do not pipe.
- **The DB backup fails loudly now, but used to fail quietly** — see §5.

### Docker goes down between sessions, and the app does not say so

Three times on 16–17 Sep 2026 the Docker engine was not running at the start of a session.
The symptom is misleading: **`next dev` serves HTTP 200 and the pages render** — it is only
sign-in that hangs, forever, because auth cannot reach Postgres. `docker ps` answers
`failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`.

The fix takes about 30 seconds and needs no `supabase start` — the containers restart
themselves once the engine is up:

```powershell
Start-Process "$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe"
```

```bash
# engine up in ~10s, auth healthy ~10s after that
until docker ps >/dev/null 2>&1; do sleep 5; done
until [ "$(docker inspect --format '{{.State.Health.Status}}' supabase_auth_resellerosv3)" = healthy ]; do sleep 5; done
curl -s -o /dev/null -w "%{http_code}
" http://localhost:14321/rest/v1/     # 200 = ready
```

**Check the API port before blaming the app.** `kong=000` means the DB is down;
`kong=200` with a hanging sign-in means something else and is worth investigating properly.

### `gcloud` is NOT on this machine

Searched 17 Sep 2026: not on PATH, not in `%LOCALAPPDATA%`, not in either Program Files tree,
and no `gcloud.cmd` within four levels of `C:\`. So **`scripts/health-prod.mjs` cannot run
here**, and nothing about the Cloud Run service — its env vars, its secrets, whether
`DOMAIN_REGISTER_LIVE` is set there — can be established from this machine. Say "I cannot
check that from here" rather than inferring production config from the repo: no deploy file
in this repo sets `DOMAIN_REGISTER_LIVE` or any `RESELLERCLUB_*`, because those live in
Secret Manager.

## 5. Backups (free plan: no PITR, no automatic backups)

`cd production && npm run backup:db` → timestamped JSON in `C:/dev/resellersos-backups/`
(outside git — it contains customer PII).

It ran on the MCP server until 19 Aug 2026 and was **silently broken for six days** — the
malformed token above meant `Unauthorized`, and the parser degraded that to an empty result.
It now runs on the CLI (no token) and **throws on any unparseable response**.

Last known-good: **114 tables / 1,645 rows** (24 Aug 2026, after the AI-support-agent and
draft-feedback migrations; all 10 key tables matched live exactly). Earlier markers:
112 / 1,434 and 110 / 1,432 (24 Aug), 96 / 933 (19 Aug).

**And the script was rewritten that night, because it had stopped working.** It ran one
`npx supabase db query` PER TABLE — about 120 process launches — and after a heavy session
Windows refuses to start them: `supabase db query exited 3221225794` (0xC0000142,
STATUS_DLL_INIT_FAILED). It failed twice in a row, at DIFFERENT tables, while a single query
by hand returned exit 0. It is now three launches total: one for the table list, one
`union all` covering every table, one `jsonb_build_object` covering all seven schema reads.
If you see that exit code from anything else on this machine, suspect process count first.

Note what the table count does: it goes UP when a migration adds tables, so a jump of two is
a migration and not a bug. It is the per-table row comparison that tells you whether coverage
is intact.

If a dump comes back smaller, do not assume either way — compare per-table counts against a
live `count(*)` through a different connection. A shrinking dump and a broken dump look
identical.

**And FILE SIZE is not the check.** Measured 24 Aug: the new dump was **1.66 MB against the
22 Aug dump's 2.12 MB** — 22% smaller — while holding *more* rows. Byte size tracks whatever
large text a table happens to hold (screenshots, snapshot blobs), not coverage. The per-table
comparison settled it in one query; the size difference would have sent you hunting a
non-existent bug. On 24 Aug all 9 key tables matched live exactly.

**Diffing a backup against live is also how you prove a data migration did only what it
claimed.** After the GST repair on 24 Aug, comparing the pre-change dump's `quotes` amounts
against live showed `rows changed: 1, total delta: 8165` — which is a far stronger statement
than "exit code 0", and it is the only thing that would have caught a second row moving.

### ⚠️ And which `supabase/` FOLDER — there are two, one is not a project

`production/supabase/` is the real one: it has the `config.toml`, the baseline, the seeds,
`migrations/` (93 timestamped files, `20260816094848_…` onward) and `migrations-archive/`
(216 older `0001`-style files).

`supabase/` **at the repo root has only a `migrations/` directory and no `config.toml`**, so
it is not a Supabase project and no CLI command reads it. It holds six files, `0125`–`0130`,
last touched 4 Aug 2026 — and the archive's numbering jumps `0124` → `0131` straight over
them, which looks alarming.

**It is not alarming, checked 17 Sep 2026.** Every object those six create is present in the
local DB, and `employee_documents` and `reimbursements` are both in `baseline.sql` — which is
a snapshot of production. So they were applied before the snapshot was taken and the files
simply ended up in the wrong folder. **Do not re-run them, and do not add new migrations
there.**

## 6. Which Supabase project

`ontpnqjoysjgrlsukecm` is the real one, and `--linked` already points there — **verified
24 Aug**, do not re-link on a hunch. Open by ref, never by name.

Measured 24 Aug 2026 (`supabase projects list`) — **three** projects on the account, not the
"a second project exists" this section said until today:

| Ref | Name | Region | Status |
|---|---|---|---|
| `ontpnqjoysjgrlsukecm` | resellersos | ap-south-1 | **ACTIVE — the live one, linked** |
| `ixgvlbgmvgaihvudtbwt` | resellerosv3-staging | ap-south-1 | active — has a branch **labelled "PRODUCTION" that is not** |
| `ruaupcicjrdztabzwurx` | Google Workspace Sales Website | us-east-1 | inactive |

The trap is the middle row: its branch name says PRODUCTION and it is staging. Two of the
three are `ap-south-1`, so region does not disambiguate either. **Match the ref.**

`current_database()` is `postgres` on every Supabase project, so it cannot tell them apart.
To confirm which one you are actually on, check a fingerprint instead:

```sql
select (select count(*) from tenants) tenants, (select count(*) from quotes) quotes;
-- live on 24 Aug 2026: tenants 3, quotes 20
```

## 7. Tenants: never identify one by name

Tenant names are auto-derived from an email domain, so a wrong tenant can look like the right
one. Always check `tenant_id`. Measured 24 Aug 2026 — **three**, not the two this section
claimed until today:

| Tenant | `tenant_id` | Users | What it is |
|---|---|---|---|
| ANUTECH DIGITAL PVT LTD | `fbb976f1-9090-4f10-9726-0901bd144e42` | 10 | the live business (`distributor`) |
| Excel Technologies | `3bbd2280-b8e3-4e70-98c9-6916d85708fb` | 1 | historical, and **still holds real money** |
| Delfos Technologies | `7e57e57e-0000-4000-8000-000000000001` | 1 | `reseller` |

**Do not read "historical" as "empty".** Excel Technologies holds `Q-2026-9776` — the quote
whose missing ₹8,165 of GST was repaired on 24 Aug. A tenant nobody logs into is exactly where
a money defect survives longest, because nobody is looking at the screen it is wrong on.

**Count the tenants, do not quote this table.** It has been wrong once already:

```sql
select t.name, t.id, (select count(*) from users u where u.tenant_id = t.id) as users
from tenants t order by users desc;
```
