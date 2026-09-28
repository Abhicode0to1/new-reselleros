-- S16 — sidebar badges in ONE round trip.
--
-- WHY: useNavBadges ran 1 auth.getUser + 1 users read + 7 parallel counts + 1 approvals
-- count = ~10 requests per open tab every 60s. This returns the same nine numbers from a
-- single call.
--
-- SECURITY INVOKER on purpose. Every count below is the same query the hook ran through
-- PostgREST, so it must see exactly the rows the caller's RLS lets them see (tenant
-- policies, and the leads/quotes hierarchy policies via can_see_record). A definer
-- function would have to re-implement all of that and could drift; invoker cannot.
-- The guard makes a caller with no workspace (or the service role, which has no
-- auth.uid()) fail loudly instead of being handed zeros or cross-tenant totals.
--
-- p_approval_tiers comes from tiersApprovableBy(role) in lib/quotes/awaiting-approval.ts,
-- so "which tiers may this role clear" stays defined in one place (the TS rule a test
-- already cross-checks) rather than being copied into SQL.
--
-- Each block mirrors src/lib/hooks/useNavBadges.ts as it was before this change:
--   leads      leads.stage in (new, contact)
--   enquiries  inbound_emails.status = received and lead_id is null
--   deals      leads.stage in (quote, demo, trial)
--   tasks      tasks.status = pending and due_at < end of today IST
--   renewals   subscriptions.status = active and renewal_date <= UTC date of now()+30d
--   invoices   invoices.status in (pending, overdue)
--   payments   quotes.payment_status = received
--   quotes     approval_status = pending, approval_requested_by <> me (NULL dropped, as
--              PostgREST neq does), approval_tier in p_approval_tiers

create or replace function public.nav_badges(p_approval_tiers text[] default '{}')
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_me     uuid := auth.uid();
  v_tenant uuid := public.current_tenant_id();
  -- End of today in IST, as an instant (same as the hook's startUTC + 24h).
  v_eod    timestamptz := ((date_trunc('day', now() at time zone 'Asia/Kolkata') + interval '1 day')
                           at time zone 'Asia/Kolkata');
  -- The hook used new Date(Date.now() + 30d).toISOString().split("T")[0] — a UTC date.
  v_renew  date := ((now() at time zone 'UTC') + interval '720 hours')::date;
  v_quotes integer := 0;
begin
  if v_tenant is null then
    raise exception 'nav_badges: no workspace for this session'
      using errcode = 'insufficient_privilege';
  end if;

  if v_me is not null and coalesce(array_length(p_approval_tiers, 1), 0) > 0 then
    select count(*) into v_quotes
      from public.quotes q
     where q.approval_status = 'pending'
       and q.approval_requested_by <> v_me
       and q.approval_tier::text = any (p_approval_tiers);
  end if;

  return jsonb_build_object(
    'leads',     (select count(*) from public.leads l where l.stage in ('new', 'contact')),
    'enquiries', (select count(*) from public.inbound_emails e where e.status = 'received' and e.lead_id is null),
    'deals',     (select count(*) from public.leads l where l.stage in ('quote', 'demo', 'trial')),
    'tasks',     (select count(*) from public.tasks t where t.status = 'pending' and t.due_at < v_eod),
    'renewals',  (select count(*) from public.subscriptions s where s.status = 'active' and s.renewal_date <= v_renew),
    'invoices',  (select count(*) from public.invoices i where i.status in ('pending', 'overdue')),
    'payments',  (select count(*) from public.quotes q where q.payment_status = 'received'),
    'quotes',    v_quotes
  );
end;
$$;

revoke all on function public.nav_badges(text[]) from public;
revoke all on function public.nav_badges(text[]) from anon;
grant execute on function public.nav_badges(text[]) to authenticated;

comment on function public.nav_badges(text[]) is
  'S16: every sidebar badge count in one call. SECURITY INVOKER — RLS decides what is counted. Mirrors useNavBadges.';
