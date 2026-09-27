-- ============================================================================
-- Period lock: books closed up to a date cannot be changed from the app.
--
-- 27 Sep 2026 audit (accounting #16): nothing stopped an expense, bank line, salary, tax
-- payment or invoice in a filed month — or a past FY — from being edited or deleted. Once
-- GSTR-3B / TDS returns are filed, the books for that period must match what was filed.
--
-- tenants.books_locked_until — the owner sets it (Accounting → Overview). Any row on a money
-- table whose date is on or before that day can no longer be inserted, updated or deleted
-- by a PostgREST caller (anon / authenticated), whether directly or through a SECURITY
-- DEFINER RPC the caller ran: the check reads the JWT role, not the database role. The
-- service role (crons, webhooks, migrations) and direct psql sessions are not blocked.
-- An UPDATE is checked on both the old and the new date, so a row cannot be moved out of
-- a locked month either.
--
-- The lock covers every money table, including Billing's (invoices, payments,
-- project_payments, credit / debit notes): a lock that leaves invoices open is not a lock.
-- The trigger only reads a date and the tenant's lock; it changes no Billing code.
-- Raised on the team board for Abhishek's review.
-- ============================================================================

alter table public.tenants add column if not exists books_locked_until date;

comment on column public.tenants.books_locked_until is
  'Books are closed up to and including this date: money rows dated on or before it cannot be inserted, updated or deleted from the app. NULL = no lock.';

create or replace function public.tg_books_locked()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_col   text := tg_argv[0];
  v_lock  date;
  v_old   date;
  v_new   date;
  v_tenant uuid;
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if tg_op in ('UPDATE', 'DELETE') then
    v_old := left(to_jsonb(old) ->> v_col, 10)::date;
    v_tenant := (to_jsonb(old) ->> 'tenant_id')::uuid;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_new := left(to_jsonb(new) ->> v_col, 10)::date;
    v_tenant := coalesce(v_tenant, (to_jsonb(new) ->> 'tenant_id')::uuid);
  end if;

  select books_locked_until into v_lock from public.tenants where id = v_tenant;
  if v_lock is not null and ((v_old is not null and v_old <= v_lock) or (v_new is not null and v_new <= v_lock)) then
    raise exception 'Books % tak lock hain (% · %). Us tareekh tak ki entry badal nahi sakti — pehle Accounting → Overview par lock hatao, ya entry ko baad ki tareekh par karo.',
      to_char(v_lock, 'DD Mon YYYY'), tg_table_name, coalesce(v_old, v_new)
      using errcode = 'check_violation';
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

do $$
declare
  t record;
begin
  for t in
    select * from (values
      ('expenses',                'expense_date'),
      ('bank_transactions',       'txn_date'),
      ('salary_payments',         'pay_date'),
      ('tax_payments',            'paid_on'),
      ('statutory_dues_payments', 'paid_on'),
      ('tds_receivable',          'payment_received_date'),
      ('prepaid_advances',        'paid_date'),
      ('vendor_bills',            'bill_date'),
      ('referral_commissions',    'earned_date'),
      ('invoices',                'invoice_date'),
      ('payments',                'received_at'),
      ('project_payments',        'received_at'),
      ('credit_notes',            'credit_date'),
      ('debit_notes',             'debit_date')
    ) as v(tbl, col)
  loop
    execute format('drop trigger if exists trg_books_lock on public.%I', t.tbl);
    execute format(
      'create trigger trg_books_lock before insert or update or delete on public.%I for each row execute function public.tg_books_locked(%L)',
      t.tbl, t.col);
  end loop;
end $$;
