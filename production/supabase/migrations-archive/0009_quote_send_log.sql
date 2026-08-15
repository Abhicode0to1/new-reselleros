-- ============================================================
-- ResellerOS — quote send audit
-- Migration: 0009_quote_send_log.sql
-- ============================================================
-- Purpose
--   Records every time a quote is emailed to a customer via the
--   /api/quotes/[id]/send route. Distinct from renewal_email_log
--   (which audits cadence emails) — this covers the *first* send +
--   any resends the operator initiates manually.
--
-- Status semantics (matches lib/email/send.ts return):
--   sent     — Resend accepted and returned a message ID
--   stubbed  — RESEND_API_KEY not configured, no real send
--   failed   — Resend rejected / network error
--
-- The quote.status column continues to be the source of truth for the
-- lifecycle (draft → sent → viewed → accepted). This log table only
-- records WHEN the send happened, to whom, and via what provider.
-- A successful send always flips quote.status from 'draft' to 'sent'
-- inside the same request handler.
-- ============================================================

begin;

create table if not exists public.quote_send_log (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  quote_id        text not null references public.quotes(id) on delete cascade,
  recipient_email text not null,
  cc_emails       text[],
  subject         text,
  status          text not null check (status in ('sent','stubbed','failed')),
  provider_id     text,       -- Resend message ID when real send
  error_message   text,
  sent_by         uuid references public.users(id) on delete set null,
  sent_at         timestamptz not null default now()
);

create index if not exists quote_send_log_quote_idx  on public.quote_send_log (quote_id, sent_at desc);
create index if not exists quote_send_log_tenant_idx on public.quote_send_log (tenant_id, sent_at desc);

alter table public.quote_send_log enable row level security;

-- Tenant-scoped read access for any authenticated user in the tenant.
create policy "quote_send_log_select" on public.quote_send_log
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

-- Writes happen via the route handler using the user's authenticated session.
create policy "quote_send_log_insert" on public.quote_send_log
  for insert to authenticated
  with check (tenant_id = public.current_tenant_id());

-- Service role (future cron / automation) full access.
create policy "quote_send_log_service" on public.quote_send_log
  to service_role
  using (true)
  with check (true);

comment on table public.quote_send_log is
  'Audit log of every quote email sent. status="stubbed" when RESEND_API_KEY missing; "sent" when real Resend send succeeded.';
comment on column public.quote_send_log.sent_by is
  'User who triggered the send. NULL for system-initiated sends.';

commit;
