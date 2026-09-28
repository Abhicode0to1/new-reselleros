-- ============================================================================
-- Google review requests.
--
-- Pardeep's Phase 2 (26 Sep 2026): after a customer is happy, ask them for a Google
-- review. A new customer looks at the Google Business Profile before anything else, and
-- the profile's review count is the only marketing asset that compounds for free.
--
--   1. marketing_tools.review_link — the "ask for reviews" short link from Google Business
--      Profile (g.page/r/…), stored on the company's google-business row.
--   2. review_requests — one row per ask (email sent by the app, or WhatsApp opened with a
--      prefilled message), so nobody is asked twice in a week and the owner can see who
--      has been asked.
--
-- review_requests cascade with the customer: an ask is not a financial record (contrast
-- the RESTRICT keys of 20260926130000).
-- ============================================================================

alter table public.marketing_tools add column if not exists review_link text;

comment on column public.marketing_tools.review_link is
  'Google Business Profile "ask for reviews" link (g.page/r/…). Only meaningful on tool_key = google-business.';

create table if not exists public.review_requests (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  channel     text not null check (channel in ('email', 'whatsapp')),
  sent_to     text,
  status      text not null check (status in ('sent', 'stubbed', 'failed', 'opened')),
  error       text,
  created_by  uuid,
  created_at  timestamptz not null default now()
);

comment on table public.review_requests is
  'Each time a customer was asked for a Google review. status opened = WhatsApp was opened with the message (the app cannot see if it was then sent).';

alter table public.review_requests enable row level security;

drop policy if exists "tenant isolation read" on public.review_requests;
create policy "tenant isolation read" on public.review_requests
  for select to authenticated using (tenant_id = public.current_tenant_id());
drop policy if exists "tenant isolation write" on public.review_requests;
create policy "tenant isolation write" on public.review_requests
  for insert to authenticated with check (tenant_id = public.current_tenant_id());
drop policy if exists zzz_service_role_all on public.review_requests;
create policy zzz_service_role_all on public.review_requests
  as permissive for all to service_role using (true) with check (true);

create index if not exists review_requests_customer_idx on public.review_requests (tenant_id, customer_id, created_at desc);
