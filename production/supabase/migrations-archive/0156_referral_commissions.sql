-- 0156 — Referral / channel-partner commissions.
--
-- When someone refers a customer or helps close a deal, the reseller pays them
-- a commission. Modelled as three tables + an auto-accrual trigger:
--
--   referral_partners     — the person/company who refers (name, PAN for TDS, defaults)
--   referral_agreements   — a partner tied to ONE customer's deal, with terms
--                           (percent | fixed, one_time | recurring, TDS on/off)
--   referral_commissions  — the earned entries; ONE row per triggering payment
--
-- Money direction: commission is an EXPENSE (money OUT). It appears in P&L as a
-- referral-commission line and is paid out from a bank account (pay_referral_commission).
--
-- Auto-accrual: an AFTER-INSERT trigger on `payments` runs INSIDE record_payment's
-- transaction. When a payment lands for a customer that has an ACTIVE agreement, a
-- commission is accrued:
--   • one_time  → only the first payment ever accrues (guarded)
--   • recurring → every payment (incl. renewals) accrues
-- Base = the payment's EX-GST value (GST is not the reseller's revenue, so no
-- commission on it) derived from the payment's quote tax_rate (export → 0 → base = amount).
--
-- CRITICAL money-spine protection: the accrual body is wrapped in an EXCEPTION
-- handler. If anything in the referral bookkeeping fails, it is logged as a WARNING
-- and the customer's payment STILL succeeds. Referral accounting must never block
-- the core money flow.

-- ─────────────────────────────────────────────────────────────────────────────
-- referral_partners
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.referral_partners (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  name                 text not null,
  phone                text,
  email                text,
  pan                  text,                                        -- for TDS 194H
  gstin                text,                                        -- if the partner is GST-registered
  default_basis        text not null default 'percent' check (default_basis in ('percent','fixed')),
  default_percent      numeric(5,2) default 10 check (default_percent >= 0 and default_percent <= 100),
  default_fixed_amount integer default 0 check (default_fixed_amount >= 0),
  deduct_tds           boolean not null default false,
  tds_rate             numeric(5,2) not null default 5 check (tds_rate >= 0 and tds_rate <= 100),
  notes                text,
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  created_by           uuid
);

alter table public.referral_partners enable row level security;
create policy referral_partners_select_own_tenant on public.referral_partners
  for select using (tenant_id = public.current_tenant_id());
create policy referral_partners_insert_own_tenant on public.referral_partners
  for insert with check (tenant_id = public.current_tenant_id());
create policy referral_partners_update_own_tenant on public.referral_partners
  for update using (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id());
create policy referral_partners_delete_own_tenant on public.referral_partners
  for delete using (tenant_id = public.current_tenant_id());
create policy referral_partners_service_role_all on public.referral_partners
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create index if not exists referral_partners_tenant_idx on public.referral_partners (tenant_id);
grant select, insert, update, delete on public.referral_partners to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- referral_agreements — partner tied to a customer's deal + commission terms
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.referral_agreements (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  partner_id      uuid not null references public.referral_partners(id) on delete restrict,
  customer_id     uuid references public.customers(id) on delete cascade,
  quote_id        text,                                             -- optional: the specific deal
  subscription_id uuid,                                             -- optional reference
  label           text,                                             -- e.g. "Google Workspace — 50 seats"
  basis           text not null default 'percent' check (basis in ('percent','fixed')),
  percent         numeric(5,2) default 10 check (percent >= 0 and percent <= 100),
  fixed_amount    integer default 0 check (fixed_amount >= 0),
  scope           text not null default 'one_time' check (scope in ('one_time','recurring')),
  deduct_tds      boolean not null default false,
  tds_rate        numeric(5,2) not null default 5 check (tds_rate >= 0 and tds_rate <= 100),
  status          text not null default 'active' check (status in ('active','closed','cancelled')),
  notes           text,
  created_at      timestamptz not null default now(),
  created_by      uuid
);

alter table public.referral_agreements enable row level security;
create policy referral_agreements_select_own_tenant on public.referral_agreements
  for select using (tenant_id = public.current_tenant_id());
create policy referral_agreements_insert_own_tenant on public.referral_agreements
  for insert with check (tenant_id = public.current_tenant_id());
create policy referral_agreements_update_own_tenant on public.referral_agreements
  for update using (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id());
create policy referral_agreements_delete_own_tenant on public.referral_agreements
  for delete using (tenant_id = public.current_tenant_id());
create policy referral_agreements_service_role_all on public.referral_agreements
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- At most ONE active agreement per customer (v1 simplification: one referrer per customer).
create unique index if not exists referral_agreements_one_active_per_customer
  on public.referral_agreements (tenant_id, customer_id)
  where status = 'active' and customer_id is not null;
create index if not exists referral_agreements_partner_idx on public.referral_agreements (tenant_id, partner_id);
grant select, insert, update, delete on public.referral_agreements to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- referral_commissions — earned entries (one per triggering payment)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.referral_commissions (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  agreement_id     uuid not null references public.referral_agreements(id) on delete cascade,
  partner_id       uuid not null references public.referral_partners(id) on delete restrict,
  customer_id      uuid,
  payment_id       uuid,                                            -- which payment accrued this (null for manual)
  base_amount      integer not null default 0,                     -- ex-GST deal value the commission is on
  basis            text not null,
  rate             numeric(5,2),                                    -- percent used (null for fixed)
  gross_commission integer not null default 0,
  tds_amount       integer not null default 0,
  net_payable      integer not null default 0,
  status           text not null default 'earned' check (status in ('earned','paid','cancelled')),
  earned_date      date not null default current_date,
  paid_date        date,
  pay_txn_id       uuid,
  notes            text,
  created_at       timestamptz not null default now()
);

