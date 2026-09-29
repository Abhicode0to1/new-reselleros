-- Reverse charge on imported services (27 Sep 2026).
--
-- Google Ireland, Meta Platforms Ireland, AWS, OpenAI… invoice without GST. The Indian
-- buyer pays the IGST himself under reverse charge (IGST Act s.5(3)/5(4) + Notification
-- 10/2017-IT(R): import of services), in CASH in GSTR-3B Table 3.1(d), and takes the same
-- amount back as credit in Table 4(A)(3). The books had no way to say "this bill is under
-- RCM", so those bills sat outside the GST return entirely.
--
--   rcm      — this expense is an inward supply liable to reverse charge
--   rcm_tax  — the IGST self-assessed on it (whole ₹), computed by the form at the
--              standard 18% on the ₹ amount, editable; stored so the return does not
--              change if the rate table does

alter table public.expenses
  add column if not exists rcm boolean not null default false,
  add column if not exists rcm_tax integer not null default 0;
alter table public.expenses drop constraint if exists expenses_rcm_tax_nonneg;
alter table public.expenses add constraint expenses_rcm_tax_nonneg check (rcm_tax >= 0);
alter table public.expenses drop constraint if exists expenses_rcm_tax_only_when_rcm;
alter table public.expenses add constraint expenses_rcm_tax_only_when_rcm check (rcm or rcm_tax = 0);

create index if not exists expenses_rcm_idx on public.expenses (tenant_id, expense_date) where rcm;
