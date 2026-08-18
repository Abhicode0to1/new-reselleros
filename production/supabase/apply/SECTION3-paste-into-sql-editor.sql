-- ============================================================================
-- ⚠️ ALREADY APPLIED, 18 Aug 2026, to project ontpnqjoysjgrlsukecm. Kept for the record and
--    because it is idempotent — re-running it is harmless. Verified in a separate run:
--    9 policies, all 9 RESTRICTIVE, can_see_record() present.
--
-- ⚠️⚠️ THE PROJECT REF IS PART OF THE INSTRUCTION. THIS IS NOT PEDANTRY.
--    The first attempt pasted this into the SQL editor of project ixgvlbgmvgaihvudtbwt —
--    "resellersosv3-staging", whose branch is even labelled PRODUCTION in the dashboard. It
--    failed with `42883: function public.get_subordinate_user_ids(uuid) does not exist`,
--    because Sections 1 and 2 live in the OTHER project.
--
--    Nothing was applied to the wrong database, and the reason is the single transaction
--    argued for below: the missing function aborted the whole script. Had this been pasted in
--    small batches, the function and some policies would have landed in staging first.
--
--    The right project — the one .env.local points the app at:
--        https://supabase.com/dashboard/project/ontpnqjoysjgrlsukecm/sql/new
--    CLAUDE.md §25.6 already warns that current_database() is `postgres` on every Supabase
--    project and cannot tell two apart. Use the ref in the URL. Never the name — the wrong
--    project here is named more convincingly than the right one.
--
-- IF YOU USE THE CLI INSTEAD, STRIP THE ENV VAR FIRST
--    A malformed SUPABASE_ACCESS_TOKEN is set on this machine (sbp_ prefix, 75 chars, not the
--    44-char hex a real PAT is), and the CLI prefers it over the stored login, failing with
--    "Invalid access token format". Removing it for one command falls back to the login:
--        env -u SUPABASE_ACCESS_TOKEN npx supabase db query --linked -f <this file>
--    That is how it was actually applied. Fixing the env var itself is a credential job for
--    its owner, not something to work around further.
--
-- PASTE THIS WHOLE FILE INTO THE SUPABASE SQL EDITOR AND PRESS RUN.
--
-- This is Section 3 of 20260818150000_user_hierarchy_visibility.sql — the predicate
-- function and the nine restrictive policies — and nothing else. Sections 1 and 2 are
-- already live, so they are not repeated here.
--
-- WHY THIS FILE EXISTS RATHER THAN JUST RUNNING THE MIGRATION
--   The CLI route failed on Pardeep's machine with "Invalid access token format": his
--   Command Prompt has a malformed SUPABASE_ACCESS_TOKEN. The SQL editor needs no token
--   and no CLI, so it sidesteps the problem entirely instead of asking anybody to handle
--   a credential.
--
-- IT IS SAFE TO PASTE ALL OF IT AT ONCE, which is NOT the usual rule here
--   CLAUDE.md §25.6 says run DDL in small batches, because the editor executes a pasted
--   script as ONE transaction and a late failure silently rolls back the early successes.
--   That rule protects against a partial apply. Here a single transaction is what we
--   WANT: either all nine policies exist or none do. Half-applied peer isolation is the
--   bad outcome — some tables scoped, others not, with no error to say so.
--   There is no `do $$` block and no `comment on` on a missing object, which are the two
--   things that usually fail late in these scripts.
--
-- ⚠️ NO VERIFY SELECT IS INCLUDED, DELIBERATELY. A SELECT in this same run would execute
--    inside this uncommitted transaction, see the new policies, and report success for a
--    change that might be about to disappear. Verify in a SECOND, separate run — the query
--    is at the bottom of this file, commented out.
--
-- WHAT CHANGES THE MOMENT THIS RUNS (measured on live rows, 18 Aug 2026)
--   sales@anutech.in   sees 11 of 14 leads — their own, not Pardeep's 2 or Hitesh's 1
--   hitesh@anutech.in  sees  1 of 14 — his own; nobody reports to him yet
--   ananya@anutech.in  sees  0 of 14 — owns nothing, has no reports. Expected. Fix by
--                      giving her reports on /team, or by assigning her some leads.
--   everybody else     sees 14 of 14 — the three owners, plus support and delivery, who
--                      have to open records they do not own in order to service them
--   quotes and customers do not move at all: every row is unowned, so the IS NULL branch
--   keeps all of them visible. Isolation there starts the day they are assigned.
--
-- ROLLBACK is at the bottom. Dropping a restrictive policy restores the previous
-- behaviour exactly, because the permissive tenant policies are never touched here.
-- ============================================================================

