# Applying the pending migrations — 0233, 0234, 0235, 0237

Four migrations are written and unapplied. Each one is currently blocking a
feature that already exists in the code:

| Migration | Blocks |
|---|---|
| `0233_access_register` | Access Register |
| `0234_vault_passwords` | **Password Vault** (`/vault` shows a setup card until this runs) |
| `0235_email_provider` | Sending via Gmail (`email_provider`, `gmail_sender_user_id`) |
| `0237_tenant_resend_key` | Per-tenant Resend key |

Also written and unapplied, but nothing is waiting on them today —
`0231_performance_points`, `0232_marketing_attribution`, `0236_mrr_movements`.
Do those after the four below.

---

## The two rules that cost five attempts last time

**1. Run ONE batch per editor run. Never a whole file.**
The Supabase SQL editor runs a pasted script as a single transaction. If any
later statement fails — a `do $$` block, an index, a `comment on` — *everything*
rolls back, including the `ALTER` that succeeded. The screen shows an error that
nobody connects to "nothing was applied".

Every file below is already split with `begin;` / `commit;`. Paste **one
`begin;`…`commit;` block at a time**.

**2. NEVER put a verification `SELECT` in the same run as the DDL.**
It executes inside that same uncommitted transaction, sees the new columns, and
returns rows — so it reports success for a change that is about to disappear.
Run the DDL alone. Then run the verification in a **separate** run.

---

## Order

0233 → 0234 → 0235 → 0237. Nothing here depends on anything else here, so the
order is only about doing the vault first (it is the one you are waiting on).

---

## 0233_access_register — 2 batches

| Batch | Lines | What |
|---|---|---|
| 1 | `begin;` at 42 → `commit;` at 105 | table + comments + 2 indexes |
| 2 | `begin;` at 120 → `commit;` at 135 | enable RLS + 4 policies |

**Verify (separate run):**
```sql
select count(*) as cols from information_schema.columns
 where table_schema='public' and table_name='access_credentials';
select relrowsecurity from pg_class where relname='access_credentials';
select count(*) as policies from pg_policies
 where schemaname='public' and tablename='access_credentials';
```
Expect: cols > 0, `relrowsecurity` = true, policies = 4.

---

## 0234_vault_passwords — 2 batches  ← the one unblocking /vault

| Batch | Lines | What |
|---|---|---|
| 1 | `begin;` at 61 → `commit;` at 137 | `vault_category` enum, `vault_passwords`, `vault_access_log`, 5 indexes |
| 2 | `begin;` at 143 → `commit;` at 181 | enable RLS + policies on both tables |

**Verify (separate run):**
```sql
select table_name from information_schema.tables
 where table_schema='public' and table_name in ('vault_passwords','vault_access_log');
select typname from pg_type where typname='vault_category';
select tablename, count(*) from pg_policies
 where schemaname='public' and tablename in ('vault_passwords','vault_access_log')
 group by tablename;
```
Expect: both tables, the enum, and policies on both.

Then reload `/vault`. The setup card should be replaced by an empty state with
an **Add credential** button.

⚠️ `/vault` also needs `SECRETS_MASTER_KEY`. It is set on Cloud Run but probably
not in your local `.env.local`, so locally you may see an amber "no encryption
key" warning and saving will be blocked. That is deliberate — it refuses rather
than storing an admin password in the clear.

---

## 0235_email_provider — 1 batch

`begin;` at 43 → `commit;` at 69. Adds `user_google_tokens.scopes`,
`tenants.email_provider`, `tenants.gmail_sender_user_id`, one index.

**Verify (separate run):**
```sql
select column_name from information_schema.columns
 where table_schema='public' and table_name='tenants'
   and column_name in ('email_provider','gmail_sender_user_id');
select column_name from information_schema.columns
 where table_schema='public' and table_name='user_google_tokens'
   and column_name='scopes';
select email_provider, count(*) from public.tenants group by 1;
```
Expect: all three columns, and every tenant defaulted to `resend`.

---

## 0237_tenant_resend_key — 1 batch

`begin;` at 27 → `commit;` at 46. Adds `tenant_secrets.resend_api_key`,
`tenants.email_from_address`, `tenants.email_from_name`.

**Verify (separate run):**
```sql
select column_name from information_schema.columns
 where table_schema='public' and table_name='tenant_secrets'
   and column_name='resend_api_key';
select column_name from information_schema.columns
 where table_schema='public' and table_name='tenants'
   and column_name in ('email_from_address','email_from_name');
```

---

## If a batch fails halfway and you re-run it

The tables and indexes use `if not exists`, so re-running batch 1 of anything
here is safe.

**Policies are not idempotent.** Postgres has no `create policy if not exists`,
so re-running a policy batch fails with *"policy … already exists"*. That error
means the batch already succeeded — it is not a new problem. If you need to
re-run it cleanly, drop first:

```sql
-- 0234 batch 2, clean re-run
drop policy if exists "vault_passwords_select" on public.vault_passwords;
drop policy if exists "vault_passwords_insert" on public.vault_passwords;
drop policy if exists "vault_passwords_update" on public.vault_passwords;
drop policy if exists "vault_passwords_delete" on public.vault_passwords;
drop policy if exists "vault_access_log_select" on public.vault_access_log;
drop policy if exists "vault_access_log_insert" on public.vault_access_log;
```
Then paste batch 2 again.

---

## Confirm you are on the right project

`current_database()` is `postgres` on **every** Supabase project, so it cannot
tell two projects apart. Use the project ref in the dashboard URL
(`resellsubsos-prod`), or fingerprint by row count:

```sql
select (select count(*) from public.customers) as customers,
       (select count(*) from public.subscriptions) as subs;
```

---

## After all four are applied — three cleanups in the code

These are not optional tidying; each one is a place where the code can now
silently disagree with the database.

1. **Regenerate the Supabase types.** `src/lib/supabase/types.ts` is generated
   from the live schema and currently does not know about any of the new tables
   or columns.

2. **Delete `src/lib/vault/db.ts`.** It hand-writes the vault row shapes because
   the tables did not exist to TypeScript. Once the real types exist, the shim
   becomes a way for the code to be wrong about the schema with nothing failing.
   Import the generated types instead.

3. **Remove the cast in `src/app/api/integrations/seal/route.ts`** (the
   `secretsTable` block). It exists only because `resend_api_key` was not in the
   generated types.
