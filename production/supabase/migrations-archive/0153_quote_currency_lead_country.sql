-- 0153 — Foreign currency on quotes + country on leads (international clients).
--
-- BOOKS STAY IN INR. The money-spine (quote.amount, payments, MRR, invoices,
-- P&L, balance sheet) is all integer ₹ and is NOT changed. Foreign currency is
-- a CAPTURE + DISPLAY layer only:
--
--   • quotes.currency       — the currency the customer is billed in (e.g. 'USD').
--                             'INR' (default) = a normal domestic quote.
--   • quotes.exchange_rate  — INR per 1 unit of `currency` (e.g. 83.00 for USD).
--                             1 for INR. The foreign amount shown to the customer
--                             is derived: foreign = amount / exchange_rate. The
--                             stored `amount` remains the canonical ₹ figure.
--
--   • leads.country         — so a PROSPECT quote (no customer record yet) can be
--                             detected as an export (zero-rated) too, mirroring
--                             customers.country (migration 0152).

alter table public.quotes
  add column if not exists currency      text    not null default 'INR',
  add column if not exists exchange_rate numeric not null default 1;

alter table public.quotes drop constraint if exists quotes_exchange_rate_positive;
alter table public.quotes
  add constraint quotes_exchange_rate_positive check (exchange_rate > 0) not valid;

alter table public.leads
  add column if not exists country text not null default 'India';

comment on column public.quotes.currency      is 'Billing currency (ISO, e.g. USD). INR = domestic. Books stay INR; this is display-only.';
comment on column public.quotes.exchange_rate is 'INR per 1 unit of currency (e.g. 83 for USD). foreign_amount = amount / exchange_rate.';
comment on column public.leads.country        is 'Prospect country. Non-India marks an export (zero-rated) prospect, mirroring customers.country.';
