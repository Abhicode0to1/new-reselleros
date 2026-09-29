-- Regression test: TDS deductor pieces (migration 20260927130000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/tds_deductor.test.sql
--
-- What it proves:
--   1. vendors.pan takes a PAN-shaped value only.
--   2. pay_statutory_dues records the challan number and the month, and its synthetic
--      bank line quotes the challan.
--   3. book_bank_txn_as_statutory does the same against an imported line.
--   4. A malformed period is refused.
--   5. Only the new 5- / 7-argument signatures exist (no ambiguous overloads).

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000d1', 'TDS A', 'tds-a@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000d1a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tds-owner@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000d1a1', 'aaaaaaaa-0000-0000-0000-0000000000d1', 'tds-owner@example.in', 'owner');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date) values
  ('aaaaaaaa-0000-0000-0000-00000000ad1b', 'aaaaaaaa-0000-0000-0000-0000000000d1', 'HDFC', 'HDFC', 0, '2026-04-01');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  ('aaaaaaaa-0000-0000-0000-00000000d1b1', 'aaaaaaaa-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-00000000ad1b', '2026-09-07', 'TDS CHALLAN', 4000, 0, 'manual');

-- 1
do $$ begin
  insert into public.vendors (tenant_id, name, pan) values ('aaaaaaaa-0000-0000-0000-0000000000d1', 'Good PAN', 'ABCDE1234F');
  begin
    insert into public.vendors (tenant_id, name, pan) values ('aaaaaaaa-0000-0000-0000-0000000000d1', 'Bad PAN', 'abcde1234f');
    raise exception 'FAIL 1: lowercase / malformed PAN accepted';
  exception when check_violation then null;
  end;
end $$;

-- 5
do $$
declare n int;
begin
  select count(*) into n from pg_proc where proname = 'pay_statutory_dues';
  if n <> 1 then raise exception 'FAIL 5a: % overloads of pay_statutory_dues', n; end if;
  select count(*) into n from pg_proc where proname = 'book_bank_txn_as_statutory';
  if n <> 1 then raise exception 'FAIL 5b: % overloads of book_bank_txn_as_statutory', n; end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000d1a1', 'role', 'authenticated')::text, true);

do $$
declare r record; n int;
begin
  -- 2
  perform public.pay_statutory_dues(3000, 'tds', '2026-09-07', 'aaaaaaaa-0000-0000-0000-00000000ad1b', null, ' CIN-2609-0001 ', '2026-08');
  select * into r from public.statutory_dues_payments where kind = 'tds' and amount = 3000;
  if not found then raise exception 'FAIL 2a: no dues row'; end if;
  if r.challan_no <> 'CIN-2609-0001' or r.period <> '2026-08' then raise exception 'FAIL 2b: challan/period not stored (% / %)', r.challan_no, r.period; end if;
  select count(*) into n from public.bank_transactions where debit = 3000 and description like '%challan CIN-2609-0001%';
  if n <> 1 then raise exception 'FAIL 2c: bank line does not quote the challan'; end if;

  -- 3
  perform public.book_bank_txn_as_statutory('aaaaaaaa-0000-0000-0000-00000000d1b1', 'tds', null, 'CIN-2609-0002', '2026-08');
  select * into r from public.statutory_dues_payments where bank_txn_id = 'aaaaaaaa-0000-0000-0000-00000000d1b1';
  if not found or r.challan_no <> 'CIN-2609-0002' or r.period <> '2026-08' or r.amount <> 4000 then raise exception 'FAIL 3: booked line missing challan/period'; end if;

  -- 4
  begin
    perform public.pay_statutory_dues(100, 'pf', '2026-09-07', 'aaaaaaaa-0000-0000-0000-00000000ad1b', null, null, 'Aug 2026');
    raise exception 'FAIL 4: malformed period accepted';
  exception when check_violation then null;
  end;
end $$;

select 'tds_deductor: all assertions passed' as result;
rollback;
