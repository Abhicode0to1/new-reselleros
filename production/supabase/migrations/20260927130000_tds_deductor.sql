-- TDS as a deductor (26Q) — the pieces the app had no home for (27 Sep 2026).
--
--   · vendors.pan — a deductee's PAN. Without it s.206AA says deduct at 20%; the 26Q
--     working used to guess it from the GSTIN and leave the rest blank. Backfilled from
--     a well-formed GSTIN (characters 3–12 ARE the PAN). The PAN's 4th letter also says
--     what the payee is (P individual, H HUF, C company, F firm…), which decides the
--     194C rate — so no separate "deductee type" column.
--   · statutory_dues_payments.challan_no / period — which month's TDS a challan paid,
--     and its CIN/challan number, so the 26Q can quote it and the payable can be shown
--     month-wise instead of one lump.
--   · Both booking RPCs take the two new fields. The old signatures are dropped first:
--     CREATE OR REPLACE with extra defaulted args would ADD an overload and make every
--     3-argument call ambiguous.

alter table public.vendors add column if not exists pan text;
alter table public.vendors drop constraint if exists vendors_pan_shape;
alter table public.vendors add constraint vendors_pan_shape
  check (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$');

update public.vendors
   set pan = upper(substr(gstin, 3, 10))
 where pan is null
   and gstin ~* '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$';

alter table public.statutory_dues_payments
  add column if not exists challan_no text,
  add column if not exists period text;
alter table public.statutory_dues_payments drop constraint if exists statutory_dues_period_shape;
alter table public.statutory_dues_payments add constraint statutory_dues_period_shape
  check (period is null or period ~ '^\d{4}-(0[1-9]|1[0-2])$');
alter table public.statutory_dues_payments drop constraint if exists statutory_dues_challan_len;
alter table public.statutory_dues_payments add constraint statutory_dues_challan_len
  check (challan_no is null or char_length(challan_no) <= 40);

drop function if exists public.book_bank_txn_as_statutory(uuid, text, text);
create or replace function public.book_bank_txn_as_statutory(
  p_txn_id uuid, p_kind text, p_notes text default null,
  p_challan_no text default null, p_period text default null
) returns void
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn public.bank_transactions;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  select * into v_txn from public.bank_transactions where id = p_txn_id and tenant_id = v_tenant;
  if not found then raise exception 'Bank transaction not found'; end if;
  if v_txn.matched_to_type is not null then raise exception 'This line is already reconciled'; end if;
  if coalesce(v_txn.debit,0) <= 0 then raise exception 'A statutory payment must be a money-out line'; end if;

  insert into public.statutory_dues_payments (tenant_id, kind, amount, paid_on, bank_account_id, notes, bank_txn_id, challan_no, period)
  values (v_tenant, coalesce(nullif(p_kind,''),'mixed'), v_txn.debit, v_txn.txn_date, v_txn.bank_account_id,
          nullif(trim(coalesce(p_notes,'')),''), p_txn_id,
          nullif(trim(coalesce(p_challan_no,'')),''), nullif(trim(coalesce(p_period,'')),''));

  update public.bank_transactions
     set matched_to_type='statutory', matched_to_id=null, match_confidence='manual',
         matched_at=now(), matched_by=auth.uid(), updated_at=now()
   where id = p_txn_id;
end; $$;
revoke execute on function public.book_bank_txn_as_statutory(uuid, text, text, text, text) from public, anon;
grant execute on function public.book_bank_txn_as_statutory(uuid, text, text, text, text) to authenticated, service_role;

drop function if exists public.pay_statutory_dues(integer, text, date, uuid, text);
create or replace function public.pay_statutory_dues(
  p_amount integer, p_kind text, p_paid_on date, p_bank_account_id uuid, p_notes text default null,
  p_challan_no text default null, p_period text default null
) returns void
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_acct   text;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be positive';
  end if;
  select name into v_acct from public.bank_accounts
    where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Account not found'; end if;

  insert into public.statutory_dues_payments (tenant_id, kind, amount, paid_on, bank_account_id, notes, challan_no, period)
  values (v_tenant, coalesce(nullif(p_kind, ''), 'mixed'), p_amount, p_paid_on, p_bank_account_id,
          nullif(trim(coalesce(p_notes, '')), ''),
          nullif(trim(coalesce(p_challan_no,'')),''), nullif(trim(coalesce(p_period,'')),''));

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
  values
    (v_tenant, p_bank_account_id, p_paid_on,
     'Statutory dues paid (' || coalesce(nullif(p_kind, ''), 'mixed') || ')'
       || case when nullif(trim(coalesce(p_challan_no,'')),'') is not null then ' · challan ' || trim(p_challan_no) else '' end,
     p_amount, 0, 'manual', 'manual', 'manual');
end;
$$;
revoke execute on function public.pay_statutory_dues(integer, text, date, uuid, text, text, text) from public, anon;
grant execute on function public.pay_statutory_dues(integer, text, date, uuid, text, text, text) to authenticated, service_role;
