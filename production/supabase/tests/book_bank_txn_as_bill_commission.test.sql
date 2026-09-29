-- Regression test: bill / commission paid from an imported bank line (migration 20260927190000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/book_bank_txn_as_bill_commission.test.sql
--
-- What it proves (caller = the company's owner):
--   1. Booking an imported line against an unpaid bill marks the bill partial/paid and
--      reconciles THAT line — no new bank line appears.
--   2. When the Bills page had already paid it (synthetic line), booking the imported
--      line REMOVES the synthetic one and leaves the bill's paid amount alone.
--   3. A line larger than the outstanding is refused.
--   4. Same for a referral commission: exact amount only; synthetic replaced; pay_txn_id set.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000d5', 'BILLPAY A', 'bp-a@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000d5a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'bp-owner@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000d5a1', 'aaaaaaaa-0000-0000-0000-0000000000d5', 'bp-owner@example.in', 'owner');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date) values
  ('aaaaaaaa-0000-0000-0000-00000000ad5b', 'aaaaaaaa-0000-0000-0000-0000000000d5', 'HDFC', 'HDFC', 0, '2026-04-01');
insert into public.vendor_bills (id, tenant_id, vendor_name, bill_date, subtotal, cgst, sgst, igst, total, paid_amount, status, category) values
  ('BILL-BP-1', 'aaaaaaaa-0000-0000-0000-0000000000d5', 'Google Cloud', '2026-09-01', 10000, 900, 900, 0, 11800, 0, 'unpaid', 'COGS-Workspace'),
  ('BILL-BP-2', 'aaaaaaaa-0000-0000-0000-0000000000d5', 'Zoho', '2026-09-01', 5000, 450, 450, 0, 5900, 0, 'unpaid', 'COGS-Zoho');
insert into public.referral_partners (id, tenant_id, name) values
  ('aaaaaaaa-0000-0000-0000-00000000d5f1', 'aaaaaaaa-0000-0000-0000-0000000000d5', 'Ravi Agent');
insert into public.referral_agreements (id, tenant_id, partner_id, basis, percent, deduct_tds, tds_rate) values
  ('aaaaaaaa-0000-0000-0000-00000000d5a9', 'aaaaaaaa-0000-0000-0000-0000000000d5', 'aaaaaaaa-0000-0000-0000-00000000d5f1', 'percent', 10, true, 2);
insert into public.referral_commissions (id, tenant_id, agreement_id, partner_id, base_amount, basis, rate, gross_commission, tds_amount, net_payable, status, earned_date) values
  ('aaaaaaaa-0000-0000-0000-00000000d5c1', 'aaaaaaaa-0000-0000-0000-0000000000d5', 'aaaaaaaa-0000-0000-0000-00000000d5a9', 'aaaaaaaa-0000-0000-0000-00000000d5f1', 100000, 'percent', 10, 10000, 200, 9800, 'earned', '2026-09-05');
-- imported statement lines
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  ('aaaaaaaa-0000-0000-0000-00000000d5b1', 'aaaaaaaa-0000-0000-0000-0000000000d5', 'aaaaaaaa-0000-0000-0000-00000000ad5b', '2026-09-10', 'NEFT GOOGLE', 5000, 0, 'csv_upload'),
  ('aaaaaaaa-0000-0000-0000-00000000d5b2', 'aaaaaaaa-0000-0000-0000-0000000000d5', 'aaaaaaaa-0000-0000-0000-00000000ad5b', '2026-09-12', 'NEFT ZOHO', 5900, 0, 'csv_upload'),
  ('aaaaaaaa-0000-0000-0000-00000000d5b3', 'aaaaaaaa-0000-0000-0000-0000000000d5', 'aaaaaaaa-0000-0000-0000-00000000ad5b', '2026-09-15', 'IMPS RAVI', 9800, 0, 'csv_upload'),
  ('aaaaaaaa-0000-0000-0000-00000000d5b4', 'aaaaaaaa-0000-0000-0000-0000000000d5', 'aaaaaaaa-0000-0000-0000-00000000ad5b', '2026-09-16', 'NEFT GOOGLE BIG', 20000, 0, 'csv_upload');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000d5a1', 'role', 'authenticated')::text, true);

