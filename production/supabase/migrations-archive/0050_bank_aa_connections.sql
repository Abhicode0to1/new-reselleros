-- Account Aggregator (AA) — connection state per bank account.
-- One row per Setu/Finvu/OneMoney consent. Tracks the full handshake:
--   initiated → pending_approval → active → (expired | revoked)
-- Once active, the daily cron uses consent_id + linked_account_ref to pull
-- transactions via the provider's "FI Data" API, then maps them into
-- bank_transactions. See lib/aa/setu.ts for the provider client.

create table if not exists public.bank_aa_connections (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  bank_account_id      uuid not null references public.bank_accounts(id) on delete cascade,

  -- Provider + identifiers
  provider             text not null check (provider in ('setu', 'finvu', 'onemoney')) default 'setu',
  vua                  text not null,
  consent_handle_id    text,
  consent_id           text,
  linked_account_ref   text,

  -- Lifecycle
  status               text not null default 'initiated'
                       check (status in ('initiated','pending_approval','active','expired','revoked','rejected','error')),
  status_reason        text,
  consent_expires_at   timestamptz,
  fetch_window_from    date,
  fetch_window_to      date,

  -- Sync tracking
  last_fetch_at        timestamptz,
  last_fetch_status    text,
  last_fetch_count     integer default 0,
  next_fetch_after     timestamptz,

  -- Raw audit
  consent_payload      jsonb,
  notes                text,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  unique (bank_account_id, status) deferrable initially deferred
);

create index if not exists bank_aa_connections_tenant_idx on public.bank_aa_connections (tenant_id);
create index if not exists bank_aa_connections_account_idx on public.bank_aa_connections (bank_account_id);
create index if not exists bank_aa_connections_status_idx on public.bank_aa_connections (status) where status = 'active';

alter table public.bank_aa_connections enable row level security;

create policy "tenant select bank_aa_connections" on public.bank_aa_connections
  for select using (tenant_id = (select tenant_id from public.users where id = auth.uid()));
create policy "tenant insert bank_aa_connections" on public.bank_aa_connections
  for insert with check (tenant_id = (select tenant_id from public.users where id = auth.uid()));
create policy "tenant update bank_aa_connections" on public.bank_aa_connections
  for update using (tenant_id = (select tenant_id from public.users where id = auth.uid()));
create policy "tenant delete bank_aa_connections" on public.bank_aa_connections
  for delete using (tenant_id = (select tenant_id from public.users where id = auth.uid()));

create or replace function public.set_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;

drop trigger if exists trg_bank_aa_set_updated on public.bank_aa_connections;
create trigger trg_bank_aa_set_updated before update on public.bank_aa_connections
  for each row execute procedure public.set_updated_at();
