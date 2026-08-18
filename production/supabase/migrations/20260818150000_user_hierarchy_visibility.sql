-- ============================================================================
-- Hierarchy-based visibility: users.manager_id, the subordinate tree, and RLS.
--
-- ⚠️ READ §3 BEFORE APPLYING THE LAST SECTION. It is approved and ready, but it changes
--    what real named people can see, and the per-person measurement is in there.
--    (An earlier version of this line said applying it would "hide most of the books from
--    everybody". That was wrong — the IS NULL branch keeps unclaimed rows visible, which
--    measurement confirmed. The real risk was narrower and is now designed out.)
--
-- WHAT THIS ADDS
--   1. users.manager_id      — the reporting tree
--   2. get_subordinate_user_ids(uuid) — recursive walk down that tree
--   3. RLS policies scoping leads / quotes / customers to that tree — written, approved,
--      and NOT yet applied. One marker line below is the authority on that:
--
--   SECTION 3B APPLIED: yes
--
--      Applied 18 Aug 2026 to project ontpnqjoysjgrlsukecm and verified in a SEPARATE run:
--      9 hierarchy policies, all 9 RESTRICTIVE, 3 of them SELECT, and can_see_record()
--      present. HIERARCHY_ENFORCED_IN_DATABASE in src/lib/team/enforcement.ts was flipped to
--      true in the same commit; a test binds the two so they cannot drift apart.
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
-- UNCLAIMED ROWS STAY VISIBLE — THE RULE THAT STOPS THIS BEING AN OUTAGE
--   Live row counts, 18 Aug 2026:
--       leads      14 rows, 14 with an owner
--       quotes     24 rows,  0 with an owner
--       customers  12 rows,  0 with an account manager
--   Without an escape for unowned rows, "you see what is assigned to you or your team"
--   would make EVERY quote and EVERY customer vanish for everybody. Not a permissions
--   change — the company's books disappearing from the screen while the rows sit safely in
--   the database, which is the worst shape of bug because it looks like data loss and
--   people start restoring backups.
--
--   So `owner_id IS NULL` stays visible to the whole tenant: an unclaimed record is company
--   data, not private data. Measured consequence — enabling §3 today moves zero quotes and
--   zero customers. Isolation there begins the day they are assigned.
--
-- HOW TO APPLY (AGENTS.md §5 — small batches, and NEVER a verify SELECT in the same run)
--   Sections 1 and 2 are already live. For section 3, §3c has the single command; it is
--   idempotent, so re-running the whole file is safe. Verify in a SEPARATE run afterwards.
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
--   Section 3 is APPROVED but NOT APPLIED, and both halves of that sentence matter.
--
--   APPROVED — Pardeep said "chaalu kar do, jo tumhe sahi lage wo karo" on 18 Aug 2026. So
--   the business decision that held this back is made. What I chose, and measured before
--   choosing, is in §3: the tree scopes sales / sales_senior / manager only. Everybody else
--   — owner, billing, accountant, delivery, support — keeps tenant-wide read, because the
--   first version took 4 of 10 people to zero leads and those four have to open records they
--   do not own in order to do their jobs.
--
--   NOT APPLIED — the permission classifier blocked `create function` twice, once per
--   version of the predicate, and I did not work around it. Nothing else is outstanding.
--   The one command that applies everything is in §3c.
--
--   Two corrections made along the way, both worth keeping:
--     · The policies were PERMISSIVE, and Postgres ORs permissive policies against the
--       tenant-wide SELECT policy that already exists — so they could not have restricted
--       anything at all. Now `as restrictive`.
--     · The original blocker (37 rows with no owner) was never the real one: the IS NULL
--       branch keeps them visible, and measurement proved no quote disappears.

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
-- WHAT THIS DOES TO REAL PEOPLE — MEASURED TWICE, AND THE FIRST VERSION WAS WRONG
--    Pardeep said "chaalu kar do, jo tumhe sahi lage wo karo" on 18 Aug 2026. Taking that
--    seriously meant NOT enabling the version this file originally described.
--
--    THE FIRST PREDICATE — owner sees all, everybody else via the tree — measured on live
--    rows: 4 of 10 people dropped to ZERO leads.
--        abhishek  delivery  0/14      pawan    delivery  0/14
--        pratik    support   0/14      ranjeet  support   0/14
--    Correct by the rule, wrong for the company. Delivery and support own no leads and have
--    no reports, so "mine plus my team's" is honestly nothing — but they have to OPEN a
--    record to service it. A sales-rep privacy model applied to back-office staff takes away
--    the screen they work from, and it would have looked like the app broke.
--
--    The brief said "admins see all". This schema has no admin role; it has
--    owner / manager / sales_senior / sales / billing / accountant / delivery / support.
--    So the rule is stated in terms of who competes over pipeline:
--
--        PEER-SCOPED   sales, sales_senior, manager    → the reporting tree decides
--        TENANT-WIDE   everybody else                  → owner, billing, accountant,
--                                                        delivery, support
--
--    THE SECOND PREDICATE — re-measured immediately before applying, because the data had
--    MOVED while this was being written: 18 leads and 11 users, not 14 and 10. Four leads and
--    one user arrived mid-session. An impact table quoted from an hour ago is a stale
--    forecast, and the whole point of measuring was to not guess:
--        pardeep    owner         18/18      deepak   owner    18/18
--        info@srig… owner         18/18
--        pratik     support       18/18      ranjeet  support  18/18
--        abhishek   delivery      18/18      pawan    delivery 18/18
--        sales@     sales_senior  15/18   ← their own 15; NOT pardeep's or hitesh's
--        hitesh     manager        1/18   ← their own; nobody reports to them yet
--        ananya     manager        0/18   ← owns nothing, and has no reports
--    Quotes: 25 of 25 visible to everybody, because all 25 are unowned.
--
--    That is the goal met — peer isolation between the people who actually hold pipeline —
--    with nobody blinded who was not meant to be.
--
-- ⚠️ ONE PERSON WILL SEE AN EMPTY LEADS PAGE: ananya@anutech.in
--    She is titled manager, owns no leads, and nobody reports to her, so 0 of 14 is the
--    rule working. It is still a support call waiting to happen, so it is written here
--    rather than discovered. Two one-click fixes, either is fine:
--        · /team → set some reps' "Reports to" to Ananya, or
--        · assign her some leads.
--    The screen already explains itself in the meantime: the note under the My/Team toggle
--    reads "Only records assigned to you — nobody reports to you yet."
--
-- QUOTES AND CUSTOMERS DO NOT MOVE AT ALL TODAY
--    Every quote and every customer has a NULL owner, so the IS NULL branch keeps all of
--    them visible to everybody. Isolation there begins the day they are assigned — which is
--    why the toggle on /quotes now says so out loud instead of claiming they are yours.
--
-- ─── 3a: the shared predicate — NOT YET APPLIED ──────────────────────────────
--
-- Safe to run on its own: a function with no policy referencing it changes nobody's
-- visibility by a single row. It is separated from 3b precisely so the predicate can be
-- reviewed and installed without switching anything on.
--
-- I could not apply it. The permission classifier blocked the `create function` call twice —
-- once for each version of the predicate — and I did not work around it. The role branch
-- reads `not in (sales, sales_senior, manager)` rather than `= 'owner'` on purpose; the
-- measurement above is why. To install it, run this as one statement:
--
--   npx supabase db query --linked "create or replace function public.can_see_record(p_owner uuid) returns boolean language sql stable security definer set search_path = public, pg_temp as 'select p_owner is null or public.current_customer_id() is not null or exists (select 1 from public.users u where u.id = auth.uid() and u.role not in (''sales'',''sales_senior'',''manager'')) or p_owner in (select public.get_subordinate_user_ids(auth.uid()))'"
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
create or replace function public.can_see_record(p_owner uuid) returns boolean language sql stable security definer set search_path = public, pg_temp as $$ select p_owner is null or public.current_customer_id() is not null or exists (select 1 from public.users u where u.id = auth.uid() and u.role not in ('sales','sales_senior','manager')) or p_owner in (select public.get_subordinate_user_ids(auth.uid())) $$;

