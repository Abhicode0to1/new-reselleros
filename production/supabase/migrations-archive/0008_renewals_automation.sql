-- ============================================================
-- ResellerOS — renewal automation cadence + auto-suspend
-- Migration: 0008_renewals_automation.sql
-- ============================================================
-- Purpose
--   Tracks where each subscription is in its renewal email cadence
--   (T-15 quote send → T-12/9/6/3 reminders → T-0 final → grace →
--   suspended) and the per-tenant grace period.
--
-- Cadence (cron-driven, daily 9 AM IST via Vercel):
--
--   T-15  notice       Soft notice + PDF quote attached
--   T-12  reminder_1   Soft reminder
--   T-9   reminder_2   Friendly
--   T-6   reminder_3   Firm
--   T-3   reminder_4   Urgent — service interruption ahead
--   T-0   final        Final notice — suspension warning
--   T+1..T+grace  grace_notice  (only if grace_period_days > 0)
--   T+grace+1   auto-suspend  (system action, status → 'paused')
--
-- Once a subscription's renewal_date passes AND grace is exhausted
-- AND no payment received against the renewal quote, the system
-- automatically flips subscriptions.status to 'paused' and stamps
-- suspended_at. Operator can override via the Renewals page.
--
-- The actual outgoing email is sent via the lib/email/send.ts
-- abstraction. When RESEND_API_KEY is unset, sends are recorded in
-- the renewal_email_log table below in 'stubbed' mode so we can
-- still verify cadence logic ran. The moment the key arrives, those
-- same code paths flip to real Resend delivery.
-- ============================================================

begin;

-- ============================================================
-- 1. Renewal state enum — operational, separate from subscriptions.status
--    (which remains the lifecycle: active/paused/expired/cancelled)
-- ============================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'renewal_state') then
    create type public.renewal_state as enum (
      'pending',        -- renewal_date is far away or not set
      'notice_sent',    -- T-15 first email sent
      'reminder_1',     -- T-12
      'reminder_2',     -- T-9
      'reminder_3',     -- T-6
      'reminder_4',     -- T-3
      'final_sent',     -- T-0 final notice
      'grace_period',   -- T+1..T+grace, holding for renewal
      'renewed',        -- payment received against renewal quote
      'suspended'       -- past grace, no payment — auto-suspended
    );
  end if;
end $$;

-- ============================================================
-- 2. subscriptions — track cadence position + suspension audit
-- ============================================================
alter table public.subscriptions
  add column if not exists renewal_state         public.renewal_state not null default 'pending',
  add column if not exists reminder_count        smallint    not null default 0 check (reminder_count >= 0),
  add column if not exists last_reminder_sent_at_v2 timestamptz,  -- _v2 to avoid clash w/ existing last_reminder_at
  add column if not exists renewal_quote_id      text references public.quotes(id) on delete set null,
  add column if not exists suspended_at          timestamptz;

-- If the legacy last_reminder_at column exists, migrate values into _v2 and drop
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='subscriptions'
               and column_name='last_reminder_at')
  then
    update public.subscriptions
       set last_reminder_sent_at_v2 = last_reminder_at
     where last_reminder_at is not null
       and last_reminder_sent_at_v2 is null;
    -- leave the old column in place to avoid breaking any client code
    -- that still references it; rename in a later cleanup migration if needed.
  end if;
end $$;

create index if not exists subscriptions_renewal_state_idx
  on public.subscriptions (renewal_state)
  where renewal_state in ('pending','notice_sent','reminder_1','reminder_2','reminder_3','reminder_4','final_sent','grace_period');

create index if not exists subscriptions_renewal_date_idx
  on public.subscriptions (renewal_date)
  where renewal_date is not null and status = 'active';

comment on column public.subscriptions.renewal_state is
  'Where in the renewal email cadence this sub is. Updated daily by /api/cron/renewals.';
comment on column public.subscriptions.suspended_at is
  'When the auto-suspend trigger fired. Distinguishes auto-suspend from operator-initiated pause.';
comment on column public.subscriptions.renewal_quote_id is
  'The auto-generated quote for the upcoming renewal (created at T-15). Customer pays this to renew.';

-- ============================================================
-- 3. tenants — operator-configurable grace period
-- ============================================================
alter table public.tenants
  add column if not exists grace_period_days smallint not null default 0 check (grace_period_days >= 0 and grace_period_days <= 30);

comment on column public.tenants.grace_period_days is
  'Days after renewal_date during which the subscription stays active despite non-payment. Default 0 = immediate suspend.';

-- ============================================================
-- 4. renewal_email_log — append-only audit + idempotency
--    Cron checks "did we already send this tier today?" before sending.
--    Stub mode writes 'stubbed' status; real Resend writes 'sent' / 'failed'.
-- ============================================================
create table if not exists public.renewal_email_log (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  cadence_step    public.renewal_state not null,
  recipient_email text not null,
  subject         text,
  status          text not null check (status in ('sent','stubbed','failed','skipped')),
  provider_id     text,       -- Resend message ID when real send
  error_message   text,
  sent_at         timestamptz not null default now()
);

create index if not exists renewal_email_log_sub_idx  on public.renewal_email_log (subscription_id, sent_at desc);
create index if not exists renewal_email_log_step_idx on public.renewal_email_log (subscription_id, cadence_step, sent_at);

alter table public.renewal_email_log enable row level security;

create policy "renewal_email_log_select" on public.renewal_email_log
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

-- Inserts only via service-role (cron). Authenticated users do not write directly.
create policy "renewal_email_log_service" on public.renewal_email_log
  to service_role
  using (true)
  with check (true);

comment on table public.renewal_email_log is
  'Audit of every renewal-cadence email. status="stubbed" when RESEND_API_KEY missing; "sent" when real Resend send succeeded.';

commit;
