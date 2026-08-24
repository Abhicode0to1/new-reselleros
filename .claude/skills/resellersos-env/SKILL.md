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
- **Never pipe a command whose exit code matters.** `… | tail` hid a deploy failure and the
  session reported success. Use `${PIPESTATUS[0]}`, or do not pipe.
- **The DB backup fails loudly now, but used to fail quietly** — see §5.

## 5. Backups (free plan: no PITR, no automatic backups)

`cd production && npm run backup:db` → timestamped JSON in `C:/dev/resellersos-backups/`
(outside git — it contains customer PII).

It ran on the MCP server until 19 Aug 2026 and was **silently broken for six days** — the
malformed token above meant `Unauthorized`, and the parser degraded that to an empty result.
It now runs on the CLI (no token) and **throws on any unparseable response**.

Last known-good: **110 tables / 1,432 rows** (24 Aug 2026, before the AI-sales-agent
migration). Previous marker was 96 / 933 (19 Aug).

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
