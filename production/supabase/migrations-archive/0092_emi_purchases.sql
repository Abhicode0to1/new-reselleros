-- 0092: Assets bought on EMI / financing (e.g. a vehicle: part down, rest EMI).
--
-- Replaces the fiddly "add an asset line + a liability line + a bank entry, then
-- hand-edit the loan every month" flow with one record + a monthly "Pay EMI".
--
-- Accounting (books-lite, money-correct):
--   • Purchase: the item is a fixed ASSET at its total cost. The down payment
--     leaves a bank account (cash out). The financed part (total − down) is a
--     LIABILITY (loan payable), repaid via EMIs.
--   • EMI: the full instalment leaves the bank. Its PRINCIPAL part reduces the
--     loan liability; its INTEREST part is an expense (Interest). Identity:
--     cash_out = principal + interest, so it always balances.
--   • Balance Sheet auto-surfaces total asset cost (asset) and financed-minus-
--     principal-paid (liability). See balance-sheet.ts.
-- Both writes go through atomic, tenant-scoped SECURITY DEFINER RPCs.

create table if not exists public.emi_purchases (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  name            text not null,
  category        text not null default 'other' check (category in ('vehicle','equipment','furniture','property','other')),
  total_cost      integer not null check (total_cost > 0),
  down_payment    integer not null default 0 check (down_payment >= 0),
  financed        integer not null check (financed >= 0),
  emi_count       integer not null default 0 check (emi_count >= 0),
  emi_amount      integer not null default 0 check (emi_amount >= 0),
  purchased_on    date not null,
  down_account_id uuid references public.bank_accounts(id) on delete set null,
  lender          text,
  notes           text,
  status          text not null default 'active' check (status in ('active','closed')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references public.users(id) on delete set null
);

create table if not exists public.emi_payments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  purchase_id     uuid not null references public.emi_purchases(id) on delete cascade,
  amount          integer not null check (amount > 0),
  principal_part  integer not null check (principal_part >= 0),
  interest_part   integer not null default 0 check (interest_part >= 0),
  paid_on         date not null,
  bank_account_id uuid references public.bank_accounts(id) on delete set null,
  expense_id      text references public.expenses(id) on delete set null,
  notes           text,
  created_at      timestamptz not null default now()
);

create index if not exists emi_purchases_tenant_idx on public.emi_purchases(tenant_id, status);
create index if not exists emi_payments_purchase_idx on public.emi_payments(purchase_id);

alter table public.emi_purchases enable row level security;
alter table public.emi_payments  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['emi_purchases','emi_payments'] loop
    execute format('drop policy if exists "tenant isolation read"   on public.%I', t);
    execute format('drop policy if exists "tenant isolation write"  on public.%I', t);
    execute format('drop policy if exists "tenant isolation update" on public.%I', t);
    execute format('drop policy if exists "tenant isolation delete" on public.%I', t);
    execute format('create policy "tenant isolation read"   on public.%I for select using  (tenant_id = public.current_tenant_id())', t);
    execute format('create policy "tenant isolation write"  on public.%I for insert with check (tenant_id = public.current_tenant_id())', t);
    execute format('create policy "tenant isolation update" on public.%I for update using  (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id())', t);
    execute format('create policy "tenant isolation delete" on public.%I for delete using  (tenant_id = public.current_tenant_id())', t);
  end loop;
end $$;

