begin;

create table if not exists public.email_log (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  recipient   text not null,
  subject     text,
  /** Which message this was — 'renewal_reminder', 'quote', 'invoice', … Free
      text rather than an enum so a new email type cannot fail to be logged
      merely because nobody added it to a type first. */
  kind        text,

  /** Which transport actually carried it, recorded per message: a tenant can
      switch provider between two sends and the log must stay truthful about
      which one each went through. */
  provider    text not null check (provider in ('resend', 'gmail', 'stub')),
  status      text not null check (status in ('sent', 'stubbed', 'failed')),

  /** The provider's own id — the receipt. Without it there is no way to match a
      row here against the provider's dashboard when a customer says they never
      got it. */
  provider_message_id text,
  error_message       text,

  /** Whose action caused it. NULL for cron, which is correct rather than
      missing — nobody pressed anything. */
  user_id     uuid references public.users(id) on delete set null,

  created_at  timestamptz not null default now()
);

-- "What did we send this customer" and "what went out today" are the two real
-- queries; both are tenant-scoped and time-ordered.
create index if not exists email_log_tenant_time_idx
  on public.email_log (tenant_id, created_at desc);

create index if not exists email_log_recipient_idx
  on public.email_log (tenant_id, lower(recipient));

-- Finding failures is the reason anyone opens this table in a hurry.
create index if not exists email_log_failed_idx
  on public.email_log (tenant_id, created_at desc)
  where status <> 'sent';

comment on table public.email_log is
  'Every outbound email attempt, written from inside sendEmail() so no caller can omit it. Bodies are NOT stored. status=sent means the provider accepted the message, not that it was delivered.';

commit;
