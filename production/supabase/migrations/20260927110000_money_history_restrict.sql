-- ============================================================================
-- Deleting an employee or a bank account must not take its money history with it.
--
-- 27 Sep 2026 audit (accounting, critical #5):
--   salary_payments.employee_id       ON DELETE CASCADE  → payroll history and 24Q data gone
--   project_labour.employee_id        ON DELETE CASCADE  → project cost (P&L) silently drops
--   expense_claims.employee_id        ON DELETE CASCADE  → money owed to / by a person gone
--   bank_transactions.bank_account_id ON DELETE CASCADE  → the bank statement itself gone,
--                                                          and everything reconciled to it
--   delete_bank_account() deleted with no check at all.
--
-- These become RESTRICT, and a BEFORE DELETE trigger on employees / bank_accounts says in
-- plain words what is holding the delete, so the screen shows a reason instead of a raw
-- foreign-key error. The way out is the same as in any accounts package: deactivate
-- (employees.status, bank_accounts.is_active), never delete once money has moved.
--
-- Left as CASCADE on purpose: attendance, leave_entries, employee_documents (HR records,
-- no rupees), bank_aa_connections (a consent handle, re-creatable).
-- ============================================================================

alter table public.salary_payments   drop constraint if exists salary_payments_employee_id_fkey;
alter table public.salary_payments   add  constraint salary_payments_employee_id_fkey
  foreign key (employee_id) references public.employees(id) on delete restrict;

alter table public.project_labour    drop constraint if exists project_labour_employee_id_fkey;
alter table public.project_labour    add  constraint project_labour_employee_id_fkey
  foreign key (employee_id) references public.employees(id) on delete restrict;

alter table public.expense_claims    drop constraint if exists expense_claims_employee_id_fkey;
alter table public.expense_claims    add  constraint expense_claims_employee_id_fkey
  foreign key (employee_id) references public.employees(id) on delete restrict;

alter table public.bank_transactions drop constraint if exists bank_transactions_bank_account_id_fkey;
alter table public.bank_transactions add  constraint bank_transactions_bank_account_id_fkey
  foreign key (bank_account_id) references public.bank_accounts(id) on delete restrict;

-- ── Plain-words refusals ─────────────────────────────────────────────────────
create or replace function public.tg_employee_delete_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare n_sal int; n_lab int; n_claim int;
begin
  select count(*) into n_sal   from public.salary_payments where employee_id = old.id;
  select count(*) into n_lab   from public.project_labour  where employee_id = old.id;
  select count(*) into n_claim from public.expense_claims  where employee_id = old.id;
  if n_sal + n_lab + n_claim > 0 then
    raise exception 'Is employee ka hisaab hai — % salary, % project labour, % expense claim. Delete nahi, "Inactive" karo; payroll aur 24Q ka record rehna chahiye.',
      n_sal, n_lab, n_claim using errcode = 'foreign_key_violation';
  end if;
  return old;
end $$;

drop trigger if exists trg_employee_delete_guard on public.employees;
create trigger trg_employee_delete_guard
  before delete on public.employees
  for each row execute function public.tg_employee_delete_guard();

create or replace function public.tg_bank_account_delete_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare n_txn int;
begin
  select count(*) into n_txn from public.bank_transactions where bank_account_id = old.id;
  if n_txn > 0 then
    raise exception 'Is account mein % bank lines hain. Delete nahi, account ko inactive karo — statement aur reconciliation ka record rehna chahiye.',
      n_txn using errcode = 'foreign_key_violation';
  end if;
  return old;
end $$;

drop trigger if exists trg_bank_account_delete_guard on public.bank_accounts;
create trigger trg_bank_account_delete_guard
  before delete on public.bank_accounts
  for each row execute function public.tg_bank_account_delete_guard();
