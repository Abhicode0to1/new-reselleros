-- ============================================================================
-- R-111: a new lead gets an owner the moment it arrives — 2 Oct 2026.
--
-- WHY
--   Every intake path (website enquiry, trial, checkout, WhatsApp, IndiaMART, Google import,
--   contact promote, DMS upgrade, inbound mail…) inserts leads with owner_id NULL, so every
--   new lead lands in "Unassigned" and waits until somebody happens to look. A lead that
--   waits a day goes cold; that is the whole cost.
--
-- WHY A TRIGGER AND NOT A LINE IN EACH ROUTE
--   Ten-plus insert sites today, and the next intake channel would be the eleventh place to
--   forget. BEFORE INSERT covers every path, present and future, in one place.
--
-- THE RULE
--   An owner ticks "New leads" on the Team page for the people who should get them. A lead
--   inserted with no owner goes to the ticked, active person who got one longest ago
--   (round-robin that survives people being added or removed). Nobody ticked → owner stays
--   NULL, exactly today's behaviour. So this migration changes nothing until someone opts in.
--   A lead that arrives WITH an owner (a rep adding their own) is never touched.
-- ============================================================================

begin;

alter table public.users
  add column if not exists gets_new_leads boolean not null default false,
  add column if not exists last_lead_assigned_at timestamptz;

comment on column public.users.gets_new_leads is
  'R-111: this person is in the pool that new unowned leads are dealt to, round-robin. Owner-only (guard_privileged_user_columns). Default false: nothing is auto-assigned until an owner opts people in.';
comment on column public.users.last_lead_assigned_at is
  'R-111: when auto-assign last dealt this person a lead. The round-robin picks the oldest (NULL first). Written only by assign_new_lead_owner().';

create or replace function public.assign_new_lead_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
begin
  if new.owner_id is not null or new.tenant_id is null then
    return new;
  end if;

  /* skip locked: two leads arriving together go to two people instead of both waiting on
     one row lock and landing on the same person. */
  select u.id into v_owner
    from public.users u
   where u.tenant_id = new.tenant_id
     and u.gets_new_leads
     and u.is_active
   order by u.last_lead_assigned_at nulls first, u.id
   limit 1
   for update skip locked;

  if v_owner is null then
    return new;  -- nobody opted in (or all busy this instant): unassigned, as before
  end if;

  new.owner_id := v_owner;
  update public.users set last_lead_assigned_at = now() where id = v_owner;
  return new;
end;
$$;

comment on function public.assign_new_lead_owner() is
  'R-111: BEFORE INSERT on leads. Unowned lead → the active gets_new_leads user dealt one longest ago. No pool → leaves owner_id NULL.';

drop trigger if exists leads_assign_new_owner on public.leads;
create trigger leads_assign_new_owner
  before insert on public.leads
  for each row
  execute function public.assign_new_lead_owner();

/* gets_new_leads joins the owner-only columns. Same function body as 20260818160000 with
   one more line in the "nothing privileged changed" test and in the message. */
create or replace function public.guard_privileged_user_columns()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_owner boolean;
begin
  if new.role           is not distinct from old.role
     and new.manager_id     is not distinct from old.manager_id
     and new.can_view_deals is not distinct from old.can_view_deals
     and new.gets_new_leads is not distinct from old.gets_new_leads
     and new.tenant_id      is not distinct from old.tenant_id
     and new.is_active      is not distinct from old.is_active then
    return new;
  end if;

  if auth.uid() is null then
    return new;
  end if;

  select exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'owner'
  ) into v_is_owner;

  if not v_is_owner then
    raise exception 'Only an owner can change a teammate''s role, reporting manager, deals access, new-lead assignment, workspace or active status. Ask an owner to do it on the Team page (/team).';
  end if;

  return new;
end;
$$;

comment on function public.guard_privileged_user_columns() is
  'Blocks non-owners from changing users.role / manager_id / can_view_deals / gets_new_leads / tenant_id / is_active. RLS cannot restrict columns, only rows. Callers with no auth.uid() (service_role) pass through.';

commit;
