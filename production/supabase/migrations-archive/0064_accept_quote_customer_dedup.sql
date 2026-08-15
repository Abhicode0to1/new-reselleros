-- 0064_accept_quote_customer_dedup.sql
-- accept_quote: reuse an existing same-email customer instead of inserting a
-- duplicate (root-cause fix for duplicate customer records — e.g. the two
-- "Anutech" rows that split one buyer's data across two customers).
--
-- Before converting a lead → customer, look up an existing customer in the same
-- tenant with the same contact_email (case-insensitive); if found, reuse it.
-- Only inserts a new customer when none matches. Email-based (NOT domain) so two
-- distinct people at the same company stay distinct customers.
-- Verified: dedup reuses; new-customer path still works.

create or replace function public.accept_quote(p_quote_id text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_quote        record;
  v_caller       uuid;
  v_tenant       uuid;
  v_customer_id  uuid;
  v_lead         record;
  v_domain       text;
  v_converted    boolean := false;
begin
  select q.id, q.tenant_id, q.customer_id, q.customer_name, q.lead_id, q.status,
         q.domain, q.payment_status
    into v_quote
    from public.quotes q
   where q.id = p_quote_id
   for update;
  if not found then
    raise exception 'quote % not found', p_quote_id;
  end if;

  v_caller := public.current_tenant_id();
  if v_caller is not null and v_quote.tenant_id <> v_caller then
    raise exception 'quote % does not belong to your tenant', p_quote_id;
  end if;
  v_tenant := v_quote.tenant_id;

  if v_quote.status = 'rejected' or v_quote.status = 'expired' then
    raise exception 'cannot accept a % quote', v_quote.status;
  end if;

  v_customer_id := v_quote.customer_id;
  v_domain      := v_quote.domain;

  if v_customer_id is null and v_quote.lead_id is not null then
    select l.contact_name, l.contact_email, l.contact_phone, l.company, l.notes, l.domain,
           l.state_code, l.state, l.gstin
      into v_lead
      from public.leads l
     where l.id = v_quote.lead_id
       and l.tenant_id = v_tenant;
    if not found then
      raise exception 'lead % referenced by quote % not found', v_quote.lead_id, p_quote_id;
    end if;

    if v_domain is null then
      v_domain := v_lead.domain;
    end if;

    -- Dedup: reuse an existing customer with the same contact_email in this
    -- tenant instead of inserting a duplicate.
    if v_lead.contact_email is not null and length(trim(v_lead.contact_email)) > 0 then
      select id into v_customer_id
        from public.customers
       where tenant_id = v_tenant
         and lower(contact_email) = lower(trim(v_lead.contact_email))
       limit 1;
    end if;

    if v_customer_id is null then
      insert into public.customers (
        tenant_id, name, contact_name, contact_email, contact_phone,
        domain, since, health, notes, state_code, state, gstin
      ) values (
        v_tenant, v_lead.company, v_lead.contact_name, v_lead.contact_email,
        v_lead.contact_phone, v_domain, current_date,
        70,
        v_lead.notes, v_lead.state_code, v_lead.state, v_lead.gstin
      )
      returning id into v_customer_id;
    end if;

    update public.leads
       set stage = 'won'
     where id = v_quote.lead_id
       and tenant_id = v_tenant;

    v_converted := true;
  end if;

  update public.quotes
     set status      = 'accepted',
         customer_id  = v_customer_id,
         payment_status = case
           when payment_status in ('partial', 'received', 'invoiced') then payment_status
           else 'awaiting'::payment_status
         end
   where id = p_quote_id
     and tenant_id = v_tenant;

  return jsonb_build_object(
    'quote_id',       p_quote_id,
    'customer_id',    v_customer_id,
    'converted_now',  v_converted,
    'quote_status',   'accepted',
    'awaits_payment', true
  );
end;
$function$;
