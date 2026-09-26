-- Regression test: book_bank_txn_as_expense sets both halves of the link
-- (migration 20260925180000). Self-asserting; ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/book_expense_reconciled_link.test.sql

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000a3', 'EXPLINK TEST', 'el@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000a0a3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'el-user@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000a0a3', 'aaaaaaaa-0000-0000-0000-0000000000a3', 'el-user@example.in', 'owner');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date) values
  ('aaaaaaaa-0000-0000-0000-0000000ba003', 'aaaaaaaa-0000-0000-0000-0000000000a3', 'Test HDFC', 'HDFC', 0, '2026-04-01');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  ('aaaaaaaa-0000-0000-0000-0000000b9001', 'aaaaaaaa-0000-0000-0000-0000000000a3', 'aaaaaaaa-0000-0000-0000-0000000ba003', '2026-07-16', 'RTGS DR-X-DIRECTOR', 200000, 0, 'manual');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000a0a3', 'role', 'authenticated')::text, true);

do $$
declare v_id text; v_exp public.expenses; v_txn public.bank_transactions;
begin
  v_id := public.book_bank_txn_as_expense('aaaaaaaa-0000-0000-0000-0000000b9001', 'Director''s Remuneration', 'Pardeep Sharma', 0, null);
  select * into v_exp from public.expenses where id = v_id;
  select * into v_txn from public.bank_transactions where id = 'aaaaaaaa-0000-0000-0000-0000000b9001';
  if v_txn.matched_to_type <> 'expense' or v_txn.matched_to_id <> v_id then
    raise exception 'FAIL 1: bank line not linked to the expense';
  end if;
  if v_exp.reconciled_txn_id is distinct from v_txn.id then
    raise exception 'FAIL 2: expense has no reverse link (reconciled_txn_id = %)', v_exp.reconciled_txn_id;
  end if;
  if v_exp.bank_account_id is distinct from v_txn.bank_account_id or not v_exp.paid or v_exp.paid_date <> '2026-07-16' then
    raise exception 'FAIL 3: paid / account not set: %', row_to_json(v_exp);
  end if;
  -- un-reconciling clears the reverse link (reconcile_bank_txn's existing behaviour)
  perform public.reconcile_bank_txn(v_txn.id, null, null, null);
  if (select reconciled_txn_id from public.expenses where id = v_id) is not null then
    raise exception 'FAIL 4: reverse link survived un-reconcile';
  end if;
end $$;

do $$ begin raise notice 'PASS: book_expense_reconciled_link'; end $$;
rollback;
