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
--   Section 3 remains OFF, and the reason CHANGED on 18 Aug 2026 — read §3's first block.
--   The original reason (37 rows with no owner) turned out not to be the real one: the
--   IS NULL branch already keeps those visible, and measuring it proved no quote
--   disappears. The real findings are worse and better:
--     · WORSE — as written, those policies could not have restricted anything. They were
--       PERMISSIVE, Postgres ORs permissive policies, and a tenant-wide permissive SELECT
--       policy already exists on all three tables. Rewritten `as restrictive`.
--     · BETTER — the remaining blocker is one decision, not a data cleanup: enabling this
--       today takes 4 of 10 staff to zero leads. Measured per person, listed in §3.
--   3a (the predicate function) is also NOT applied: the permission classifier blocked the
--   create-function call. The exact command is in §3a.

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

-- ─── SECTION 3: RLS — READ THE FIRST BLOCK BEFORE RUNNING ANYTHING ──────────
--
-- ⚠️ CORRECTED 18 Aug 2026 — THE POLICIES HERE WERE PREVIOUSLY UNABLE TO RESTRICT
--    ANYTHING. They were written as ordinary (PERMISSIVE) policies. Postgres combines
--    permissive policies with OR, and these already exist — read out of pg_policies on the
--    live database, same date:
--        leads_select      SELECT  PERMISSIVE  tenant_id = current_tenant_id()
--        quotes_select     SELECT  PERMISSIVE  tenant_id = current_tenant_id()
--        customers_select  SELECT  PERMISSIVE  tenant_id = current_tenant_id()
--    So "rows belonging to my team" OR "every row in my tenant" is every row in the
--    tenant. Adding a permissive policy can only ever GRANT. Every rep would have kept
--    seeing everything, `create policy` would have reported success, and the UI caveat
--    would have been switched off — peer isolation declared done while nothing had
--    changed. An access-control change that silently no-ops is worse than one that fails,
--    because nobody goes looking for it.
--
--    The fix is `as restrictive`, which Postgres combines with AND. Tenant isolation stays
--    in the permissive policy where it belongs — it is the outer boundary and has to
--    survive any mistake in the inner one — and hierarchy narrows inside it.
--
-- THE CUSTOMER PORTAL MUST NOT BE CAUGHT BY THIS
--    A restrictive policy ANDs against EVERY permissive policy, including the two that let
--    a customer read their own records:
--        quotes_select_own_customer      customer_id = current_customer_id()
--        customers_select_self_customer  id = current_customer_id()
--    Without an exemption, a customer opening their own quote link is tested against a
--    reporting tree they are not in: get_subordinate_user_ids() of a customer's auth id
--    matches no users row, returns the empty set, and the quote disappears. The public
--    accept page would break for every quote that has an owner — and it would break for
--    the customer, not for us, so we would hear about it late. Hence the
--    `current_customer_id() is not null` branch. This policy is about staff, and says so.
--
-- WHAT THIS DOES TO REAL PEOPLE — MEASURED, NOT ESTIMATED
--    The predicate below was evaluated against every user in the ANUTECH tenant on
--    18 Aug 2026, using the deployed function and the real rows:
--
--        pardeep@anutech.in            owner         leads 14/14   quotes 23/23
--        deepak@anutech.in             owner         leads 14/14   quotes 23/23
--        info@srigangatechnologies.com owner         leads 14/14   quotes 23/23
--        ananya@anutech.in             manager       leads 11/14   quotes 23/23
--        sales@anutech.in              sales_senior  leads 11/14   quotes 23/23
--        hitesh@anutech.in             manager       leads  1/14   quotes 23/23
--        abhishek@anutech.in           delivery      leads  0/14   quotes 23/23
--        pawan@anutech.in              delivery      leads  0/14   quotes 23/23
--        pratik@anutech.in             support       leads  0/14   quotes 23/23
--        ranjeet@anutech.in            support       leads  0/14   quotes 23/23
--
--    Two things that table says, and both matter more than the SQL under it:
--
--    1. NO MONEY DISAPPEARS. All 23 quotes have a NULL owner, so every one stays visible
--       through the IS NULL branch. Peer isolation on quotes begins the day quotes are
--       assigned, not the day this runs. That removes the reason this section was
--       originally held back — the unowned rows are handled, not endangered.
--
--    2. SIX OF TEN PEOPLE LOSE MOST OR ALL OF THE LEADS LIST, four of them to zero. That
--       is not a fault in the predicate: delivery and support own no leads and have no
--       reports, so "mine plus my team's" is correctly nothing. It is a fault in applying
--       a sales-rep privacy model to back-office staff, who need to open a record in order
--       to service it. The brief said "admins see all"; this schema has no admin role. It
--       has owner / manager / sales_senior / sales / delivery / support, and only `owner`
--       is all-seeing here.
--
--    So the blocker changed shape. It is no longer the unowned rows. It is a question
--    nobody has answered: should support and delivery see the pipeline? Running this today
--    answers it by accident, in the direction of "no", on a day nobody chose. That is
--    Pardeep's decision, not a migration's.
--
--    Note also that the tree is nearly empty — only two users have a manager_id at all.
--    hitesh is titled manager and sees 1 of 14 because nobody reports to him yet. Assign
--    the real reporting lines FIRST; the numbers above change when you do, and enabling
--    before then measures the empty tree rather than the company.
--
-- ─── 3a: the shared predicate — NOT YET APPLIED ──────────────────────────────
--
-- Safe to run on its own: a function with no policy referencing it changes nobody's
-- visibility by a single row. It is separated from 3b precisely so the predicate can be
-- reviewed and installed without switching anything on.
--
-- I could not apply it. The permission classifier blocked the `create function` call, and
-- I did not attempt a workaround. To install it, run this as one statement:
--
--   npx supabase db query --linked "create or replace function public.can_see_record(p_owner uuid) returns boolean language sql stable security definer set search_path = public, pg_temp as 'select p_owner is null or public.current_customer_id() is not null or exists (select 1 from public.users u where u.id = auth.uid() and u.role = ''owner'') or p_owner in (select public.get_subordinate_user_ids(auth.uid()))'"
--
-- (That form uses a quoted body with doubled quotes instead of $$ …  $$ because a $$ pair
--  inside a double-quoted shell argument is expanded by the shell as the process id. Same
--  function, different quoting. The $$ form below is the one to paste into the SQL editor.)
begin;

