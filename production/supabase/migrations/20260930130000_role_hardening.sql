-- 20260930130000_role_hardening.sql
--
-- S41 (WC-sec, Pardeep's audit 30 Sep 2026). Every guard below checked only the TENANT,
-- so any member of a workspace — a sales rep, a support agent, a delivery user — could do
-- things only an owner should. Tenant isolation was never the missing half; the ROLE was.
--
-- ══ WHAT WAS OPEN, measured on this database ═════════════════════════════════
--
--   backup RPCs   get/list/delete/create/restore_tenant_backup guard with
--                 `tenant_id = (select tenant_id from public.users where id = auth.uid())`
--                 and nothing else. So ANY member could download the whole workspace
--                 snapshot — Google refresh tokens, salaries, employee personal data — or
--                 delete it, or restore an old one over today's books. `restore` is the
--                 worst of the five and had the same guard as the others.
--   api_keys      select / insert / update are `tenant_id = current_tenant_id()`. Any
--                 member could read the workspace's API keys, or mint one.
--   money tables  salary_payments, employees, bank_accounts, bank_transactions carry
--                 "tenant isolation" policies only. A sales rep could rewrite a salary or
--                 change the bank account money is reconciled against.
--   attendance    tenants.attendance_ingest_key is on the tenants row every member reads.
--                 It is the shared secret the attendance device posts with.
--
-- ══ WHAT IS DELIBERATELY NOT HERE ════════════════════════════════════════════
--
--   `backup._take` trimming tokens / personal data out of the snapshot payload.
--   THE BACKUP SCHEMA DOES NOT EXIST ON THIS DATABASE — `select * from pg_tables where
--   schemaname = 'backup'` is empty, which is why `pre_reset_shield` and
--   `offsite_export_service_role_only` are red locally. Writing a payload change I cannot
--   read or run is the kind of blind edit this repo keeps paying for (AGENTS.md L8/L9), so
--   it is left for whoever has that schema in front of them. Locking the RPCs down means
--   only an owner can reach the payload in the meantime, which is the larger half.
--
--   `expenses` and `reimbursements` are NOT restricted. Employees legitimately file their
--   own claims against them (see lib/expenses/advance-visibility.ts), so an owner-only
--   write rule would break an everyday flow — and a guard that blocks the ordinary case is
--   a guard somebody deletes (AGENTS.md L103).
--
--   READS on employees / bank_accounts / bank_transactions stay at tenant isolation. The
--   audit's words are "har role BADAL sakta hai" — changing. Narrowing reads as well would
--   be a bigger, separate decision about who may see the staff list, and it belongs to
--   whoever owns those screens. salary_payments is the exception: a salary is personal, so
--   its READ is restricted too. Flagged on the board rather than decided quietly.

begin;

-- ── The helper every rule below shares ──────────────────────────────────────────────
--
-- One function, so "who may touch money" has a single definition instead of a role list
-- copy-pasted into a dozen policies that then drift. `current_user_is_owner()` already
-- existed and is left alone; this is its general form.

create or replace function public.current_user_has_role(variadic p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
  /* `is_active` matters as much as the role: a deactivated owner is how an ex-employee
     keeps their access. current_user_is_owner() already checks it; this matches. */
  select exists (
    select 1 from public.users u
    where u.id = auth.uid()
      and u.is_active
      and u.role::text = any (p_roles)
  );
$function$;

comment on function public.current_user_has_role(text[]) is
  'True when the signed-in user is ACTIVE and holds one of the given roles. The single '
  'definition of "who may touch this" for RLS policies and SECURITY DEFINER guards. S41.';

/* Granted to `authenticated` only — deliberately NOT to anon.
   R-013 exempts RLS policy helpers from the anon revoke because a policy runs as the
   querying role. That reasoning does not apply here: nothing anon can query carries these
   policies, so anon EXECUTE would be a grant with no caller. If anon ever does reach such
   a table the query fails loudly, which is the outcome R-013 prefers over a silent pass. */
revoke all on function public.current_user_has_role(text[]) from public, anon;
grant execute on function public.current_user_has_role(text[]) to authenticated, service_role;

-- ── 1. Backup RPCs: owner only ──────────────────────────────────────────────────────
--
-- The check goes FIRST in each body, before the snapshot table is touched, so the refusal
-- is about authorisation rather than about whatever the read finds. It also means the
-- guard is testable on a database that has no `backup` schema.
--
-- `auth.uid() is not null` is part of it: these run SECURITY DEFINER, and a session with no
-- JWT (psql, a migration, the SQL tests) must not be handed owner rights by default.

create or replace function public.guard_backup_owner_only()
returns void
language plpgsql
stable
security definer
set search_path = public
as $function$
begin
  if not public.current_user_has_role('owner') then
    raise exception
      'Only the workspace owner can use backups. A backup holds every table in the workspace — salaries, personal details and connected-account tokens — so it is not a staff-level action. Ask an owner to run it (Settings → Backup).'
      using errcode = 'insufficient_privilege';
  end if;
end $function$;

revoke all on function public.guard_backup_owner_only() from public, anon;
grant execute on function public.guard_backup_owner_only() to authenticated, service_role;

commit;

begin;

-- ── 2. The three backup RPCs that had no role check ─────────────────────────────────
--
-- CORRECTION to the audit's framing, found by reading the live bodies rather than the
-- card: `create_tenant_backup` and `restore_tenant_backup` ALREADY refuse a non-owner.
-- The gap is exactly three — the ones that READ and DELETE. So the pattern was known and
-- simply not carried to the rest, which is this repo's most common shape (L75, L97, L98).
--
-- All three were `language sql`. They become plpgsql so the refusal can RAISE. Adding
-- `and current_user_has_role('owner')` to the WHERE instead would have returned an empty
-- result, and "no rows" is not a refusal — it reads as "you have no backups", which is a
-- failure dressed as a fact (AGENTS.md §2, §7).

create or replace function public.get_tenant_backup(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.guard_backup_owner_only();
  return (
    select payload from backup.snapshots
     where id = p_id
       and tenant_id = (select tenant_id from public.users where id = auth.uid())
  );
end $function$;

create or replace function public.list_tenant_backups()
returns table(id uuid, created_at timestamp with time zone, label text, kind text, table_count integer, bytes integer)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.guard_backup_owner_only();
  return query
    select s.id, s.created_at, s.label, s.kind, s.table_count, length(s.payload::text)
      from backup.snapshots s
     where s.tenant_id = (select tenant_id from public.users where id = auth.uid())
     order by s.created_at desc;
end $function$;

create or replace function public.delete_tenant_backup(p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.guard_backup_owner_only();
  delete from backup.snapshots
   where id = p_id
     and tenant_id = (select tenant_id from public.users where id = auth.uid());
end $function$;

/* These were dropped-and-recreated in spirit (language changed), so re-state the grants
   rather than trusting what was there — R-013 / AGENTS.md L114. Never anon. */
revoke all on function public.get_tenant_backup(uuid)    from public, anon;
revoke all on function public.list_tenant_backups()      from public, anon;
revoke all on function public.delete_tenant_backup(uuid) from public, anon;
grant execute on function public.get_tenant_backup(uuid)    to authenticated, service_role;
grant execute on function public.list_tenant_backups()      to authenticated, service_role;
grant execute on function public.delete_tenant_backup(uuid) to authenticated, service_role;

-- ── 3. api_keys: only an owner reads or mints them ──────────────────────────────────
--
-- An API key is a credential for the whole workspace's /api/v1. Any member could read one
-- and use it outside the app, where no RLS and no screen applies.

/* Both the OLD and the NEW names are dropped first, so this migration can be re-run.
   That is not tidiness: these files carry no begin/commit for apply-migration.mjs, so a
   production apply that fails part-way is re-run from the top, and a second run that
   errors on "already exists" looks exactly like a broken migration. */
drop policy if exists api_keys_select_own   on public.api_keys;
drop policy if exists api_keys_select_owner on public.api_keys;
drop policy if exists api_keys_insert_owner on public.api_keys;
drop policy if exists api_keys_update_owner on public.api_keys;
drop policy if exists api_keys_insert_own on public.api_keys;
drop policy if exists api_keys_update_own on public.api_keys;

create policy api_keys_select_owner on public.api_keys for select
  using (tenant_id = public.current_tenant_id() and public.current_user_has_role('owner'));
create policy api_keys_insert_owner on public.api_keys for insert
  with check (tenant_id = public.current_tenant_id() and public.current_user_has_role('owner'));
create policy api_keys_update_owner on public.api_keys for update
  using (tenant_id = public.current_tenant_id() and public.current_user_has_role('owner'));

commit;

begin;

-- ── 4. Money and HR tables: tenant isolation was the only rule ──────────────────────
--
-- salary_payments, employees, bank_accounts and bank_transactions each carried four
-- "tenant isolation" policies and nothing about who the caller is. A sales or support
-- login could rewrite a salary, or repoint the bank account that payments reconcile to.
--
-- WRITES are restricted to owner / manager / accountant. READS are left at tenant
-- isolation for three of the four, on purpose: the audit's words are "har role BADAL
-- sakta hai" — changing — and narrowing who may SEE the staff list or the bank list is a
-- bigger product decision belonging to whoever owns those screens. salary_payments is the
-- exception; a salary is personal, so its read is restricted too.
--
-- `expenses` and `reimbursements` are deliberately untouched: employees file their own
-- claims against them (lib/expenses/advance-visibility.ts), and an owner-only write rule
-- there would break an everyday flow. A guard that blocks the ordinary case is a guard
-- somebody deletes within a week (AGENTS.md L103).

do $$
declare
  t text;
  v_money constant text := 'public.current_user_has_role(''owner'', ''manager'', ''accountant'')';
begin
  foreach t in array array['salary_payments', 'employees', 'bank_accounts', 'bank_transactions'] loop
    execute format('drop policy if exists %I on public.%I', 'tenant isolation write',  t);
    execute format('drop policy if exists %I on public.%I', t || '_insert_money_roles', t);
    execute format('drop policy if exists %I on public.%I', t || '_update_money_roles', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete_money_roles', t);
    execute format('drop policy if exists %I on public.%I', 'tenant isolation update', t);
    execute format('drop policy if exists %I on public.%I', 'tenant isolation delete', t);

    execute format(
      'create policy %I on public.%I for insert with check (tenant_id = public.current_tenant_id() and %s)',
      t || '_insert_money_roles', t, v_money);
    execute format(
      'create policy %I on public.%I for update using (tenant_id = public.current_tenant_id() and %s)',
      t || '_update_money_roles', t, v_money);
    execute format(
      'create policy %I on public.%I for delete using (tenant_id = public.current_tenant_id() and %s)',
      t || '_delete_money_roles', t, v_money);
  end loop;

  /* Salary is the one READ that is personal rather than merely commercial. */
  execute format('drop policy if exists %I on public.salary_payments', 'tenant isolation read');
  execute format('drop policy if exists salary_payments_select_money_roles on public.salary_payments');
  execute format(
    'create policy salary_payments_select_money_roles on public.salary_payments for select using (tenant_id = public.current_tenant_id() and %s)',
    v_money);
end $$;

commit;