alter table public.referral_commissions enable row level security;
create policy referral_commissions_select_own_tenant on public.referral_commissions
  for select using (tenant_id = public.current_tenant_id());
create policy referral_commissions_insert_own_tenant on public.referral_commissions
  for insert with check (tenant_id = public.current_tenant_id());
create policy referral_commissions_update_own_tenant on public.referral_commissions
  for update using (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id());
create policy referral_commissions_delete_own_tenant on public.referral_commissions
  for delete using (tenant_id = public.current_tenant_id());
create policy referral_commissions_service_role_all on public.referral_commissions
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create index if not exists referral_commissions_partner_idx on public.referral_commissions (tenant_id, partner_id);
create index if not exists referral_commissions_status_idx  on public.referral_commissions (tenant_id, status);
-- No double-accrual for the same (agreement, payment).
create unique index if not exists referral_commissions_unique_payment
  on public.referral_commissions (agreement_id, payment_id)
  where payment_id is not null;
grant select, insert, update, delete on public.referral_commissions to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Auto-accrual trigger — fires inside record_payment's transaction.
-- NON-FATAL: any failure is logged and swallowed so the customer payment survives.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_accrue_referral_commission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agr     public.referral_agreements%rowtype;
  v_taxrate numeric;
  v_base    integer;
  v_rate    numeric;
  v_gross   integer;
  v_tds     integer;
  v_exists  boolean;
begin
  -- Only real received payments accrue; refunds / non-received are ignored.
  if new.status is distinct from 'received' or new.refunded_at is not null or new.customer_id is null then
    return new;
  end if;

  begin
    -- Active agreement for this customer?
    select * into v_agr
    from public.referral_agreements
    where tenant_id = new.tenant_id
      and customer_id = new.customer_id
      and status = 'active'
    limit 1;
    if not found then
      return new;
    end if;

    -- one_time: only the first (non-cancelled) commission ever accrues.
    if v_agr.scope = 'one_time' then
      select exists(
        select 1 from public.referral_commissions
        where agreement_id = v_agr.id and status <> 'cancelled'
      ) into v_exists;
      if v_exists then
        return new;
      end if;
    end if;

    -- Ex-GST base from the payment's quote tax_rate (export → 0 → base = amount).
    select q.tax_rate into v_taxrate from public.quotes q where q.id = new.quote_id;
    if v_taxrate is null then v_taxrate := 18; end if;
    v_base := round(new.amount::numeric * 100.0 / (100.0 + v_taxrate))::integer;

    -- Commission amount.
    if v_agr.basis = 'percent' then
      v_rate  := coalesce(v_agr.percent, 0);
      v_gross := round(v_base::numeric * v_rate / 100.0)::integer;
    else
      v_rate  := null;
      v_gross := coalesce(v_agr.fixed_amount, 0);
    end if;

    if v_gross <= 0 then
      return new;
    end if;

    -- TDS 194H (per-agreement).
    if v_agr.deduct_tds then
      v_tds := round(v_gross::numeric * coalesce(v_agr.tds_rate, 5) / 100.0)::integer;
    else
      v_tds := 0;
    end if;

    insert into public.referral_commissions (
      tenant_id, agreement_id, partner_id, customer_id, payment_id,
      base_amount, basis, rate, gross_commission, tds_amount, net_payable,
      status, earned_date
    ) values (
      new.tenant_id, v_agr.id, v_agr.partner_id, new.customer_id, new.id,
      v_base, v_agr.basis, v_rate, v_gross, v_tds, v_gross - v_tds,
      'earned', current_date
    )
    on conflict (agreement_id, payment_id) where payment_id is not null do nothing;

  exception when others then
    -- Referral bookkeeping must NEVER block the customer's payment.
    raise warning 'referral commission accrual failed for payment %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;

drop trigger if exists trg_accrue_referral_commission on public.payments;
create trigger trg_accrue_referral_commission
  after insert on public.payments
  for each row execute function public.fn_accrue_referral_commission();

-- ─────────────────────────────────────────────────────────────────────────────
-- pay_referral_commission — pay a partner out of a bank account (atomic).
-- Debits the bank (money out) linked to the commission + marks it paid.
-- Mirrors pay_vendor_bill (0135): source='manual', reconciliation fills balance_after.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.pay_referral_commission(
  p_commission_id   uuid,
  p_bank_account_id uuid,
  p_paid_on         date default null,
  p_method          text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_comm   public.referral_commissions;
  v_pname  text;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;

  select * into v_comm from public.referral_commissions
   where id = p_commission_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Commission not found'; end if;
  if v_comm.status = 'paid' then raise exception 'Commission already paid'; end if;
  if v_comm.status = 'cancelled' then raise exception 'Commission is cancelled'; end if;

  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Pay-from account not found'; end if;

  select name into v_pname from public.referral_partners where id = v_comm.partner_id;

  -- Money leaves the bank (net of TDS), linked to the commission.
  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source,
     matched_to_type, matched_to_id, match_confidence, reference)
  values
    (v_tenant, p_bank_account_id, coalesce(p_paid_on, current_date),
     'Referral commission: ' || coalesce(v_pname, 'partner'), v_comm.net_payable, 0, 'manual',
     'referral_commission', p_commission_id::text, 'manual',
     nullif(trim(coalesce(p_method, '')), ''));

  update public.referral_commissions
     set status = 'paid', paid_date = coalesce(p_paid_on, current_date)
   where id = p_commission_id;
end;
$$;

grant execute on function public.pay_referral_commission(uuid, uuid, date, text) to authenticated;
