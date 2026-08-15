-- 0044_partner_metrics.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Partner Metrics RPC (Slice 3 — distributor's /partners page)
--
-- Returns aggregated, privacy-preserving metrics per child tenant for the
-- caller. Used to render the distributor-facing /partners dashboard so
-- Excel Tech can see, at a glance, how each sub-reseller is performing —
-- WITHOUT exposing the child's individual customer / lead details.
--
-- Aggregates exposed (per child):
--   • active_subscriptions   — count of subscriptions where status='active'
--   • total_seats_sold       — sum of seats across active subscriptions
--   • mrr                    — sum of MRR across active subscriptions
--   • invoiced_this_month    — sum of invoice.amount this calendar month
--   • paid_this_month        — sum of invoice.amount paid this month
--   • renewals_due_30d       — count of active subscriptions whose
--                              renewal_date is within 30 days
--   • renewal_revenue_30d    — projected revenue from those renewals (= mrr × 12 ≈ annual)
--   • last_invoice_date      — most recent invoice on the child's side
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.get_partner_metrics()
returns table (
  tenant_id              uuid,
  tenant_name            text,
  tenant_gstin           text,
  active_subscriptions   integer,
  total_seats_sold       integer,
  mrr                    integer,
  invoiced_this_month    integer,
  paid_this_month        integer,
  renewals_due_30d       integer,
  renewal_revenue_30d    integer,
  last_invoice_date      date
)
language sql
security definer
set search_path = public
stable
as $$
  with caller as (
    select tenant_id from public.users where id = auth.uid() limit 1
  ),
  month_start as (
    select date_trunc('month', current_date)::date as d
  ),
  children as (
    select t.id, t.name, t.gstin
    from public.tenants t
    where t.parent_tenant_id = (select tenant_id from caller)
  )
  select
    c.id,
    c.name,
    c.gstin,
    coalesce((
      select count(*)::int from public.subscriptions s
      where s.tenant_id = c.id and s.status = 'active'
    ), 0),
    coalesce((
      select sum(seats)::int from public.subscriptions s
      where s.tenant_id = c.id and s.status = 'active'
    ), 0),
    coalesce((
      select sum(mrr)::int from public.subscriptions s
      where s.tenant_id = c.id and s.status = 'active'
    ), 0),
    coalesce((
      select sum(amount)::int from public.invoices i
      where i.tenant_id = c.id and i.invoice_date >= (select d from month_start)
    ), 0),
    coalesce((
      select sum(amount)::int from public.invoices i
      where i.tenant_id = c.id
        and i.status = 'paid'
        and i.paid_date is not null
        and i.paid_date >= (select d from month_start)
    ), 0),
    coalesce((
      select count(*)::int from public.subscriptions s
      where s.tenant_id = c.id
        and s.status = 'active'
        and s.renewal_date is not null
        and s.renewal_date <= current_date + interval '30 days'
    ), 0),
    coalesce((
      select sum(mrr * 12)::int from public.subscriptions s
      where s.tenant_id = c.id
        and s.status = 'active'
        and s.renewal_date is not null
        and s.renewal_date <= current_date + interval '30 days'
    ), 0),
    (
      select max(invoice_date) from public.invoices i
      where i.tenant_id = c.id
    )
  from children c
  order by c.name;
$$;

revoke all on function public.get_partner_metrics() from public;
grant  execute on function public.get_partner_metrics() to authenticated;
