-- 0096: Per-lead activity timeline.
--
-- A simple, reliable communication log on each lead: outbound touches (email,
-- call, WhatsApp, follow-up) the rep makes, and inbound emails captured by the
-- inbound-email webhook. Gives every lead a "what happened, when" history —
-- the CRM backbone — without depending on fragile open-tracking.

create table if not exists public.lead_activities (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  lead_id    text not null references public.leads(id) on delete cascade,
  kind       text not null,          -- email | call | whatsapp | note | email_in | quote | stage
  detail     text,
  created_at timestamptz not null default now(),
  created_by uuid
);

create index if not exists lead_activities_lead_idx on public.lead_activities(lead_id, created_at desc);

alter table public.lead_activities enable row level security;

drop policy if exists "tenant isolation read"   on public.lead_activities;
drop policy if exists "tenant isolation insert"  on public.lead_activities;
drop policy if exists "tenant isolation delete"  on public.lead_activities;
create policy "tenant isolation read"  on public.lead_activities for select using  (tenant_id = public.current_tenant_id());
create policy "tenant isolation insert" on public.lead_activities for insert with check (tenant_id = public.current_tenant_id());
create policy "tenant isolation delete" on public.lead_activities for delete using  (tenant_id = public.current_tenant_id());

-- Log one activity (authenticated caller — tenant taken from the session).
create or replace function public.log_lead_activity(
  p_lead_id text,
  p_kind    text,
  p_detail  text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_id     uuid;
begin
  perform 1 from public.leads where id = p_lead_id and tenant_id = v_tenant;
  if not found then raise exception 'Lead not found'; end if;

  insert into public.lead_activities (tenant_id, lead_id, kind, detail, created_by)
  values (v_tenant, p_lead_id, coalesce(nullif(trim(p_kind), ''), 'note'),
          nullif(trim(coalesce(p_detail, '')), ''), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

grant execute on function public.log_lead_activity(text, text, text) to authenticated;
