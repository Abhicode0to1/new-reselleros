-- Leads: a custom-software enquiry is a different kind of lead from a licence enquiry.
--
-- The lead form only knew subscription plans (Google / Microsoft / Zoho × seats), and
-- "Send quote" only built a subscription quote. A client asking for custom software had
-- to be squeezed into "Custom / Mixed" with a seat count, and could never be quoted as a
-- project — so the project it became had no link back to the lead, and the lead never
-- turned Won.
--
--   leads.enquiry_type     'subscription' (default — every existing lead) | 'project'
--   leads.requirement      what they want built, in their words
--   leads.project_timeline when they want it ("3 months", "before Diwali")
--   leads.project_id       the project quotation made for this lead (project_sales)
--
-- create_project_quote_from_lead(...) makes that quotation through the project module's
-- own create_project_quote (unchanged), then links it to the lead and moves the lead to
-- "Quote Sent" — the same gate a subscription quote crosses.

alter table public.leads
  add column if not exists enquiry_type text not null default 'subscription',
  add column if not exists requirement text,
  add column if not exists project_timeline text,
  add column if not exists project_id uuid references public.project_sales(id) on delete set null;

alter table public.leads drop constraint if exists leads_enquiry_type_check;
alter table public.leads add constraint leads_enquiry_type_check
  check (enquiry_type in ('subscription', 'project'));

create index if not exists leads_project_id_idx on public.leads (project_id) where project_id is not null;

comment on column public.leads.enquiry_type is 'subscription = licence / seats enquiry; project = custom software / one-time project enquiry.';
comment on column public.leads.requirement is 'Project enquiry: what the client wants built.';
comment on column public.leads.project_timeline is 'Project enquiry: when the client wants it, free text.';
comment on column public.leads.project_id is 'The project quotation (project_sales) raised for this lead.';

create or replace function public.create_project_quote_from_lead(
  p_lead_id     text,
  p_title       text,
  p_description text,
  p_line_items  jsonb,
  p_gst_rate    integer,
  p_inter_state boolean,
  p_milestones  jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_lead    public.leads;
  v_name    text;
  v_cust    uuid;
  v_project uuid;
begin
  if v_tenant is null then raise exception 'No tenant in context'; end if;
  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found then raise exception 'Lead not found'; end if;
  if v_lead.tenant_id is distinct from v_tenant then
    raise exception 'Lead not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  if v_lead.project_id is not null then
    raise exception 'This lead already has a project quotation — revise that one from Project Sales.';
  end if;

  -- The party the quotation is for: the company, else the person (a lead may have no company).
  v_name := coalesce(nullif(trim(v_lead.company), ''), nullif(trim(v_lead.contact_name), ''));
  if v_name is null then raise exception 'The lead has neither a company nor a contact name to quote.'; end if;
  select id into v_cust from public.customers
   where tenant_id = v_tenant and lower(name) = lower(v_name) limit 1;

  v_project := public.create_project_quote(v_cust, v_name, p_title, p_description, p_line_items,
                                           p_gst_rate, p_inter_state, p_milestones);

  update public.leads
     set project_id   = v_project,
         enquiry_type = 'project',
         value        = coalesce((select taxable_amount from public.project_sales where id = v_project), value),
         stage        = case when stage in ('new', 'contact') then 'quote' else stage end,
         updated_at   = now()
   where id = p_lead_id;

  return v_project;
end;
$$;

revoke all on function public.create_project_quote_from_lead(text, text, text, jsonb, integer, boolean, jsonb) from public, anon;
grant execute on function public.create_project_quote_from_lead(text, text, text, jsonb, integer, boolean, jsonb) to authenticated;

comment on function public.create_project_quote_from_lead(text, text, text, jsonb, integer, boolean, jsonb) is
  'Raise a project quotation for a lead (via create_project_quote), link it on leads.project_id and move the lead to Quote Sent.';
