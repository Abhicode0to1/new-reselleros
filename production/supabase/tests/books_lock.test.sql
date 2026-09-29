-- Regression test: period lock (migration 20260927120000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/books_lock.test.sql
--
-- What it proves (books locked till 31 Aug 2026, caller = the company's owner):
--   1. An expense dated inside the lock cannot be inserted; one dated after it can.
--   2. An existing locked expense cannot be updated, moved to a later date, or deleted.
--   3. The same holds on a bank line and on an invoice (Billing's table).
--   4. With no lock, everything above is allowed again.
--   5. Another company's lock does not affect this company.

begin;

insert into public.tenants (id, name, email, state_code, books_locked_until) values
  ('aaaaaaaa-0000-0000-0000-0000000000b1', 'LOCK A', 'lk-a@example.in', '07', '2026-08-31'),
  ('bbbbbbbb-0000-0000-0000-0000000000b1', 'LOCK B', 'lk-b@example.in', '07', '2026-12-31');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000b1a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'lk-owner@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000b1a1', 'aaaaaaaa-0000-0000-0000-0000000000b1', 'lk-owner@example.in', 'owner');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date) values
  ('aaaaaaaa-0000-0000-0000-00000000ab1b', 'aaaaaaaa-0000-0000-0000-0000000000b1', 'HDFC', 'HDFC', 0, '2026-04-01');
-- rows inside the locked period, written by the system (no JWT → not blocked)
insert into public.expenses (id, tenant_id, category, amount, expense_date) values
  ('EXP-LOCK-AUG', 'aaaaaaaa-0000-0000-0000-0000000000b1', 'Office Rent', 10000, '2026-08-10');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  ('aaaaaaaa-0000-0000-0000-00000000b1b1', 'aaaaaaaa-0000-0000-0000-0000000000b1', 'aaaaaaaa-0000-0000-0000-00000000ab1b', '2026-08-10', 'RENT', 10000, 0, 'manual');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000b1a1', 'role', 'authenticated')::text, true);

do $$
declare n int;
begin
  -- 1
  begin
    insert into public.expenses (id, tenant_id, category, amount, expense_date)
    values ('EXP-LOCK-NEW-AUG', 'aaaaaaaa-0000-0000-0000-0000000000b1', 'Software', 500, '2026-08-31');
    raise exception 'FAIL 1a: insert inside the lock went through';
  exception when check_violation then null;
  end;
  insert into public.expenses (id, tenant_id, category, amount, expense_date)
  values ('EXP-LOCK-SEP', 'aaaaaaaa-0000-0000-0000-0000000000b1', 'Software', 500, '2026-09-01');

  -- 2
  begin
    update public.expenses set amount = 99999 where id = 'EXP-LOCK-AUG';
    raise exception 'FAIL 2a: locked expense updated';
  exception when check_violation then null;
  end;
  begin
    update public.expenses set expense_date = '2026-09-15' where id = 'EXP-LOCK-AUG';
    raise exception 'FAIL 2b: locked expense moved out of the period';
  exception when check_violation then null;
  end;
  begin
    delete from public.expenses where id = 'EXP-LOCK-AUG';
    raise exception 'FAIL 2c: locked expense deleted';
  exception when check_violation then null;
  end;
  -- and a September row moved INTO the lock is refused too
  begin
    update public.expenses set expense_date = '2026-08-20' where id = 'EXP-LOCK-SEP';
    raise exception 'FAIL 2d: a row was moved into the locked period';
  exception when check_violation then null;
  end;

  -- 3
  begin
    delete from public.bank_transactions where id = 'aaaaaaaa-0000-0000-0000-00000000b1b1';
    raise exception 'FAIL 3a: locked bank line deleted';
  exception when check_violation then null;
  end;
  begin
    insert into public.invoices (id, tenant_id, customer_name, amount, invoice_date, due_date, status)
    values ('INV-LOCK-AUG', 'aaaaaaaa-0000-0000-0000-0000000000b1', 'Cust', 1180, '2026-08-05', '2026-09-04', 'draft');
    raise exception 'FAIL 3b: invoice inserted inside the lock';
  exception when check_violation then null;
  end;

  select count(*) into n from public.expenses where id = 'EXP-LOCK-AUG' and amount = 10000;
  if n <> 1 then raise exception 'FAIL: the locked row changed anyway'; end if;
end $$;

-- 4. Lock removed → allowed
reset role;
update public.tenants set books_locked_until = null where id = 'aaaaaaaa-0000-0000-0000-0000000000b1';
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000b1a1', 'role', 'authenticated')::text, true);
do $$ begin
  update public.expenses set amount = 12000 where id = 'EXP-LOCK-AUG';
  delete from public.expenses where id = 'EXP-LOCK-AUG';
  if exists (select 1 from public.expenses where id = 'EXP-LOCK-AUG') then raise exception 'FAIL 4: still locked after the lock was cleared'; end if;
end $$;

-- 5. B's Dec lock never touched A (A's September insert above succeeded while B was locked to Dec)
select 'books_lock: all assertions passed' as result;
rollback;
