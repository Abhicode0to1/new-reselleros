-- 0069_inbound_emails.sql
-- Audit + idempotency log for the inbound-email → lead pipeline
-- (POST /api/webhooks/inbound-email). One row per forwarded email we receive.
--
-- Why: the webhook is public (secret-guarded) and an inbound provider can
-- deliver the same email more than once (retries / Gmail thread replays). The
-- UNIQUE (tenant_id, message_id) lets the webhook dedupe so a single email
-- never creates two leads. `status` doubles as an audit trail for a future
-- "inbound log" screen.

create table if not exists public.inbound_emails (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  message_id  text not null,
  from_email  text,
  from_name   text,
  subject     text,
  -- received | lead_created | appended_to_lead | duplicate | skipped_non_enquiry | error
  status      text not null default 'received',
  lead_id     text,
  created_at  timestamptz not null default now(),
  unique (tenant_id, message_id)
);

alter table public.inbound_emails enable row level security;

-- Operators can read their own tenant's inbound log. Writes happen via the
-- service-role webhook (bypasses RLS) — no operator insert/update path needed.
create policy inbound_emails_select_own_tenant
  on public.inbound_emails for select
  using (tenant_id = current_tenant_id());

grant select on public.inbound_emails to authenticated;
