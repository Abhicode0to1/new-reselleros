-- ============================================================================
-- S28 — WhatsApp reminders: renewal / due / overdue, with a sent → delivered → read log.
--
-- Pardeep, 27 Sep 2026: "Saare reminder crons sirf email; business WhatsApp par chalta hai."
-- Sending infra already exists (lib/whatsapp/client.ts → whatsapp_messages, whose status the
-- webhook moves on every Meta status callback). What was missing:
--
--   1. whatsapp_reminder_settings — ek switch per company. DEFAULT OFF, and no row = off.
--      Kuch bhi customer tak tab tak nahi jayega jab tak owner khud ON na kare.
--   2. whatsapp_reminder_templates — the registry: which approved template goes out for
--      which reminder kind, and which reminder field fills each {{n}} (param_map).
--      Approval happens at Meta/BSP, not here: a mapping is only USED when a
--      whatsapp_templates row with the same name + language is 'approved' (set by hand or by
--      "Sync from Meta"). So a template name typed before approval sends nothing.
--   3. whatsapp_reminder_log — one row per reminder attempt (sent / failed / skipped with a
--      reason), keyed to the subject (subscription or invoice) and the cadence step.
--      delivered / read are copied in from whatsapp_messages by a trigger, so the existing
--      webhook needed NO change (it is unowned code — OWNERS.json).
--
-- Dedupe: a partial unique index allows only ONE delivered-or-better row per
-- (subject, step). A failed or skipped row does not block a retry next run.
-- ============================================================================

-- ── 1. Settings (per tenant, default off) ───────────────────────────────────
create table if not exists public.whatsapp_reminder_settings (
  tenant_id  uuid primary key references public.tenants(id) on delete cascade,
  enabled    boolean not null default false,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

comment on table public.whatsapp_reminder_settings is
  'S28: master switch for WhatsApp renewal/dunning reminders. No row or enabled=false = nothing is sent.';

-- ── 2. Template registry ────────────────────────────────────────────────────
create table if not exists public.whatsapp_reminder_templates (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  kind          text not null check (kind in (
                  'renewal_upcoming', 'renewal_final', 'renewal_grace',
                  'invoice_due', 'invoice_overdue', 'invoice_final')),
  template_name text not null check (template_name ~ '^[a-z0-9_]+$' and char_length(template_name) <= 512),
  language      text not null default 'en' check (char_length(language) between 2 and 10),
  -- param_map[i] = reminder field for {{i+1}} — see REMINDER_PARAM_FIELDS in
  -- lib/marketing/whatsapp-reminders.ts. Unknown fields are refused in code, not here.
  param_map     jsonb not null default '[]'::jsonb check (jsonb_typeof(param_map) = 'array'),
  enabled       boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, kind)
);

comment on table public.whatsapp_reminder_templates is
  'S28: which approved WhatsApp template each reminder kind uses. Used only when whatsapp_templates has the same name+language as approved.';

-- ── 3. Log ──────────────────────────────────────────────────────────────────
create table if not exists public.whatsapp_reminder_log (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  kind          text not null check (kind in (
                  'renewal_upcoming', 'renewal_final', 'renewal_grace',
                  'invoice_due', 'invoice_overdue', 'invoice_final')),
  subject_type  text not null check (subject_type in ('subscription', 'invoice')),
  subject_id    text not null,
  step          text not null,
  phone         text,
  template_name text,
  -- whatsapp_messages.id / wamid. Filled on send; the trigger below matches on these.
  message_id    uuid,
  wamid         text,
  status        text not null check (status in ('sent', 'delivered', 'read', 'failed', 'skipped')),
  skip_reason   text,
  error_message text,
  sent_at       timestamptz,
  delivered_at  timestamptz,
  read_at       timestamptz,
  failed_at     timestamptz,
  created_at    timestamptz not null default now()
);

comment on table public.whatsapp_reminder_log is
  'S28: every WhatsApp reminder attempt. delivered/read synced from whatsapp_messages by trigger.';

-- Ek hi step ek hi baar pahunche — do cron run ek saath chalein tab bhi.
create unique index if not exists whatsapp_reminder_log_once
  on public.whatsapp_reminder_log (tenant_id, subject_type, subject_id, step)
  where status in ('sent', 'delivered', 'read');
create index if not exists whatsapp_reminder_log_tenant_idx
  on public.whatsapp_reminder_log (tenant_id, created_at desc);
create index if not exists whatsapp_reminder_log_wamid_idx
  on public.whatsapp_reminder_log (tenant_id, wamid) where wamid is not null;

-- ── 4. Status sync from whatsapp_messages ───────────────────────────────────
-- Status sirf aage badhta hai: sent → delivered → read. Meta callbacks out of order aa
-- sakte hain, aur webhook unknown status ko 'sent' likh deta hai — 'read' ko wapas 'sent'
-- karna jhooth hoga. 'failed' only overrides 'sent' (a failure after delivery is noise).
create or replace function public.whatsapp_reminder_status_rank(p text)
returns int language sql immutable set search_path = public as $$
  select case p when 'read' then 3 when 'delivered' then 2 when 'sent' then 1 else 0 end
$$;

