-- 0241 — selective table reset, and the backup that must succeed before it runs
--
-- WHY A FUNCTION AND NOT AN API ROUTE THAT DELETES
-- ------------------------------------------------
-- The reset and the backup that protects it have to be ONE transaction. If they
-- are two steps in TypeScript, every failure between them leaves the tenant with
-- rows deleted and no snapshot — the exact state this exists to prevent. In here
-- a failed delete rolls the backup back too, which is harmless: nothing was
-- deleted either. The only outcomes are "backup AND reset" or "neither".
--
-- THE ALLOWLIST IS THE SECURITY BOUNDARY
-- --------------------------------------
-- p_tables arrives from a browser. %I quoting stops injection, but it does not
-- stop 'users' or 'payments' being passed by a bug or by someone with the
-- owner's session. Anything not on RESETTABLE below is refused by name, so the
-- worst a compromised caller can do is clear tables the UI already offers.
--
-- STATUTORY TABLES ARE NOT ORDINARY DATA
-- --------------------------------------
-- invoices and attendance are on the list because they were asked for, but they
-- are records the business is required to keep — GST tax invoices must form an
-- unbroken series (CLAUDE.md §17a, CGST §31), and attendance backs payroll. They
-- need p_confirm_statutory => true, passed deliberately, so "reset my demo data"
-- can never quietly also mean "delete this year's invoices".
--
-- ⚠️  RUN THE DDL ALONE, verify in a SEPARATE run (§25.6).

begin;

-- Tables the UI may offer, mapped to the checkbox the owner ticks. Anything
-- absent here cannot be reset by this function at all.
create or replace function backup._resettable()
returns table (key text, tbl text, statutory boolean)
language sql immutable as $$
  values
    ('leads',      'leads',            false),
    ('leads',      'lead_activities',  false),
    -- quotes store their line items inline; there is no quote_items table.
    ('quotes',     'quotes',           false),
    ('tasks',      'tasks',            false),
    ('expenses',   'expense_claims',   false),
    -- Statutory — see the header. Never reachable without p_confirm_statutory.
    ('invoices',   'invoices',         true),
    ('attendance', 'attendance',       true)
$$;

comment on function backup._resettable() is
  'Allowlist for reset_tenant_selected_tables. A table not listed here cannot be reset, whatever the caller sends.';

create or replace function public.reset_tenant_selected_tables(
  p_tables             text[],
  p_label              text,
  p_confirm_statutory  boolean default false
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_tenant   uuid;
  v_role     text;
  v_backup   jsonb;
  v_bad      text[];
  v_stat     text[];
  r          record;
  v_deleted  jsonb := '{}'::jsonb;
  n          bigint;
begin
  -- ── Who ────────────────────────────────────────────────────────────────
  select tenant_id, role into v_tenant, v_role from public.users where id = auth.uid();
  if v_tenant is null then
    raise exception 'No tenant for caller';
  end if;
  if coalesce(v_role, '') <> 'owner' then
    raise exception 'Only the owner can reset data. Ask the account owner to do this.';
  end if;

  if p_tables is null or cardinality(p_tables) = 0 then
    raise exception 'Nothing selected. Tick at least one section to reset.';
  end if;

  -- ── Refuse anything off the allowlist, BY NAME ─────────────────────────
  select array_agg(t) into v_bad
  from unnest(p_tables) t
  where t not in (select key from backup._resettable());

  if v_bad is not null then
    raise exception 'Not resettable: %. Allowed: %',
      array_to_string(v_bad, ', '),
      (select string_agg(distinct key, ', ' order by key) from backup._resettable());
  end if;

  -- ── Statutory sections need saying so out loud ─────────────────────────
  select array_agg(distinct key) into v_stat
  from backup._resettable()
  where statutory and key = any(p_tables);

  if v_stat is not null and not p_confirm_statutory then
    raise exception
      'Refusing to reset % — these are statutory records (GST invoice series must have no gaps; attendance backs payroll). Re-run with the statutory confirmation if you are certain.',
      array_to_string(v_stat, ', ');
  end if;

  -- ── THE SHIELD. Before a single row is deleted. ────────────────────────
  -- backup._take raises on failure, so reaching the next line means a snapshot
  -- exists. The size check catches the quieter failure: a snapshot row that
  -- was written but holds nothing.
  v_backup := backup._take(v_tenant, 'Pre-Reset Safeguard Snapshot - ' || coalesce(p_label, 'unlabelled'), 'pre_reset');

  if v_backup is null
     or coalesce((v_backup->>'bytes')::bigint, 0) = 0
     or coalesce((v_backup->>'table_count')::int, 0) = 0 then
    raise exception 'Pre-reset backup produced an empty snapshot — refusing to delete anything. Nothing has been changed.';
  end if;

  -- ── Delete, tenant-scoped, allowlisted tables only ─────────────────────
  for r in
    select tbl from backup._resettable() where key = any(p_tables)
  loop
    -- Verified here rather than trusted from the list above. A table that was
    -- renamed, dropped, or never had tenant_id would otherwise fail mid-loop
    -- with a cryptic error, and the allowlist is maintained by hand — the one
    -- place a stale entry turns a safety feature into the thing that breaks.
    -- An unscoped table is the dangerous case: `delete from x` with no
    -- tenant_id would take EVERY tenant's rows, so it must abort, not proceed.
    if to_regclass('public.' || quote_ident(r.tbl)) is null then
      raise exception 'Reset allowlist is stale: table public.% does not exist. Nothing has been changed.', r.tbl;
    end if;
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = r.tbl and column_name = 'tenant_id'
    ) then
      raise exception 'Refusing to reset public.% — it has no tenant_id, so the delete could not be scoped to one tenant. Nothing has been changed.', r.tbl;
    end if;

    execute format('delete from public.%I where tenant_id = $1', r.tbl) using v_tenant;
    get diagnostics n = row_count;
    v_deleted := v_deleted || jsonb_build_object(r.tbl, n);
  end loop;

  return jsonb_build_object(
    'backup_id',  v_backup->>'id',
    'backup_bytes', (v_backup->>'bytes')::bigint,
    'deleted',    v_deleted,
    'label',      p_label
  );
end $$;

comment on function public.reset_tenant_selected_tables(text[], text, boolean) is
  'Owner-only selective reset. Takes a pre_reset snapshot FIRST and aborts if it is empty; backup and deletes share one transaction, so the only outcomes are both or neither.';

revoke all on function public.reset_tenant_selected_tables(text[], text, boolean) from public;
grant execute on function public.reset_tenant_selected_tables(text[], text, boolean) to authenticated;

commit;

-- ── VERIFY — SEPARATE run ───────────────────────────────────────────────────
--
-- select key, tbl, statutory from backup._resettable() order by key, tbl;
--
-- Refusal paths (each should RAISE, and change nothing):
--   select public.reset_tenant_selected_tables(array['users'],    'probe');           -- not resettable
--   select public.reset_tenant_selected_tables(array['invoices'], 'probe');           -- statutory, unconfirmed
--   select public.reset_tenant_selected_tables(array[]::text[],   'probe');           -- nothing selected