-- ── Record a purchase: asset + down-payment cash out (atomic) ───────────────
create or replace function public.record_emi_purchase(
  p_name          text,
  p_category      text,
  p_total_cost    integer,
  p_down_payment  integer,
  p_emi_count     integer,
  p_emi_amount    integer,
  p_purchased_on  date,
  p_down_account  uuid,
  p_lender        text default null,
  p_notes         text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_id     uuid;
  v_down   integer := greatest(coalesce(p_down_payment, 0), 0);
  v_cat    text := coalesce(nullif(trim(p_category), ''), 'other');
  v_fin    integer;
begin
  if p_total_cost is null or p_total_cost <= 0 then raise exception 'Total cost must be positive'; end if;
  if trim(coalesce(p_name, '')) = '' then raise exception 'Name is required'; end if;
  if v_down > p_total_cost then raise exception 'Down payment cannot exceed total cost'; end if;
  v_fin := p_total_cost - v_down;

  if v_down > 0 then
    if p_down_account is null then raise exception 'Pick the account the down payment came from'; end if;
    perform 1 from public.bank_accounts where id = p_down_account and tenant_id = v_tenant;
    if not found then raise exception 'Down-payment account not found'; end if;
  end if;

  insert into public.emi_purchases
    (tenant_id, name, category, total_cost, down_payment, financed, emi_count, emi_amount, purchased_on, down_account_id, lender, notes, status, created_by)
  values
    (v_tenant, trim(p_name), v_cat, p_total_cost, v_down, v_fin,
     greatest(coalesce(p_emi_count,0),0), greatest(coalesce(p_emi_amount,0),0), p_purchased_on, p_down_account,
     nullif(trim(coalesce(p_lender,'')),''), nullif(trim(coalesce(p_notes,'')),''),
     case when v_fin <= 0 then 'closed' else 'active' end, auth.uid())
  returning id into v_id;

  if v_down > 0 then
    insert into public.bank_transactions
      (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
    values
      (v_tenant, p_down_account, p_purchased_on, 'Purchase: ' || trim(p_name) || ' (down payment)', v_down, 0, 'manual', 'manual', 'manual');
  end if;

  return v_id;
end;
$$;

grant execute on function public.record_emi_purchase(text, text, integer, integer, integer, integer, date, uuid, text, text) to authenticated;

-- ── Pay one EMI: cash out (full) + principal reduces loan, interest = expense ─
create or replace function public.record_emi_payment(
  p_purchase_id   uuid,
  p_amount        integer,
  p_interest      integer,
  p_paid_on       date,
  p_bank_account_id uuid,
  p_notes         text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_p        public.emi_purchases;
  v_paidprin integer;
  v_outstd   integer;
  v_int      integer := greatest(coalesce(p_interest, 0), 0);
  v_prin     integer;
  v_exp_id   text;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'EMI amount must be positive'; end if;
  v_prin := p_amount - v_int;
  if v_prin < 0 then raise exception 'Interest cannot exceed the EMI amount'; end if;

  select * into v_p from public.emi_purchases where id = p_purchase_id and tenant_id = v_tenant;
  if not found then raise exception 'Purchase not found'; end if;

  select coalesce(sum(principal_part), 0) into v_paidprin from public.emi_payments where purchase_id = p_purchase_id;
  v_outstd := v_p.financed - v_paidprin;
  if v_prin > v_outstd then raise exception 'Principal part (%) exceeds outstanding loan (%)', v_prin, v_outstd; end if;

  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Pay-from account not found'; end if;

  -- Interest portion → an expense (no separate cash leg; the EMI debit below covers it).
  if v_int > 0 then
    v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int));
    insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
    values (v_exp_id, v_tenant, 'Interest', coalesce(v_p.lender, v_p.name), p_paid_on, v_int, 0, 'emi', 'EMI interest — ' || v_p.name);
  end if;

  insert into public.emi_payments
    (tenant_id, purchase_id, amount, principal_part, interest_part, paid_on, bank_account_id, expense_id, notes)
  values
    (v_tenant, p_purchase_id, p_amount, v_prin, v_int, p_paid_on, p_bank_account_id, v_exp_id, nullif(trim(coalesce(p_notes,'')),''));

  -- Full instalment leaves the bank.
  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
  values
    (v_tenant, p_bank_account_id, p_paid_on, 'EMI: ' || v_p.name, p_amount, 0, 'manual', 'manual', 'manual');

  update public.emi_purchases
     set status = case when (v_outstd - v_prin) <= 0 then 'closed' else 'active' end, updated_at = now()
   where id = p_purchase_id;
end;
$$;

grant execute on function public.record_emi_payment(uuid, integer, integer, date, uuid, text) to authenticated;
