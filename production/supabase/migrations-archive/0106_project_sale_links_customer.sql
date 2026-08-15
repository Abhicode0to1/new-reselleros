-- 0106: create_project_sale also ensures a linked customer.
--
-- The direct "New project" path (create_project_sale) still left customer_id
-- null when only a name was given. Mirror the quote-accept behaviour: dedup by
-- name within the tenant, else insert a customer, and link it — so a project
-- always shows up under a customer. (The quotation dialog collects full contact
-- + GST details up front; this is the safety net for the quick-record path.)

create or replace function public.create_project_sale(
  p_customer_id   uuid,
  p_customer_name text,
  p_title         text,
  p_description   text,
  p_taxable       integer,
  p_gst_rate      integer,
  p_inter_state   boolean,
  p_milestones    jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_gst    integer;
  v_total  integer;
  v_id     uuid;
  v_cust   uuid := p_customer_id;
  v_m      jsonb;
  v_seq    integer := 0;
begin
  if v_tenant is null then raise exception 'No tenant in context'; end if;
  if coalesce(p_taxable, 0) <= 0 then raise exception 'Taxable amount must be > 0'; end if;

  -- Ensure a customer (dedup by name, else create).
  if v_cust is null and length(trim(coalesce(p_customer_name, ''))) > 0 then
    select id into v_cust from public.customers
     where tenant_id = v_tenant and lower(name) = lower(trim(p_customer_name)) limit 1;
    if v_cust is null then
      insert into public.customers (tenant_id, name, since, health)
      values (v_tenant, trim(p_customer_name), current_date, 70)
      returning id into v_cust;
    end if;
  end if;

  v_gst   := round(p_taxable * coalesce(p_gst_rate, 18) / 100.0);
  v_total := p_taxable + v_gst;

  insert into public.project_sales
    (tenant_id, customer_id, customer_name, title, description, gst_rate, inter_state,
     taxable_amount, gst_amount, total_amount)
  values
    (v_tenant, v_cust, p_customer_name, p_title, nullif(trim(coalesce(p_description,'')),''),
     coalesce(p_gst_rate, 18), coalesce(p_inter_state, false), p_taxable, v_gst, v_total)
  returning id into v_id;

  for v_m in select * from jsonb_array_elements(coalesce(p_milestones, '[]'::jsonb))
  loop
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
grant execute on function public.create_project_sale(uuid, text, text, text, integer, integer, boolean, jsonb) to authenticated;