do $$
declare n int; r record; before int;
begin
  select count(*) into before from public.bank_transactions where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000d5';

  -- 1: partial payment against BILL-BP-1
  perform public.book_bank_txn_as_vendor_bill('aaaaaaaa-0000-0000-0000-00000000d5b1', 'BILL-BP-1', 'NEFT');
  select * into r from public.vendor_bills where id = 'BILL-BP-1';
  if r.paid_amount <> 5000 or r.status <> 'partial' then raise exception 'FAIL 1a: bill not partial (% / %)', r.paid_amount, r.status; end if;
  select * into r from public.bank_transactions where id = 'aaaaaaaa-0000-0000-0000-00000000d5b1';
  if r.matched_to_type <> 'vendor_bill' or r.matched_to_id <> 'BILL-BP-1' then raise exception 'FAIL 1b: line not reconciled to the bill'; end if;
  select count(*) into n from public.bank_transactions where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000d5';
  if n <> before then raise exception 'FAIL 1c: a bank line was added'; end if;

  -- 3: too big
  begin
    perform public.book_bank_txn_as_vendor_bill('aaaaaaaa-0000-0000-0000-00000000d5b4', 'BILL-BP-1');
    raise exception 'FAIL 3: line above outstanding accepted';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if;
  end;

  -- 2: Bills page already paid BILL-BP-2 (synthetic line), then the statement arrives
  perform public.pay_vendor_bill('BILL-BP-2', 5900, '2026-09-12', 'aaaaaaaa-0000-0000-0000-00000000ad5b', 'NEFT');
  select count(*) into n from public.bank_transactions where matched_to_type = 'vendor_bill' and matched_to_id = 'BILL-BP-2' and source = 'manual';
  if n <> 1 then raise exception 'FAIL 2a: expected one synthetic line'; end if;
  perform public.book_bank_txn_as_vendor_bill('aaaaaaaa-0000-0000-0000-00000000d5b2', 'BILL-BP-2');
  select count(*) into n from public.bank_transactions where matched_to_type = 'vendor_bill' and matched_to_id = 'BILL-BP-2';
  if n <> 1 then raise exception 'FAIL 2b: synthetic line not replaced (% lines)', n; end if;
  select * into r from public.bank_transactions where matched_to_type = 'vendor_bill' and matched_to_id = 'BILL-BP-2';
  if r.source <> 'csv_upload' then raise exception 'FAIL 2c: the imported line should be the one that stays'; end if;
  select * into r from public.vendor_bills where id = 'BILL-BP-2';
  if r.paid_amount <> 5900 or r.status <> 'paid' then raise exception 'FAIL 2d: bill double-counted (%)', r.paid_amount; end if;

  -- 4: commission
  begin
    perform public.book_bank_txn_as_referral_commission('aaaaaaaa-0000-0000-0000-00000000d5b1', 'aaaaaaaa-0000-0000-0000-00000000d5c1');
    raise exception 'FAIL 4a: already-reconciled line accepted';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if;
  end;
  perform public.pay_referral_commission('aaaaaaaa-0000-0000-0000-00000000d5c1', 'aaaaaaaa-0000-0000-0000-00000000ad5b', '2026-09-15', 'IMPS');
  perform public.book_bank_txn_as_referral_commission('aaaaaaaa-0000-0000-0000-00000000d5b3', 'aaaaaaaa-0000-0000-0000-00000000d5c1');
  select count(*) into n from public.bank_transactions where matched_to_type = 'referral_commission' and matched_to_id = 'aaaaaaaa-0000-0000-0000-00000000d5c1';
  if n <> 1 then raise exception 'FAIL 4b: commission synthetic line not replaced (%)', n; end if;
  select * into r from public.referral_commissions where id = 'aaaaaaaa-0000-0000-0000-00000000d5c1';
  if r.status <> 'paid' or r.pay_txn_id <> 'aaaaaaaa-0000-0000-0000-00000000d5b3' then raise exception 'FAIL 4c: commission not linked to the imported line'; end if;
end $$;

select 'book_bank_txn_as_bill_commission: all assertions passed' as result;
rollback;
