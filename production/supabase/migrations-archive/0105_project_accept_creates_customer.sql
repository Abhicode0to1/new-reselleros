-- 0105: accepting a project quotation creates/links a customer.
--
-- Like the subscription flow (accept_quote converts lead → customer), accepting
-- a project quotation should put the buyer in the Customers list. Previously
-- accept_project_quote only flipped status, leaving customer_id null — so the
-- project + its invoices weren't linked to any customer record.
--
-- Now: on accept, if the project has no customer_id, dedup by name within the
-- tenant, else insert a new customer; link it onto the project AND its invoices.

create or replace function public.accept_project_quote(p_project_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_tenant uuid;
  v_cust   uuid;
  v_name   text;
begin
  select status, tenant_id, customer_id, customer_name
    into v_status, v_tenant, v_cust, v_name
    from public.project_sales where id = p_project_id;
  if not found then raise exception 'Quotation not found' using errcode = 'no_data_found'; end if;
  if v_status = 'active' then return 'already'; end if;
  if v_status <> 'quoted' then
    raise exception 'This quotation cannot be accepted (status %)', v_status using errcode = 'invalid_parameter_value';
  end if;

  -- Ensure a customer record (dedup by name within the tenant).
  if v_cust is null then
    select id into v_cust
      from public.customers
     where tenant_id = v_tenant and lower(name) = lower(trim(coalesce(v_name, '')))
     limit 1;
    if v_cust is null and length(trim(coalesce(v_name, ''))) > 0 then
      insert into public.customers (tenant_id, name, since, health)
      values (v_tenant, trim(v_name), current_date, 70)
      returning id into v_cust;
    end if;
  end if;

  update public.project_sales
     set status = 'active', accepted_at = now(), customer_id = v_cust, updated_at = now()
   where id = p_project_id;

  -- Back-link any invoices already raised for this project's milestones.
  if v_cust is not null then
    update public.invoices i
       set customer_id = v_cust
      from public.project_milestones m
     where m.project_id = p_project_id
       and i.id = m.invoice_id
       and i.customer_id is null;
  end if;

  return 'accepted';
end;
$$;
grant execute on function public.accept_project_quote(uuid) to authenticated, anon, service_role;
