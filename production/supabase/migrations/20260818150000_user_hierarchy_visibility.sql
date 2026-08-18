-- ============================================================================
-- Hierarchy-based visibility: users.manager_id, the subordinate tree, and RLS.
--
-- ⚠️ READ THIS BEFORE APPLYING. The last section is OFF by default and must not be
--    switched on until the owner columns are backfilled. Applying it today would hide
--    most of the books from everybody. Details below.
--
-- WHAT THIS ADDS
--   1. users.manager_id      — the reporting tree
--   2. get_subordinate_user_ids(uuid) — recursive walk down that tree
--   3. RLS policies scoping leads / quotes / customers to that tree — COMMENTED OUT
--
-- THE COLUMN NAMES ARE THE ONES THAT EXIST
--   The brief specified `assigned_to_user_id`. No such column exists on any table.
--   What exists, verified against the live database on 18 Aug 2026:
--       leads.owner_id
--       quotes.owner_id
--       customers.account_manager_id
--       invoices      — NO owner column at all
--       subscriptions — NO owner column at all
--   Writing a policy against `assigned_to_user_id` would fail at apply time; writing one
--   for invoices or subscriptions is not possible until they carry an owner. Those two are
--   therefore out of scope here and say so, rather than being quietly skipped.
--
-- WHY THE POLICIES ARE COMMENTED OUT — THE PART THAT MATTERS
--   Live row counts, same date:
--       leads      14 rows, 14 with an owner
--       quotes     25 rows,  0 with an owner
--       customers  12 rows,  0 with an account manager
--   A policy of "you see rows assigned to you or your team" therefore makes EVERY quote and
--   EVERY customer invisible to everybody except an owner. That is not a permissions
--   change, it is the company's books disappearing from the screen while the rows sit
--   safely in the database — the worst shape of bug, because it looks like data loss and
--   people start restoring backups.
--
--   The policies below handle it: `owner_id IS NULL` stays visible to the whole tenant,
--   because an unclaimed record is company data, not private data. Even so they stay
--   commented until somebody has decided who owns those 37 rows, because the moment they
--   ARE owned the rule starts biting and that should be a decision, not a surprise.
--
-- HOW TO APPLY (AGENTS.md §5 — small batches, and NEVER a verify SELECT in the same run)
--   Run section 1 alone, verify. Then section 2 alone, verify. Leave section 3 until the
--   backfill is done, then uncomment and run it one table at a time.
-- ============================================================================

-- APPLIED STATUS (18 Aug 2026)
--   Sections 1 and 2 are LIVE in production, applied via `supabase db query --linked`
--   and verified in a separate run: manager_id, users_manager_idx,
--   users_manager_not_self and get_subordinate_user_ids() all exist.
--
--   NOT applied via `supabase db push`, deliberately. The CLI reports 29 local migrations
--   as absent from the remote tracking table, but the OBJECTS from those migrations all
--   exist in the database — they were applied by hand through the SQL editor. So the drift
--   is in the tracking, not the schema, and `db push` would try to re-apply 28 files that
--   are already in place. That is worth fixing (`supabase migration repair`) but it is a
--   decision about 28 files nobody has re-read, not a step in this migration.
--
--   Section 3 remains OFF. See below.

-- ─── SECTION 1: the reporting tree ──────────────────────────────────────────
begin;

alter table public.users
  add column if not exists manager_id uuid references public.users(id) on delete set null;

comment on column public.users.manager_id is
  'Who this user reports to. NULL at the top of the tree. ON DELETE SET NULL rather than CASCADE — removing a manager must orphan their reports, never delete the people.';

-- The tree is always walked downward ("who reports to me"), so that is the index.
create index if not exists users_manager_idx on public.users (manager_id) where manager_id is not null;

/* A user cannot manage themselves. A one-row cycle is the likeliest mis-click on a
   hand-edited self-referencing column, and it is the one a recursive query cannot
   terminate on without a guard. Longer cycles cannot be prevented by a CHECK — the
   function below carries its own protection. */
alter table public.users
  drop constraint if exists users_manager_not_self;
alter table public.users
  add constraint users_manager_not_self check (manager_id is null or manager_id <> id);

commit;

-- ─── SECTION 2: the subordinate tree ────────────────────────────────────────
begin;

