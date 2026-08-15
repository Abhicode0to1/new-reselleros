-- 0152 — Customer country, for export (international) customers.
--
-- Indian GST treats a supply to a recipient OUTSIDE India as an EXPORT: it is
-- zero-rated (no CGST/SGST/IGST) when the supplier has filed an LUT (Letter of
-- Undertaking). Until now every customer was implicitly domestic and the GST
-- head was derived purely from Indian state codes — a foreign customer (no
-- state code) was wrongly treated as intra-state (CGST+SGST).
--
-- This adds a `country` on customers (ISO-ish free text, default 'India'). A
-- customer whose country is anything other than India/IN is an EXPORT customer,
-- and downstream GST logic zero-rates the supply. The books stay in INR — the
-- foreign-currency amount is a capture/display concern handled separately.

alter table public.customers
  add column if not exists country text not null default 'India';

comment on column public.customers.country is
  'Recipient country. Anything other than India / IN marks an EXPORT (zero-rated) customer for GST.';