-- ─── the shared predicate ────────────────────────────────────────────────────
-- SECURITY DEFINER with a pinned search_path: it reads the RLS-protected users table from
-- inside a policy, and a definer function with a mutable search_path can be attacked by
-- shadowing `users`. Branch order is cheapest-first; the recursive walk is last.
--
-- The role branch names the SALES MOTION, not the exempt roles. Scoping everybody except
-- `owner` by the tree was measured first and gave 0 of 14 leads to both support users and
-- both delivery users — correct by the rule, and it would have taken away the screen they
-- work from.
create or replace function public.can_see_record(p_owner uuid) returns boolean language sql stable security definer set search_path = public, pg_temp as $$ select p_owner is null or public.current_customer_id() is not null or exists (select 1 from public.users u where u.id = auth.uid() and u.role not in ('sales','sales_senior','manager')) or p_owner in (select public.get_subordinate_user_ids(auth.uid())) $$;

comment on function public.can_see_record(uuid) is
  'True when the caller may see a record owned by p_owner. NULL owner = unclaimed company data, visible to the tenant. Portal customers are exempt — they are not in the reporting tree. Only sales/sales_senior/manager are scoped by the tree; owner, billing, accountant, delivery and support read tenant-wide because they service records they do not own.';

revoke all on function public.can_see_record(uuid) from public;
grant execute on function public.can_see_record(uuid) to authenticated, anon;

-- ─── the nine policies ───────────────────────────────────────────────────────
-- `as restrictive` is the whole point. Postgres combines PERMISSIVE policies with OR, and
-- a tenant-wide permissive SELECT policy already exists on all three tables — so a
-- permissive copy of these would GRANT rather than restrict, report success, and change
-- nothing. RESTRICTIVE combines with AND. Tenant isolation stays in the permissive policy
-- where it belongs: it is the outer boundary and must survive any mistake in this one.

drop policy if exists leads_hierarchy_select on public.leads;
create policy leads_hierarchy_select on public.leads
  as restrictive for select using (public.can_see_record(owner_id));

drop policy if exists quotes_hierarchy_select on public.quotes;
create policy quotes_hierarchy_select on public.quotes
  as restrictive for select using (public.can_see_record(owner_id));

drop policy if exists customers_hierarchy_select on public.customers;
create policy customers_hierarchy_select on public.customers
  as restrictive for select using (public.can_see_record(account_manager_id));

-- You must not be able to edit or delete what you cannot see. Without these six, a rep who
-- cannot READ a peer's lead can still UPDATE it by id, because leads_update is tenant-wide
-- — a blind write, which is worse than a read. INSERT is deliberately left alone: a manager
-- assigning a new lead to a rep is legitimate, and a restrictive WITH CHECK would block it.
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

-- ============================================================================
-- STEP 2 — VERIFY, IN A SEPARATE RUN. Clear the editor first, then paste ONLY this:
--
--   select policyname, permissive from pg_policies
--    where schemaname = 'public' and policyname like '%hierarchy%'
--    order by policyname;
--
-- Expect NINE rows, every one RESTRICTIVE. A row saying PERMISSIVE is a policy that
-- grants instead of restricting — that table has no isolation, roll back and say so.
--
-- ROLLBACK — if anything looks wrong, paste this instead:
--
--   drop policy if exists leads_hierarchy_select     on public.leads;
--   drop policy if exists leads_hierarchy_write      on public.leads;
--   drop policy if exists leads_hierarchy_delete     on public.leads;
--   drop policy if exists quotes_hierarchy_select    on public.quotes;
--   drop policy if exists quotes_hierarchy_write     on public.quotes;
--   drop policy if exists quotes_hierarchy_delete    on public.quotes;
--   drop policy if exists customers_hierarchy_select on public.customers;
--   drop policy if exists customers_hierarchy_write  on public.customers;
--   drop policy if exists customers_hierarchy_delete on public.customers;
-- ============================================================================