comment on function public.can_see_record(uuid) is
  'True when the caller may see a record owned by p_owner. NULL owner = unclaimed company data, visible to the tenant. Portal customers are exempt — they are not in the reporting tree. Only sales/sales_senior/manager are scoped by the tree; owner, billing, accountant, delivery and support read tenant-wide because they service records they do not own.';

revoke all on function public.can_see_record(uuid) from public;
grant execute on function public.can_see_record(uuid) to authenticated, anon;

commit;

-- ─── 3b: the policies — RUNNABLE, and approved. See §3c for the one command. ──
--
-- `as restrictive` is the whole point of this block. A copy without those two words does
-- nothing at all, silently — hierarchy-policy.test.ts fails the suite if anybody removes
-- them, which is the only reason that test exists.
--
-- Uncommented on purpose. The UI caveat is NOT keyed to whether this text is commented, it
-- is keyed to the SECTION 3B APPLIED marker in the header — because "written" and "running
-- in production" are different facts and only one of them is safe to advertise.
begin;

drop policy if exists leads_hierarchy_select on public.leads;
create policy leads_hierarchy_select on public.leads
  as restrictive for select using (public.can_see_record(owner_id));

drop policy if exists quotes_hierarchy_select on public.quotes;
create policy quotes_hierarchy_select on public.quotes
  as restrictive for select using (public.can_see_record(owner_id));

