-- 0059_accept_quote_public_safe.sql
-- Make accept_quote() usable from the PUBLIC customer-accept route (audit #17),
-- and fold the payment_status='awaiting' flip into the RPC so customer-accept
-- and operator "Mark accepted" share ONE atomic path.
--
-- WHY: the public route POST /api/public/quote/[id]/accept used the admin
-- (service-role) client and only did `update quotes set status='accepted',
-- payment_status='awaiting'` — it never converted the linked lead into a
-- customer or advanced the lead to 'won'. The deal only materialised later if
-- record_payment ran (#17). The operator "Mark accepted" path already calls
-- accept_quote() which DOES convert — but accept_quote raised 'No tenant
-- context' under service-role (current_tenant_id() IS NULL), so the public
-- route could not reuse it.
--
-- FIX: resolve the tenant the same way record_payment / generate_invoice do —
-- load+lock the quote by id, then:
--   * authenticated caller  -> enforce quote.tenant_id == current_tenant_id()
--   * service-role / public  -> trust the quote's own tenant_id
-- and set payment_status='awaiting' on accept (without downgrading a quote that
-- already has money against it). Behaviour for the operator path is unchanged
-- except that accept now also stamps payment_status='awaiting' (matching the
-- 'awaits_payment: true' the RPC already returns).

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
  -- Load + lock the quote by id; tenant is resolved/verified afterwards.
  select q.id, q.tenant_id, q.customer_id, q.customer_name, q.lead_id, q.status,
         q.domain, q.payment_status
    into v_quote
    from public.quotes q
   where q.id = p_quote_id
   for update;
  if not found then
    raise exception 'quote % not found', p_quote_id;
  end if;

  -- Tenant resolution: authenticated callers are locked to their own tenant;
  -- service-role / public contexts derive the tenant from the quote itself.
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

  -- Convert the linked lead → customer on first accept (idempotent: skipped if
  -- the quote already has a customer_id).
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

grant execute on function public.accept_quote(text) to authenticated, service_role;