/*
 * Every user id at or below p_user_id in the reporting tree.
 *
 * SECURITY DEFINER with a pinned search_path: it reads public.users, which is itself
 * RLS-protected, and a policy that CALLS this function while the function is subject to
 * that policy is a recursion Postgres refuses. Pinning search_path stops a caller
 * shadowing `users` with their own table — the standard escalation against a definer
 * function.
 *
 * The UNION (not UNION ALL) is the cycle guard: a cycle re-visits an id, the union
 * discards the duplicate, and the recursion terminates. UNION ALL here would loop for
 * ever, and the symptom would be a hanging page with no error rather than a wrong answer.
 *
 * Scoped to the caller's own tenant, so a manager in one workspace can never walk into
 * another's tree even if an id were guessed.
 */
create or replace function public.get_subordinate_user_ids(p_user_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with recursive tree as (
    select u.id, u.tenant_id
    from public.users u
    where u.id = p_user_id
    union
    select c.id, c.tenant_id
    from public.users c
    join tree t on c.manager_id = t.id
    where c.tenant_id = t.tenant_id
  )
  select id from tree;
$$;

comment on function public.get_subordinate_user_ids(uuid) is
  'User ids at or below p_user_id in the reporting tree, within one tenant. UNION (not UNION ALL) terminates on a cycle. Always includes p_user_id, so a rep with no reports gets exactly themselves.';

revoke all on function public.get_subordinate_user_ids(uuid) from public;
grant execute on function public.get_subordinate_user_ids(uuid) to authenticated;

commit;

-- ─── SECTION 3: RLS — DO NOT RUN UNTIL THE BACKFILL IS DONE ─────────────────
--
-- Before uncommenting, answer this with real data:
--
--     select count(*) from public.quotes    where owner_id is null;            -- 25 today
--     select count(*) from public.customers where account_manager_id is null;  -- 12 today
--
-- While those are non-zero the rows stay visible via the IS NULL branch, which is correct
-- but means peer isolation is not yet actually in force for them. Isolation begins when
-- they are owned. Assign them first, then enable this, so the change in what people can
-- see happens on a day somebody chose.
--
-- Each policy ADDS to the existing tenant check rather than replacing it — tenant
-- isolation is the outer boundary and must survive any mistake in the inner one.
--
-- begin;
--
-- drop policy if exists leads_hierarchy_select on public.leads;
-- create policy leads_hierarchy_select on public.leads
--   for select using (
--     tenant_id = current_tenant_id()
--     and (
--       -- Unclaimed rows are company data. See the header.
--       owner_id is null
--       or owner_id in (select public.get_subordinate_user_ids(auth.uid()))
--       -- An owner sees the whole workspace.
--       or exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner')
--     )
--   );
--
-- drop policy if exists quotes_hierarchy_select on public.quotes;
-- create policy quotes_hierarchy_select on public.quotes
--   for select using (
--     tenant_id = current_tenant_id()
--     and (
--       owner_id is null
--       or owner_id in (select public.get_subordinate_user_ids(auth.uid()))
--       or exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner')
--     )
--   );
--
-- drop policy if exists customers_hierarchy_select on public.customers;
-- create policy customers_hierarchy_select on public.customers
--   for select using (
--     tenant_id = current_tenant_id()
--     and (
--       account_manager_id is null
--       or account_manager_id in (select public.get_subordinate_user_ids(auth.uid()))
--       or exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner')
--     )
--   );
--
-- commit;
--
-- invoices and subscriptions are DELIBERATELY absent. Neither carries an owner column, so
-- there is nothing to scope by. Scoping them through their customer would be a guess with
-- a consequence: an invoice is the legal record of a supply, and hiding one from the person
-- who has to file the GST return is worse than showing it to a rep who does not need it.
-- If they are to be restricted, they need an owner column and a decision about filing
-- access first.

-- ─── HOW TO VERIFY (SEPARATE run from the DDL — AGENTS.md §5) ────────────────
--   select column_name from information_schema.columns
--    where table_schema='public' and table_name='users' and column_name='manager_id';
--
--   -- A user with no reports must get exactly themselves:
--   select count(*) from public.get_subordinate_user_ids(
--     (select id from public.users where email = 'ananya@anutech.in'));   -- expect 1
--
--   -- The owner's tree must include everybody who reports up to them:
--   select count(*) from public.get_subordinate_user_ids(
--     (select id from public.users where email = 'pardeep@anutech.in'));
