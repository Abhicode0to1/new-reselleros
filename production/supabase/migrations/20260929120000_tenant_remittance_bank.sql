-- 20260929120000_tenant_remittance_bank.sql
--
-- R-038 / S27 (Pardeep, 29 Sep 2026) — the invoice PDF has no bank details.
--
-- Every tax invoice prints "UPI / NEFT / Razorpay accepted" and then gives the
-- customer nowhere to send an NEFT. A B2B buyer who wants to pay by transfer has to
-- ring and ask, which is a phone call per invoice and a day of delay on every one.
--
-- WHY NOT public.bank_accounts. That table exists and is the obvious candidate, and it
-- is the wrong one: it stores `account_number_last4`, deliberately, because it is a
-- LEDGER of accounts the business reconciles against. A customer needs the WHOLE
-- account number to make a transfer. The two are different facts — "the account we
-- keep books for" and "the account we ask to be paid into" — and conflating them would
-- either put a useless last-4 on a tax invoice or put full account numbers into a
-- reconciliation table that never needed them.
--
-- These live on `tenants` because they are the supplier's own published remittance
-- details, the same class of thing as `gstin` and `upi_vpa` beside them, and because
-- the invoice PDF already reads that row.
--
-- NOT SECRET. An account number and IFSC are printed on every invoice this company
-- sends; they are publication details, not credentials. They are deliberately NOT in
-- `tenant_secrets`, which would imply a confidentiality this data does not have and
-- would need a service-role read on a path that renders a customer-facing document.

begin;

alter table public.tenants
  add column if not exists remit_bank_name      text,
  add column if not exists remit_account_name   text,
  add column if not exists remit_account_number text,
  add column if not exists remit_ifsc           text,
  add column if not exists remit_branch         text;

comment on column public.tenants.remit_bank_name is
  'Bank shown on the invoice PDF for NEFT/RTGS, e.g. "HDFC Bank". R-038.';
comment on column public.tenants.remit_account_name is
  'Beneficiary name exactly as the bank holds it. Often but NOT always tenants.name — a '
  'transfer to a name that does not match is what gets bounced, so it is its own field.';
comment on column public.tenants.remit_account_number is
  'Full account number. Printed on customer-facing invoices, so this is publication data, '
  'not a secret — see the header of this migration for why it is not in tenant_secrets.';
comment on column public.tenants.remit_ifsc is
  'IFSC of the branch. 11 characters; not validated in the DB so a tenant is never '
  'locked out of saving a correct code this app has not heard of.';
comment on column public.tenants.remit_branch is
  'Optional branch name. Nothing depends on it; it is printed when present.';

commit;
