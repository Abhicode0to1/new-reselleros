-- A lead turns Won the moment its project quotation is accepted.
--
-- A custom-software lead is quoted with a project quotation (create_project_quote_from_lead,
-- migration 20260926110000, linked on leads.project_id). Acceptance happens in Project
-- Sales — the "Mark accepted" button, or the customer on the public quotation link — and
-- neither knew about leads, so an accepted deal sat in "Quote Sent" until somebody clicked
-- "mark Won" in the lead drawer.
--
-- This trigger watches project_sales.status. When it becomes active (accepted) or completed,
-- every lead linked to that project that is not already Won becomes Won, and the lead's
-- timeline gets a line saying why. It writes only to leads / lead_activities (Pardeep's CRM);
-- no project function or screen is changed. A lead marked Lost is also moved: the customer
-- accepting the quotation is the fact, and the loss fields are cleared with it.
--
-- Existing accepted projects are backfilled at the bottom.

create or replace function public.leads_won_on_project_accept()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('active', 'completed') and old.status is distinct from new.status then
    with moved as (
      update public.leads
         set stage       = 'won',
             lost_reason = null,
             lost_note   = null,
             lost_at     = null,
             updated_at  = now()
       where project_id = new.id
         and tenant_id  = new.tenant_id
         and stage <> 'won'
      returning id, tenant_id
    )
    insert into public.lead_activities (tenant_id, lead_id, kind, detail)
    select tenant_id, id, 'stage',
           format('Project quotation "%s" accepted — moved to Won automatically', new.title)
      from moved;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_leads_won_on_project_accept on public.project_sales;
create trigger trg_leads_won_on_project_accept
  after update of status on public.project_sales
  for each row execute function public.leads_won_on_project_accept();

comment on function public.leads_won_on_project_accept() is
  'When a project quotation is accepted (status → active/completed), its linked lead (leads.project_id) becomes Won, with a timeline entry.';

-- Backfill: quotations already accepted before this trigger existed.
with moved as (
  update public.leads l
     set stage = 'won', lost_reason = null, lost_note = null, lost_at = null, updated_at = now()
    from public.project_sales p
   where p.id = l.project_id
     and p.status in ('active', 'completed')
     and l.stage <> 'won'
  returning l.id, l.tenant_id, p.title
)
insert into public.lead_activities (tenant_id, lead_id, kind, detail)
select tenant_id, id, 'stage', format('Project quotation "%s" accepted — moved to Won automatically', title)
  from moved;
