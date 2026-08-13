# Backups — how they work, and what they don't cover

_Set up 2026-08-13, after the Supabase dashboard was found showing **`LAST BACKUP: No backups`** on a database holding ₹57L of invoices and ₹52L of payments._

---

## The situation

The project is on the Supabase **free plan**, which has **no automatic backups and no PITR**.

There was already an in-app snapshot feature (`/settings/backup`, migrations `0210`–`0212`), and its own migration header is honest about why it exists: *"the free Supabase plan has no automatic backups / PITR"*. But those snapshots are written to `backup.snapshots` — **a table inside the same database**.

| Protects against | In-app snapshot | This backup |
|---|---|---|
| A bad UPDATE / accidental delete | ✅ yes | ✅ yes |
| Losing the database itself (project deleted, account/billing issue, region failure) | ❌ **no** — the snapshot goes with it | ✅ yes |

**A copy stored inside the thing it is backing up is an undo button, not a backup.** Both are worth having; only one survives losing the database.

---

## Taking a backup

```bash
cd production && npm run backup:db
```

Writes a timestamped JSON to **`C:/dev/resellersos-backups/`** — deliberately **outside the git repo**, because the dump contains customer PII (names, emails, phones, GSTINs) and must never be committed.

Requires `SUPABASE_ACCESS_TOKEN` in the environment. It is already set in the gitignored `.claude/settings.local.json`; for a terminal outside Claude Code, export it or use `setx`.

It runs through the **read-only** MCP server (`.mcp.json`), so a backup run can never write to production.

### What a run captures (verified 2026-08-13)

| | |
|---|---|
| Tables | 80 |
| Rows | 1,210 |
| Columns | 1,238 |
| RLS policies | 253 |
| Functions | 126 (full `pg_get_functiondef` source) |
| Triggers | 46 (full `pg_get_triggerdef`) |
| Indexes | 275 |
| Applied-migration ledger | 247 records |
| File size | ~1.4 MB |

Schema definitions are captured **live from the database, not from git**, and that is deliberate — see the drift note below.

---

## 🔴 Restore rehearsal — attempted 2026-08-13, and it found a blocker BEFORE the rehearsal

A live rehearsal needs somewhere to restore *into*: no Docker, no `psql`, no local Postgres on this machine, and `supabase start` needs Docker. So before asking anyone to install a stack, the cheaper question was asked first: **could a restore even work?**

```bash
cd production && npm run backup:check
```

**Answer: no — not today.** The assumed recipe is "create the schema from git migrations, then insert the backup's data". But:

> **11 tables exist in prod that git's migrations cannot create. 6 of them hold data — including `contacts` with 58 rows.**

| Table | Rows | In git? |
|---|---|---|
| `contacts` | 58 | 6 migrations **ALTER** it — **none CREATE it** |
| `support_plans` | 4 | not mentioned at all |
| `reimbursements` | 3 | 1 ALTER, no CREATE |
| `campaign_templates` | 3 | not mentioned at all |
| `prepaid_advances` | 1 | not mentioned at all |
| `support_sync_outbox` | 1 | not mentioned at all |
| `campaigns`, `campaign_sends`, `employee_documents`, `po_bill_allocations`, `whatsapp_messages` | 0 | not creatable (empty, so lower risk) |

These were created straight in prod via Studio/MCP; only later *alterations* were ever committed. It is the same drift `0003` and `0146` captured before, and `PROJECT-KNOWLEDGE` §14 predicted the remainder — now measured exactly.

**Mitigation already in place:** the backup captures **columns, 430 constraints, indexes and RLS policies** for all 11, so their definitions are recoverable *from the backup* even though git can't produce them. (Constraints were added on 2026-08-13 precisely because of this — without them the backup knew a table's columns but not its rules.)

**Proper fix, not yet done:** generate a `0224_capture_remaining_drift.sql` from the captured definitions — exactly what `0146` did — so git can rebuild prod again. **Do that before the live rehearsal**, otherwise the rehearsal only re-discovers this slowly.

What the check confirmed is fine:
- every populated table's rows match its captured columns (an INSERT would not fail on unknown columns)
- 8 FK references point at `auth.users` — which is **not** in the backup (see below)

## ⚠️ What this does NOT cover

Be clear-eyed about the gaps:

1. **Not a `pg_dump`.** There is no ready-to-run restore script. Restoring means recreating the schema from `production/supabase/migrations/` and re-inserting the JSON data in FK order. **This has never been rehearsed.** An untested restore is a hope, not a plan.
2. **Auth users are not included.** `auth.users` lives outside the `public` schema. Logins would have to be re-created; `public.users` rows reference `auth.users(id)`.
3. **Storage buckets are not included** — TDS certificates (`tds-certificates`), payment receipts, uploaded documents, tenant logos.
4. **It is manual.** Nothing runs it on a schedule yet. A backup you have to remember is a backup you will forget.
5. **Point-in-time recovery is impossible.** You can only go back to the last time someone ran it.

---

## The proper fix (needs a decision + a credential)

Ranked by value:

1. **Supabase Pro (~$25/mo)** — daily automatic backups + 7-day PITR, covering auth, storage and schema. This is the real answer, and the cheapest hour of insurance available for a database with ₹57L of invoices in it. GST records are legally required to be retained.
2. **`supabase db dump`** — the CLI is already installed (v2.114.0), but the project is **not linked** (no `config.toml`, no project ref stored) and linking needs the **database password**. That produces a genuine, restorable `pg_dump`.
3. **Schedule whichever you choose**, and **rehearse one restore** into a scratch project. Until a restore has been done once, the backup's value is unproven.

Until one of those lands, `npm run backup:db` **before any risky change** is the floor — not the ceiling.

---

## Drift note — why live schema is captured

The applied-migration ledger in prod holds **247 records; git holds 194 `.sql` files, and 190 prod records have no matching file.** Most are the descriptive names Studio/MCP assigns (`init_multi_tenant_schema`, `fix_users_infinite_recursion`, …) for changes later consolidated into git — `0003_freeze_baseline.sql` folded in 19 of them, `0146` captured more.

The practical consequence: **git alone cannot reliably reconstruct production.** That is exactly why this backup dumps live policies, functions and triggers rather than trusting the migration files — and why the read-only MCP config exists, so this gap stops widening.

*(Bug worth remembering: the first version of this script used `information_schema.triggers`, which only reports triggers on tables the caller owns — it returned **0** while 46 existed. A silently incomplete backup is more dangerous than none, because you stop worrying. It now reads `pg_trigger`.)*
