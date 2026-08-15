-- 0082: tag a payment with the bank account it was received into.
--
-- OPTIONAL (nullable). This is a reporting + reconciliation aid only — it does
-- NOT move any bank balance. The actual bank balance stays driven by the
-- bank_transactions ledger (statement import → reconcile), so recording a
-- payment against an account never double-counts against a later statement
-- import. When the operator later imports the statement, the reconcile
-- match-suggester can prioritise payments already tagged to that account.

alter table public.payments
  add column if not exists bank_account_id uuid
    references public.bank_accounts(id) on delete set null;

create index if not exists idx_payments_bank_account
  on public.payments(bank_account_id);

comment on column public.payments.bank_account_id is
  'Optional: which of the tenant''s bank_accounts received this payment. Reporting/reconciliation aid only — does not affect any computed balance.';
