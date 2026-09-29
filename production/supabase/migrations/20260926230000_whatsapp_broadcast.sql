-- ============================================================================
-- WhatsApp broadcast — templates, opt-outs, and a record of each send.
--
-- Phase 2 (Pardeep, 26 Sep 2026). WhatsApp only lets a business START a conversation with
-- a Meta-approved template; free text works only inside the 24 hours after the customer
-- last wrote. So a broadcast is: an approved template + a list of leads + one API call
-- each (sendWhatsApp, lib/whatsapp/client.ts — which already logs every message in
-- whatsapp_messages).
--
--   1. whatsapp_templates — the company's templates as submitted to Meta: name, language,
--      body with {{1}} {{2}} …, which lead field fills each number (param_map), and status.
--      Status is set by hand or by "Sync from Meta" (GET /{waba}/message_templates). Only
--      'approved' can be broadcast. Starter wording lives in code
--      (lib/marketing/whatsapp-broadcast.ts) — each business must submit its own to Meta.
--   2. whatsapp_opt_outs — numbers that replied STOP (the webhook records it) or that the
--      company added by hand. A broadcast skips them. Stored as '+digits', the same shape
--      whatsapp_messages.contact_phone uses.
--   3. whatsapp_broadcasts — one row per broadcast with its counts.
-- ============================================================================

create table if not exists public.whatsapp_templates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null check (name ~ '^[a-z0-9_]+$' and char_length(name) <= 512),
  language    text not null default 'en',
  category    text not null default 'MARKETING' check (category in ('MARKETING', 'UTILITY')),
  body        text not null,
  param_map   jsonb not null default '[]'::jsonb,
  status      text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'rejected', 'paused')),
  meta_id     text,
  notes       text,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, name, language)
);

comment on table public.whatsapp_templates is
  'WhatsApp message templates as submitted to Meta. param_map[i] names the lead field for {{i+1}}. Only approved ones can be broadcast.';

create table if not exists public.whatsapp_opt_outs (
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  phone      text not null check (phone ~ '^\+[0-9]{8,15}$'),
  reason     text not null default 'stop' check (reason in ('stop', 'manual')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, phone)
);

comment on table public.whatsapp_opt_outs is
  'Numbers that must not get WhatsApp broadcasts: replied STOP (webhook) or added by hand. +digits.';

create table if not exists public.whatsapp_broadcasts (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  template_id      uuid references public.whatsapp_templates(id) on delete set null,
  template_name    text not null,
  audience         jsonb not null default '{}'::jsonb,
  recipients_count integer not null default 0,
  sent_count       integer not null default 0,
  failed_count     integer not null default 0,
  skipped_count    integer not null default 0,
  status           text not null default 'sending' check (status in ('sending', 'sent', 'failed')),
  created_by       uuid,
  created_at       timestamptz not null default now()
);

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.whatsapp_templates  enable row level security;
alter table public.whatsapp_opt_outs   enable row level security;
alter table public.whatsapp_broadcasts enable row level security;

do $$
declare t text;
begin
  foreach t in array array['whatsapp_templates', 'whatsapp_opt_outs'] loop
    execute format('drop policy if exists "tenant isolation read" on public.%I', t);
    execute format('create policy "tenant isolation read" on public.%I for select to authenticated using (tenant_id = public.current_tenant_id())', t);
    execute format('drop policy if exists "tenant isolation write" on public.%I', t);
    execute format('create policy "tenant isolation write" on public.%I for insert to authenticated with check (tenant_id = public.current_tenant_id())', t);
    execute format('drop policy if exists "tenant isolation update" on public.%I', t);
    execute format('create policy "tenant isolation update" on public.%I for update to authenticated using (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id())', t);
    execute format('drop policy if exists "tenant isolation delete" on public.%I', t);
    execute format('create policy "tenant isolation delete" on public.%I for delete to authenticated using (tenant_id = public.current_tenant_id())', t);
    execute format('drop policy if exists zzz_service_role_all on public.%I', t);
    execute format('create policy zzz_service_role_all on public.%I as permissive for all to service_role using (true) with check (true)', t);
  end loop;
end $$;

/* Broadcast rows are written by the server route (service role) and only read by the
   company — a browser cannot fake a "sent 500" record. */
drop policy if exists "tenant isolation read" on public.whatsapp_broadcasts;
create policy "tenant isolation read" on public.whatsapp_broadcasts
  for select to authenticated using (tenant_id = public.current_tenant_id());
drop policy if exists zzz_service_role_all on public.whatsapp_broadcasts;
create policy zzz_service_role_all on public.whatsapp_broadcasts
  as permissive for all to service_role using (true) with check (true);

create index if not exists whatsapp_broadcasts_tenant_idx on public.whatsapp_broadcasts (tenant_id, created_at desc);