create or replace function public.sync_whatsapp_reminder_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_at timestamptz := coalesce(new.meta_timestamp, now());
begin
  if new.wamid is null then return new; end if;
  if new.status is not distinct from old.status and new.wamid is not distinct from old.wamid then
    return new;
  end if;

  update public.whatsapp_reminder_log l
     set status = case
                    when new.status in ('delivered', 'read')
                         and public.whatsapp_reminder_status_rank(new.status) > public.whatsapp_reminder_status_rank(l.status)
                      then new.status
                    when new.status = 'failed' and l.status = 'sent' then 'failed'
                    else l.status
                  end,
         delivered_at  = case when new.status in ('delivered', 'read') then coalesce(l.delivered_at, v_at) else l.delivered_at end,
         read_at       = case when new.status = 'read' then coalesce(l.read_at, v_at) else l.read_at end,
         failed_at     = case when new.status = 'failed' and l.status = 'sent' then v_at else l.failed_at end,
         error_message = case when new.status = 'failed' and l.status = 'sent'
                              then coalesce(new.error_message, l.error_message) else l.error_message end,
         message_id    = coalesce(l.message_id, new.id)
   where l.tenant_id = new.tenant_id
     and l.wamid = new.wamid
     and l.status <> 'skipped';
  return new;
end $$;

drop trigger if exists whatsapp_reminder_status_sync on public.whatsapp_messages;
create trigger whatsapp_reminder_status_sync
  after update of status, wamid on public.whatsapp_messages
  for each row execute function public.sync_whatsapp_reminder_status();

-- A status callback can land between sendWhatsApp() returning and the log row being
-- written. So on insert, pick up whatever whatsapp_messages already knows.
create or replace function public.whatsapp_reminder_log_adopt_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid; v_status text; v_at timestamptz;
begin
  if new.wamid is null or new.status <> 'sent' then return new; end if;
  select m.id, m.status::text, coalesce(m.meta_timestamp, now())
    into v_id, v_status, v_at
    from public.whatsapp_messages m
   where m.tenant_id = new.tenant_id and m.wamid = new.wamid
   limit 1;
  if v_id is null then return new; end if;
  new.message_id := coalesce(new.message_id, v_id);
  if v_status in ('delivered', 'read') then
    new.status := v_status;
    new.delivered_at := coalesce(new.delivered_at, v_at);
    if v_status = 'read' then new.read_at := coalesce(new.read_at, v_at); end if;
  end if;
  return new;
end $$;

drop trigger if exists whatsapp_reminder_log_adopt on public.whatsapp_reminder_log;
create trigger whatsapp_reminder_log_adopt
  before insert on public.whatsapp_reminder_log
  for each row execute function public.whatsapp_reminder_log_adopt_status();

revoke all on function public.sync_whatsapp_reminder_status()      from public, anon, authenticated;
revoke all on function public.whatsapp_reminder_log_adopt_status() from public, anon, authenticated;
revoke all on function public.whatsapp_reminder_status_rank(text)  from public, anon;
grant execute on function public.whatsapp_reminder_status_rank(text) to authenticated, service_role;

-- ── 5. RLS + grants ─────────────────────────────────────────────────────────
alter table public.whatsapp_reminder_settings  enable row level security;
alter table public.whatsapp_reminder_templates enable row level security;
alter table public.whatsapp_reminder_log       enable row level security;

revoke all on public.whatsapp_reminder_settings  from anon;
revoke all on public.whatsapp_reminder_templates from anon;
revoke all on public.whatsapp_reminder_log       from anon;
revoke all on public.whatsapp_reminder_log       from authenticated;
grant select, insert, update, delete on public.whatsapp_reminder_settings  to authenticated;
grant select, insert, update, delete on public.whatsapp_reminder_templates to authenticated;
grant select on public.whatsapp_reminder_log to authenticated;
grant all on public.whatsapp_reminder_settings, public.whatsapp_reminder_templates, public.whatsapp_reminder_log to service_role;

-- Settings + registry: sab padh sakte hain, badal sirf owner/manager — ye switch customers
-- ko message bhejna chalu karta hai.
do $$
declare t text;
begin
  foreach t in array array['whatsapp_reminder_settings', 'whatsapp_reminder_templates'] loop
    execute format('drop policy if exists "tenant isolation read" on public.%I', t);
    execute format('create policy "tenant isolation read" on public.%I for select to authenticated using (tenant_id = public.current_tenant_id())', t);
    execute format('drop policy if exists "owner manager insert" on public.%I', t);
    execute format($p$create policy "owner manager insert" on public.%I for insert to authenticated with check (
      tenant_id = public.current_tenant_id()
      and exists (select 1 from public.users u where u.id = auth.uid() and u.tenant_id = %I.tenant_id and u.role in ('owner', 'manager')))$p$, t, t);
    execute format('drop policy if exists "owner manager update" on public.%I', t);
    execute format($p$create policy "owner manager update" on public.%I for update to authenticated using (
      tenant_id = public.current_tenant_id()
      and exists (select 1 from public.users u where u.id = auth.uid() and u.tenant_id = %I.tenant_id and u.role in ('owner', 'manager')))
      with check (tenant_id = public.current_tenant_id())$p$, t, t);
    execute format('drop policy if exists "owner manager delete" on public.%I', t);
    execute format($p$create policy "owner manager delete" on public.%I for delete to authenticated using (
      tenant_id = public.current_tenant_id()
      and exists (select 1 from public.users u where u.id = auth.uid() and u.tenant_id = %I.tenant_id and u.role in ('owner', 'manager')))$p$, t, t);
    execute format('drop policy if exists zzz_service_role_all on public.%I', t);
    execute format('create policy zzz_service_role_all on public.%I as permissive for all to service_role using (true) with check (true)', t);
  end loop;
end $$;

-- Log: server (service role) likhta hai, company sirf padhti hai — browser "sent" fake na kar sake.
drop policy if exists "tenant isolation read" on public.whatsapp_reminder_log;
create policy "tenant isolation read" on public.whatsapp_reminder_log
  for select to authenticated using (tenant_id = public.current_tenant_id());
drop policy if exists zzz_service_role_all on public.whatsapp_reminder_log;
create policy zzz_service_role_all on public.whatsapp_reminder_log
  as permissive for all to service_role using (true) with check (true);