/*
 * Can the current caller see a record owned by p_owner?
 *
 * One definition, used by every policy below, because nine copies of a security predicate
 * across three tables is nine places for them to drift apart — and a policy that drifts
 * fails open without a symptom.
 *
 * SECURITY DEFINER with a pinned search_path, for the same two reasons as
 * get_subordinate_user_ids: it reads the RLS-protected users table from inside a policy,
 * and a definer function with a mutable search_path can be attacked by shadowing `users`.
 *
 * Branch order is deliberate — cheapest and most common first, the recursive walk last.
 */
create or replace function public.can_see_record(p_owner uuid) returns boolean language sql stable security definer set search_path = public, pg_temp as $$ select p_owner is null or public.current_customer_id() is not null or exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner') or p_owner in (select public.get_subordinate_user_ids(auth.uid())) $$;

comment on function public.can_see_record(uuid) is
  'True when the caller may see a record owned by p_owner. NULL owner = unclaimed company data, visible to the tenant. Portal customers are exempt — they are not in the reporting tree. Owners see all. Otherwise the reporting tree decides.';

revoke all on function public.can_see_record(uuid) from public;
grant execute on function public.can_see_record(uuid) to authenticated, anon;

commit;

-- ─── 3b: the policies — COMMENTED OUT, pending the decision above ────────────
--
-- Enable one table at a time and check the app in between. `as restrictive` is the whole
-- point of this block; a copy of it without those two words does nothing at all.
--
-- begin;
--
-- drop policy if exists leads_hierarchy_select on public.leads;
-- create policy leads_hierarchy_select on public.leads
--   as restrictive for select using (public.can_see_record(owner_id));
--
-- drop policy if exists quotes_hierarchy_select on public.quotes;
-- create policy quotes_hierarchy_select on public.quotes
--   as restrictive for select using (public.can_see_record(owner_id));
--
-- drop policy if exists customers_hierarchy_select on public.customers;
-- create policy customers_hierarchy_select on public.customers
--   as restrictive for select using (public.can_see_record(account_manager_id));
--
-- -- You must not be able to edit or delete what you cannot see. Without these six, a rep
-- -- who cannot READ a peer's lead can still UPDATE it by id, because leads_update is
-- -- tenant-wide — a blind write, which is worse than a read. INSERT is deliberately left
-- -- alone: a manager assigning a new lead to a rep is legitimate, and a restrictive WITH
-- -- CHECK would block it.
-- drop policy if exists leads_hierarchy_write on public.leads;
-- create policy leads_hierarchy_write on public.leads
--   as restrictive for update using (public.can_see_record(owner_id));
-- drop policy if exists leads_hierarchy_delete on public.leads;
-- create policy leads_hierarchy_delete on public.leads
--   as restrictive for delete using (public.can_see_record(owner_id));
--
-- drop policy if exists quotes_hierarchy_write on public.quotes;
-- create policy quotes_hierarchy_write on public.quotes
--   as restrictive for update using (public.can_see_record(owner_id));
-- drop policy if exists quotes_hierarchy_delete on public.quotes;
-- create policy quotes_hierarchy_delete on public.quotes
--   as restrictive for delete using (public.can_see_record(owner_id));
--
-- drop policy if exists customers_hierarchy_write on public.customers;
-- create policy customers_hierarchy_write on public.customers
--   as restrictive for update using (public.can_see_record(account_manager_id));
-- drop policy if exists customers_hierarchy_delete on public.customers;
-- create policy customers_hierarchy_delete on public.customers
--   as restrictive for delete using (public.can_see_record(account_manager_id));
--
-- commit;
--
-- ROLLBACK — the first thing to reach for if the app goes quiet after enabling:
--   drop policy if exists leads_hierarchy_select     on public.leads;
--   drop policy if exists leads_hierarchy_write      on public.leads;
--   drop policy if exists leads_hierarchy_delete     on public.leads;
--   drop policy if exists quotes_hierarchy_select    on public.quotes;
--   drop policy if exists quotes_hierarchy_write     on public.quotes;
--   drop policy if exists quotes_hierarchy_delete    on public.quotes;
--   drop policy if exists customers_hierarchy_select on public.customers;
--   drop policy if exists customers_hierarchy_write  on public.customers;
--   drop policy if exists customers_hierarchy_delete on public.customers;
-- Dropping a restrictive policy restores the previous behaviour exactly, because the
-- permissive tenant policies were never touched.
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
--
-- ─── AND THE ONE THAT ACTUALLY PROVES SECTION 3 ───────────────────────────────
--   supabase/tests/hierarchy_peer_isolation.test.sql
--
--   It builds its own owner / manager / repA / repB tree, creates the function and the two
--   restrictive policies, drops to `set local role authenticated` so RLS is genuinely
--   enforced, asserts that repA sees own+unowned but never repB's, that repB mirrors it,
--   that the manager sees both, that the owner sees all, and that repA cannot blind-write
--   repB's lead by id — then rolls all of it back.
--
--   Because DDL is transactional, it runs BEFORE this migration is applied. That matters:
--   it separates "is the SQL correct" from "should support staff see the pipeline", and only
--   the second one needs a decision. On a dev/test DB only — it inserts fixtures:
--     npx supabase db query --db-url "<dev url>" -f supabase/tests/hierarchy_peer_isolation.test.sql
--
--   As of 18 Aug 2026 it has NOT been run: no dev database exists on this machine and it
--   must not be pointed at production. It is asserted, not passed. Its own header says so.
