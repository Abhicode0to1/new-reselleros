-- ============================================================================
-- WC-scale (30 Sep 2026) — indexes for the reads that stopped loading whole tables.
--
-- ─── WHY ─────────────────────────────────────────────────────────────────────
-- PostgREST caps every response at 1000 rows (supabase/config.toml max_rows) and says
-- nothing when it does. The WC-scale change moved the screens and crons that read whole
-- tables onto paged / id-scoped / counted reads (lib/ops/fetch-all.ts). Those reads now
-- filter and sort on columns that had no index leading on them:
--
--   lead_activities (tenant_id, kind, created_at)
--       queries/lead-first-reply.ts — first OUTBOUND touch per lead: `kind in (…)` ordered
--       by created_at. The existing (tenant_id, created_at) index makes that a scan of every
--       activity kind.
--   leads (tenant_id, created_at desc, id desc)
--       list_leads() keyset order (created_at, id) < cursor, the Lead Sources "created
--       since" pages and the CSV export. leads_tenant_created_idx (tenant_id, created_at
--       desc) cannot finish the tie-break on id, so every page re-sorts its tail.
--   leads (tenant_id, stage, created_at desc, id desc)
--       the Kanban board, now one capped query per column (stage = X order by created_at
--       desc limit 200) — idx_leads_tenant_stage finds the column but not its newest 200.
--   leads — trigram GIN on lower(company | contact_name | contact_email | contact_phone |
--       plan), the five columns list_leads() / lead_counts() search with
--       `lower(col) like '%…%'`. A leading wildcard can use no btree; without these every
--       keystroke in the search box is a sequential scan of the tenant's leads. One index
--       per column because the search ORs them — Postgres combines them with a BitmapOr.
--   subscriptions (quote_id)
--       the invoice-dunning cron now prefetches "the subscription billed from this quote"
--       for 200 quote ids at a time; the only index carrying quote_id leads on tenant_id.
--   notifications (tenant_id, created_at desc), activity_log (tenant_id, created_at desc)
--       — the audit log is `activity_log`. Both already exist (20260901130000 and
--       baseline.sql); restated with THE SAME NAMES so a database that missed them gets them
--       and every other database no-ops.
--
-- pg_trgm: Supabase installs extensions into the `extensions` schema. `create extension if
-- not exists` no-ops wherever it already is, so the opclass is looked up from the catalog
-- rather than hard-coded — a project where pg_trgm lives in `public` gets the right one.
--
-- ─── ON PRODUCTION: CONCURRENTLY, OUTSIDE A TRANSACTION ──────────────────────
-- Plain CREATE INDEX takes a SHARE lock: writes to the table wait for the build. Migration
-- runners wrap each file in a transaction, and CREATE INDEX CONCURRENTLY cannot run inside
-- one — so this file is plain and IF NOT EXISTS, which is right for local, CI and staging.
-- On production run each CREATE INDEX below MANUALLY first, one statement per call, as
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS … (the deploy doc handles this step), then apply
-- this file: every IF NOT EXISTS then no-ops. After a concurrent build, confirm nothing is INVALID
-- (a failed CONCURRENTLY build leaves an invalid index that IF NOT EXISTS would skip):
--     select indexrelid::regclass from pg_index where not indisvalid;   -- expect 0 rows
-- ============================================================================

-- Not every database HAS an `extensions` schema: hosted Supabase does, the Cloud SQL
-- production database does not ("schema extensions does not exist" — found by the 2 Oct 2026
-- go-live rehearsal on a clone of production). Use it where it exists, the default schema
-- where it does not, and touch nothing where pg_trgm is already installed. The trigram block
-- below already reads the schema from the catalog, so either placement works.
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_trgm') then
    if exists (select 1 from pg_namespace where nspname = 'extensions') then
      create extension pg_trgm with schema extensions;
    else
      create extension pg_trgm;
    end if;
  end if;
end
$$;

-- ─── lead_activities ────────────────────────────────────────────────────────
create index if not exists lead_activities_tenant_kind_time_idx
  on public.lead_activities (tenant_id, kind, created_at);

-- ─── leads: keyset + board columns ──────────────────────────────────────────
create index if not exists leads_tenant_created_id_idx
  on public.leads (tenant_id, created_at desc, id desc);

create index if not exists leads_tenant_stage_created_idx
  on public.leads (tenant_id, stage, created_at desc, id desc);

-- ─── leads: trigram search (list_leads / lead_counts `lower(col) like '%…%'`) ──
do $$
declare
  v_schema text;
  v_col    text;
begin
  select n.nspname into v_schema
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pg_trgm';
  foreach v_col in array array['company', 'contact_name', 'contact_email', 'contact_phone', 'plan'] loop
    execute format(
      'create index if not exists %I on public.leads using gin (lower(%I) %I.gin_trgm_ops)',
      'leads_' || v_col || '_trgm_idx', v_col, v_schema);
  end loop;
end
$$;

-- ─── subscriptions: by source quote (invoice-dunning prefetch) ─────────────
create index if not exists subscriptions_quote_idx
  on public.subscriptions (quote_id) where quote_id is not null;

-- ─── notifications / audit log (already present — same names, so these no-op) ──
create index if not exists notifications_tenant
  on public.notifications (tenant_id, created_at desc);

create index if not exists activity_log_tenant_time_idx
  on public.activity_log (tenant_id, created_at desc);
