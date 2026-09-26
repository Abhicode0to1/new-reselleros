-- Regression test: tax_payments + book_bank_txn_as_tax + reconcile_bank_txn reversal
-- (migration 20260925140000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/tax_payments.test.sql
--
-- What it proves:
--   1. GST with interest + late fee: tax row holds ONLY the tax; interest + late fee
--      become one "Rates & Taxes" expense tied to the same line; the line is reconciled.
--   2. TDS/PF/ESI totals are untouched — nothing lands in statutory_dues_payments.
--   3. Refusals: already reconciled, interest ≥ the line, bad / missing FY, missing month.
--   4. Un-reconcile removes the tax row AND its expense, and frees the line.
--   5. Another company's user cannot book this company's line.

begin;

-- ── Fixtures: two tenants, a user in each, one bank line in tenant A ────────
insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'TAX TEST A', 'tax-a@example.in', '07'),
  ('bbbbbbbb-0000-0000-0000-0000000000b1', 'TAX TEST B', 'tax-b@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000a0a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tax-a-user@example.in'),
  ('bbbbbbbb-0000-0000-0000-00000000b0b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tax-b-user@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000a0a1', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'tax-a-user@example.in', 'owner'),
  ('bbbbbbbb-0000-0000-0000-00000000b0b1', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'tax-b-user@example.in', 'owner');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date) values
  ('aaaaaaaa-0000-0000-0000-0000000ba001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'Test HDFC', 'HDFC', 0, '2026-04-01');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  ('aaaaaaaa-0000-0000-0000-0000000b7001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-0000000ba001', '2026-05-20', 'GST CHALLAN', 10150, 0, 'manual'),
  ('aaaaaaaa-0000-0000-0000-0000000b7002', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-0000000ba001', '2026-06-15', 'ADV TAX',     50000, 0, 'manual');

set local role authenticated;

-- ── 5. Tenant B cannot touch tenant A's line ─────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', 'bbbbbbbb-0000-0000-0000-00000000b0b1', 'role', 'authenticated')::text, true);
do $$ begin
  begin
    perform public.book_bank_txn_as_tax('aaaaaaaa-0000-0000-0000-0000000b7001', 'gst', '2026-04');
    raise exception 'FAIL 5: tenant B booked tenant A''s line';
  exception when others then
    if sqlerrm not like 'Bank line not found%' then raise exception 'FAIL 5: wrong error: %', sqlerrm; end if;
  end;
end $$;

-- ── Tenant A from here on ────────────────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);

-- 3. Refusals before anything is booked
do $$ begin
  begin
    perform public.book_bank_txn_as_tax('aaaaaaaa-0000-0000-0000-0000000b7001', 'gst', null);
    raise exception 'FAIL 3a: GST without a month was accepted';
  exception when others then
    if sqlerrm not like 'Pick the GST return month%' then raise exception 'FAIL 3a: wrong error: %', sqlerrm; end if;
  end;
  begin
    perform public.book_bank_txn_as_tax('aaaaaaaa-0000-0000-0000-0000000b7001', 'gst', '2026-04', null, 10000, 150);
    raise exception 'FAIL 3b: interest + late fee ≥ line was accepted';
  exception when others then
    if sqlerrm not like 'Interest + late fee%' then raise exception 'FAIL 3b: wrong error: %', sqlerrm; end if;
  end;
  begin
    perform public.book_bank_txn_as_tax('aaaaaaaa-0000-0000-0000-0000000b7002', 'advance_tax', null, '2026-28');
    raise exception 'FAIL 3c: FY 2026-28 was accepted';
  exception when others then
    if sqlerrm not like 'Pick the financial year%' then raise exception 'FAIL 3c: wrong error: %', sqlerrm; end if;
  end;
end $$;

-- 1. GST with interest + late fee
do $$
declare v_id uuid; v_tp public.tax_payments; v_exp public.expenses; v_txn public.bank_transactions;
begin
  v_id := public.book_bank_txn_as_tax('aaaaaaaa-0000-0000-0000-0000000b7001', 'gst', '2026-04', null, 100, 50, 'Apr return');
  select * into v_tp from public.tax_payments where id = v_id;
  if v_tp.amount <> 10000 or v_tp.interest <> 100 or v_tp.late_fee <> 50 or v_tp.period <> '2026-04' or v_tp.fy is not null then
    raise exception 'FAIL 1a: tax row %', row_to_json(v_tp);
  end if;
  select * into v_exp from public.expenses where id = v_tp.expense_id;
  if v_exp.amount <> 150 or v_exp.category <> 'Rates & Taxes' or v_exp.reconciled_txn_id <> 'aaaaaaaa-0000-0000-0000-0000000b7001' then
    raise exception 'FAIL 1b: expense %', row_to_json(v_exp);
  end if;
  select * into v_txn from public.bank_transactions where id = 'aaaaaaaa-0000-0000-0000-0000000b7001';
  if v_txn.matched_to_type <> 'statutory' or v_txn.matched_to_id <> v_id::text then
    raise exception 'FAIL 1c: line % / %', v_txn.matched_to_type, v_txn.matched_to_id;
  end if;
  -- 2. TDS/PF/ESI untouched
  if exists (select 1 from public.statutory_dues_payments where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000a1') then
    raise exception 'FAIL 2: a GST payment reached statutory_dues_payments';
  end if;
  -- 3d. Already reconciled
  begin
    perform public.book_bank_txn_as_tax('aaaaaaaa-0000-0000-0000-0000000b7001', 'gst', '2026-04');
    raise exception 'FAIL 3d: booked the same line twice';
  exception when others then
    if sqlerrm not like 'This bank line is already reconciled%' then raise exception 'FAIL 3d: wrong error: %', sqlerrm; end if;
  end;
end $$;

-- Advance tax: FY stored, no expense when there is no interest
do $$
declare v_id uuid; v_tp public.tax_payments;
begin
  v_id := public.book_bank_txn_as_tax('aaaaaaaa-0000-0000-0000-0000000b7002', 'advance_tax', null, '2026-27');
  select * into v_tp from public.tax_payments where id = v_id;
  if v_tp.amount <> 50000 or v_tp.fy <> '2026-27' or v_tp.period is not null or v_tp.expense_id is not null then
    raise exception 'FAIL advance tax row %', row_to_json(v_tp);
  end if;
end $$;

-- 4. Un-reconcile reverses the GST booking completely
do $$
declare v_exp_id text;
begin
  select expense_id into v_exp_id from public.tax_payments where bank_txn_id = 'aaaaaaaa-0000-0000-0000-0000000b7001';
  perform public.reconcile_bank_txn('aaaaaaaa-0000-0000-0000-0000000b7001', null, null, null);
  if exists (select 1 from public.tax_payments where bank_txn_id = 'aaaaaaaa-0000-0000-0000-0000000b7001') then
    raise exception 'FAIL 4a: tax row survived un-reconcile';
  end if;
  if exists (select 1 from public.expenses where id = v_exp_id) then
    raise exception 'FAIL 4b: interest/late-fee expense survived un-reconcile';
  end if;
  if (select matched_to_type from public.bank_transactions where id = 'aaaaaaaa-0000-0000-0000-0000000b7001') is not null then
    raise exception 'FAIL 4c: line still reconciled';
  end if;
  -- the other line's tax row is untouched
  if not exists (select 1 from public.tax_payments where bank_txn_id = 'aaaaaaaa-0000-0000-0000-0000000b7002') then
    raise exception 'FAIL 4d: un-reconciling one line removed another line''s tax row';
  end if;
end $$;

do $$ begin raise notice 'PASS: tax_payments'; end $$;
rollback;
