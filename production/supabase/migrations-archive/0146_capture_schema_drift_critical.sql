-- 0146: capture CRITICAL schema drift so a fresh DB / CI / DR-restore doesn't
-- ship a money-broken `record_payment`.
--
-- These objects live in PROD but had NO migration file (drift). `record_payment`
-- + `generate_invoice` reference them, so on a from-scratch `db reset` the first
-- real payment threw `relation "purchase_orders" does not exist`. Everything here
-- is IDEMPOTENT (IF NOT EXISTS / CREATE OR REPLACE / drop-then-create policy), so
-- applying to prod is a no-op (objects already exist) while a fresh DB gets them.
--
-- Captured from the live prod catalog (2026-07-28). Remaining lower-risk drift
-- (coupons/site_promos/redeem_coupon, po_bill_allocations, reimbursements, etc.)
-- to be captured via `supabase db diff` once the CLI is available.

-- 1. purchase_orders (record_payment auto-creates a draft PO on first sale) -----
create table if not exists public.purchase_orders (
  id              text not null primary key,
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  customer_id     uuid references public.customers(id) on delete set null,
  customer_name   text not null,
  domain          text,
  vendor          public.vendor not null,
  vendor_order_id text,
  plan            text not null,
  seats           integer not null check (seats > 0),
  term_months     integer not null default 12 check (term_months > 0),
  unit_cost_pm    integer not null default 0,
  total_cost      integer not null default 0,
  status          text not null default 'draft'
                    check (status = any (array['draft','placed','provisioned','closed','cancelled'])),
  placed_at       timestamptz,
  provisioned_at  timestamptz,
  closed_at       timestamptz,
  notes           text,
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.purchase_orders enable row level security;

create index if not exists purchase_orders_subscription_idx  on public.purchase_orders (subscription_id);
create index if not exists purchase_orders_tenant_status_idx on public.purchase_orders (tenant_id, status);
create index if not exists purchase_orders_vendor_idx        on public.purchase_orders (tenant_id, vendor);

drop policy if exists purchase_orders_select       on public.purchase_orders;
drop policy if exists purchase_orders_insert       on public.purchase_orders;
drop policy if exists purchase_orders_update       on public.purchase_orders;
drop policy if exists purchase_orders_delete       on public.purchase_orders;
drop policy if exists purchase_orders_service_role on public.purchase_orders;
create policy purchase_orders_select       on public.purchase_orders for select using (tenant_id = public.current_tenant_id());
create policy purchase_orders_insert       on public.purchase_orders for insert with check (tenant_id = public.current_tenant_id());
create policy purchase_orders_update       on public.purchase_orders for update using (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id());
create policy purchase_orders_delete       on public.purchase_orders for delete using (tenant_id = public.current_tenant_id());
create policy purchase_orders_service_role on public.purchase_orders for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

grant select, insert, update, delete on public.purchase_orders to authenticated;

-- 2. quotes columns record_payment / generate_invoice read --------------------
alter table public.quotes add column if not exists subtotal         integer default 0;
alter table public.quotes add column if not exists discount_pct     smallint default 0;
alter table public.quotes add column if not exists tax_rate         smallint default 18;
alter table public.quotes add column if not exists domain           text;
alter table public.quotes add column if not exists is_add_seats     boolean not null default false;
alter table public.quotes add column if not exists is_extension     boolean not null default false;
alter table public.quotes add column if not exists extension_months integer not null default 12;

-- 3. delete_payment / delete_subscription (bodies were live-only, no migration)
create or replace function public.delete_payment(p_payment_id uuid)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_pay      record;
  v_quote    record;
  v_remaining integer;
  v_expected  integer;
  v_new_status public.payment_status;
  v_subs_removed int := 0;
  v_pos_removed  int := 0;
  v_bank_cnt int;
  v_bad_po   int;
begin
  select * into v_pay from public.payments where id = p_payment_id;
  if not found then raise exception 'Payment not found'; end if;
  if v_tenant is not null and v_pay.tenant_id is distinct from v_tenant then
    raise exception 'Payment not in your tenant' using errcode = 'insufficient_privilege';
  end if;

  select id, tenant_id, amount, invoice_id, is_add_seats, lead_id, customer_id, status
    into v_quote from public.quotes where id = v_pay.quote_id;

  if v_quote.invoice_id is not null then
    raise exception 'A GST invoice is already generated for this quote — cancel / credit-note that invoice before deleting the payment.'
      using errcode = 'invalid_parameter_value';
  end if;

  select count(*) into v_bank_cnt from public.bank_transactions
   where tenant_id = v_pay.tenant_id and matched_to_type = 'payment' and matched_to_id = v_pay.id::text;
  if v_bank_cnt > 0 then
    raise exception 'This payment is reconciled to a bank transaction — un-reconcile that bank line first, then delete.'
      using errcode = 'invalid_parameter_value';
  end if;

  if coalesce(v_quote.is_add_seats, false) then
    raise exception 'This is an add-seats payment — adjust it from the subscription, not by deleting here.'
      using errcode = 'invalid_parameter_value';
  end if;

  delete from public.payments where id = p_payment_id;

  select coalesce(sum(amount), 0) into v_remaining
    from public.payments where quote_id = v_pay.quote_id and status = 'received';
  v_expected := coalesce(v_quote.amount, 0);

  v_new_status := case
    when v_remaining <= 0            then 'none'
    when v_remaining >= v_expected   then 'received'
    else                                  'partial' end::public.payment_status;

  update public.quotes
     set payment_status      = v_new_status,
         payment_amount      = v_remaining,
         payment_method      = case when v_remaining <= 0 then null else payment_method end,
         payment_reference   = case when v_remaining <= 0 then null else payment_reference end,
         payment_received_at = case when v_remaining <= 0 then null else payment_received_at end,
         payment_notes       = case when v_remaining <= 0 then null else payment_notes end,
         status              = case when v_remaining <= 0 and status = 'accepted'
                                    then 'sent'::public.quote_status else status end
   where id = v_pay.quote_id and tenant_id = v_pay.tenant_id;

  if v_remaining <= 0 then
    select count(*) into v_bad_po
      from public.purchase_orders po
      join public.subscriptions s on s.id = po.subscription_id
     where s.tenant_id = v_pay.tenant_id and s.quote_id = v_pay.quote_id and po.status <> 'draft';
    if v_bad_po > 0 then
      raise exception 'A purchase order from this sale is already processed — handle it manually before deleting the payment.'
        using errcode = 'invalid_parameter_value';
    end if;

    with subs as (
      select id from public.subscriptions where tenant_id = v_pay.tenant_id and quote_id = v_pay.quote_id
    )
    delete from public.purchase_orders po using subs where po.subscription_id = subs.id;
    get diagnostics v_pos_removed = row_count;

    delete from public.subscriptions where tenant_id = v_pay.tenant_id and quote_id = v_pay.quote_id;
    get diagnostics v_subs_removed = row_count;

    if v_quote.lead_id is not null then
      update public.leads set stage = 'quote', trial_converted_at = null
       where id = v_quote.lead_id and tenant_id = v_pay.tenant_id and stage = 'won';
    end if;
  else
    update public.subscriptions set outstanding_amount = greatest(0, v_expected - v_remaining)
     where tenant_id = v_pay.tenant_id and quote_id = v_pay.quote_id;
  end if;

  return jsonb_build_object(
    'deleted', true, 'quote_id', v_pay.quote_id, 'amount', v_pay.amount,
    'remaining', v_remaining, 'new_payment_status', v_new_status,
    'subscriptions_removed', v_subs_removed, 'purchase_orders_removed', v_pos_removed
  );
end;
$function$;

create or replace function public.delete_subscription(p_subscription_id uuid)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_sub    record;
  v_paid_cnt int;
  v_bad_po   int;
  v_pos_removed int := 0;
begin
  select * into v_sub from public.subscriptions where id = p_subscription_id;
  if not found then raise exception 'Subscription not found'; end if;
  if v_tenant is not null and v_sub.tenant_id is distinct from v_tenant then
    raise exception 'Subscription not in your tenant' using errcode = 'insufficient_privilege';
  end if;

  if v_sub.quote_id is not null then
    select count(*) into v_paid_cnt from public.payments
     where tenant_id = v_sub.tenant_id and quote_id = v_sub.quote_id and status = 'received';
    if v_paid_cnt > 0 then
      raise exception 'This subscription came from a paid quote — delete that payment in Payments instead; it removes this subscription cleanly.'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  select count(*) into v_bad_po from public.purchase_orders
   where tenant_id = v_sub.tenant_id and subscription_id = p_subscription_id and status <> 'draft';
  if v_bad_po > 0 then
    raise exception 'A purchase order linked to this subscription is already processed — handle it manually first.'
      using errcode = 'invalid_parameter_value';
  end if;

  delete from public.purchase_orders
   where tenant_id = v_sub.tenant_id and subscription_id = p_subscription_id;
  get diagnostics v_pos_removed = row_count;

  delete from public.subscriptions where id = p_subscription_id;

  return jsonb_build_object('deleted', true, 'purchase_orders_removed', v_pos_removed);
end;
$function$;

grant execute on function public.delete_payment(uuid) to authenticated;
grant execute on function public.delete_subscription(uuid) to authenticated;