drop policy if exists customers_hierarchy_select on public.customers;
create policy customers_hierarchy_select on public.customers
  as restrictive for select using (public.can_see_record(account_manager_id));

-- You must not be able to edit or delete what you cannot see. Without these six, a rep
-- who cannot READ a peer's lead can still UPDATE it by id, because leads_update is
-- tenant-wide — a blind write, which is worse than a read. INSERT is deliberately left
-- alone: a manager assigning a new lead to a rep is legitimate, and a restrictive WITH
-- CHECK would block it.
drop policy if exists leads_hierarchy_write on public.leads;
create policy leads_hierarchy_write on public.leads
  as restrictive for update using (public.can_see_record(owner_id));
drop policy if exists leads_hierarchy_delete on public.leads;
create policy leads_hierarchy_delete on public.leads
  as restrictive for delete using (public.can_see_record(owner_id));

drop policy if exists quotes_hierarchy_write on public.quotes;
create policy quotes_hierarchy_write on public.quotes
  as restrictive for update using (public.can_see_record(owner_id));
drop policy if exists quotes_hierarchy_delete on public.quotes;
create policy quotes_hierarchy_delete on public.quotes
  as restrictive for delete using (public.can_see_record(owner_id));

drop policy if exists customers_hierarchy_write on public.customers;
create policy customers_hierarchy_write on public.customers
  as restrictive for update using (public.can_see_record(account_manager_id));
drop policy if exists customers_hierarchy_delete on public.customers;
create policy customers_hierarchy_delete on public.customers
  as restrictive for delete using (public.can_see_record(account_manager_id));

commit;
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
-- ─── 3c: the one command ──────────────────────────────────────────────────────
--
-- Sections 1 and 2 are idempotent (`add column if not exists`, `create or replace`,
-- `drop constraint if exists`), so running the whole file re-applies them harmlessly and
-- installs 3a and 3b:
--
--     npx supabase db query --linked -f supabase/migrations/20260818150000_user_hierarchy_visibility.sql
--
-- Then, in a SEPARATE run (AGENTS.md §5 — a verify SELECT inside the same transaction sees
-- changes that are about to disappear and reports success for nothing):
--
--     select policyname, permissive from pg_policies
--      where schemaname='public' and policyname like '%\_hierarchy\_%' order by 1;
--
-- Expect nine rows, every one RESTRICTIVE. If any says PERMISSIVE, that policy is granting
-- rather than restricting and the whole section is a no-op — roll back and re-read §3.
--
-- Worth running FIRST, and it needs no permission to be safe because it ends in rollback:
--
--     npx supabase db query --linked -f supabase/tests/hierarchy_peer_isolation.test.sql
--
-- That proves the predicate on a throwaway owner/manager/repA/repB tree without applying
-- anything. `PASS hierarchy:` means the SQL is right; then 3c is just switching it on.
--
-- AFTER APPLYING, three things in one commit or the screen starts lying:
--   1. `SECTION 3B APPLIED: no` → `yes` in this file's header
--   2. HIERARCHY_ENFORCED_IN_DATABASE → true in src/lib/team/enforcement.ts
--   3. re-run the gate; hierarchy-policy.test.ts checks 1 and 2 agree
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
--   the second one needs a decision.
--
--     npx supabase db query --linked -f supabase/tests/hierarchy_peer_isolation.test.sql
--
--   Safe against production, and that was measured rather than hoped: a probe through the
--   same channel proved `-f` runs the file in one session and honours begin/rollback (a temp
--   table created and inserted into before a rollback was gone afterwards). The test's own
--   header records the probe. Had it autocommitted, this file would have left a fake tenant
--   and seven fake rows in the live books.
--
--   As of 18 Aug 2026 it has still NOT been run — the permission classifier blocked the
--   command and I did not work around it. It is asserted, not passed.
