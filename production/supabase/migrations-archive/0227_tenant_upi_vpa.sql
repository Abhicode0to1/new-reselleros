-- 0227_tenant_upi_vpa.sql
--
-- The reseller's own UPI ID, so invoices can carry a scannable QR.
--
-- WHY THIS AND NOT A RAZORPAY QR: a `upi://pay` intent is understood by every
-- UPI app and needs nothing but this VPA — so it ships today rather than
-- waiting on Razorpay KYC, and getting paid sooner is the point. The honest
-- trade-off is that money lands straight in the bank, so there is no gateway
-- webhook to auto-reconcile it; the operator still records the payment. A
-- gateway QR can be added later without changing this column.
--
-- `upi_payee_name` is separate from `tenants.name` on purpose: the name shown
-- in the payer's UPI app must match the account the VPA belongs to, which for
-- a proprietor is often their personal name rather than the trading name. If
-- those differ the payer sees an unexpected name at the moment of paying, which
-- is exactly when they abandon.
--
-- Format is validated in the app (lib/payments/upi.ts, 15 tests) rather than by
-- a CHECK: VPA handle rules vary by PSP and a too-strict constraint would lock
-- out a legitimate reseller with no way around it.
--
-- Idempotent: safe to re-run.

alter table public.tenants
  add column if not exists upi_vpa        text,
  add column if not exists upi_payee_name text;

comment on column public.tenants.upi_vpa is
  'Reseller UPI ID (e.g. name@okhdfcbank) used to build the upi://pay QR on invoices. NULL = no QR is printed.';
comment on column public.tenants.upi_payee_name is
  'Name shown in the payer''s UPI app. Falls back to tenants.name when NULL; set it when the bank account name differs from the trading name.';
