-- 0104: Project quotations — send a customer an itemised quote for a one-time
-- project; on acceptance it becomes an active project (milestones ready).
--
-- Reuses project_sales: a quotation is just a project with status='quoted' and
-- line_items. Accepting flips it to 'active'. Mirrors the subscription
-- quote→accept flow (the project id is the unguessable link secret).

alter table public.project_sales
  add column if not exists line_items jsonb not null default '[]'::jsonb;
alter table public.project_sales
  add column if not exists accepted_at timestamptz;

-- widen status: draft / quoted / active / completed / cancelled
alter table public.project_sales drop constraint if exists project_sales_status_check;
alter table public.project_sales add constraint project_sales_status_check
  check (status in ('draft','quoted','active','completed','cancelled'));

-- ── Create a quotation (status='quoted') with line items + milestones ────────
create or replace function public.create_project_quote(
  p_customer_id   uuid,
  p_customer_name text,
  p_title         text,
  p_description   text,
  p_line_items    jsonb,        -- [{name, qty, rate, amount}]  (rate/amount = taxable ₹)
  p_gst_rate      integer,
  p_inter_state   boolean,
  p_milestones    jsonb         -- [{label, total_amount, due_date}]
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_taxable integer := 0;
  v_gst     integer;
  v_total   integer;
  v_id      uuid;
  v_li      jsonb;
  v_m       jsonb;
  v_seq     integer := 0;
begin
  if v_tenant is null then raise exception 'No tenant in context'; end if;

  -- Taxable = sum of line amounts.
  for v_li in select * from jsonb_array_elements(coalesce(p_line_items, '[]'::jsonb)) loop
    v_taxable := v_taxable + greatest(coalesce((v_li->>'amount')::integer, 0), 0);
  end loop;
  if v_taxable <= 0 then raise exception 'Quotation needs at least one line item'; end if;

  v_gst   := round(v_taxable * coalesce(p_gst_rate, 18) / 100.0);
  v_total := v_taxable + v_gst;

  insert into public.project_sales
    (tenant_id, customer_id, customer_name, title, description, gst_rate, inter_state,
     taxable_amount, gst_amount, total_amount, status, line_items)
  values
    (v_tenant, p_customer_id, p_customer_name, p_title, nullif(trim(coalesce(p_description,'')),''),
     coalesce(p_gst_rate, 18), coalesce(p_inter_state, false),
     v_taxable, v_gst, v_total, 'quoted', coalesce(p_line_items, '[]'::jsonb))
  returning id into v_id;

  for v_m in select * from jsonb_array_elements(coalesce(p_milestones, '[]'::jsonb)) loop
    v_seq := v_seq + 1;
    insert into public.project_milestones (tenant_id, project_id, seq, label, total_amount, due_date)
    values (
      v_tenant, v_id, v_seq,
      coalesce(v_m->>'label', 'Milestone ' || v_seq),
      greatest(coalesce((v_m->>'total_amount')::integer, 0), 0),
      nullif(v_m->>'due_date','')::date
    );
  end loop;

  return v_id;
end;
$$;
grant execute on function public.create_project_quote(uuid, text, text, text, jsonb, integer, boolean, jsonb) to authenticated;

-- ── Accept a quotation → active project (customer-side; public-safe) ─────────
-- Only flips 'quoted' → 'active'. Idempotent. No tenant guard: the caller is
-- the (unauthenticated) customer, and the project id is the link secret.
create or replace function public.accept_project_quote(p_project_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select status into v_status from public.project_sales where id = p_project_id;
  if not found then raise exception 'Quotation not found' using errcode = 'no_data_found'; end if;
  if v_status = 'active' then return 'already'; end if;
  if v_status <> 'quoted' then
    raise exception 'This quotation cannot be accepted (status %)', v_status using errcode = 'invalid_parameter_value';
  end if;
  update public.project_sales set status = 'active', accepted_at = now(), updated_at = now()
   where id = p_project_id;
  return 'accepted';
end;
$$;
grant execute on function public.accept_project_quote(uuid) to authenticated, anon, service_role;
