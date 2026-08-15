-- 0068_portal_shop_rpcs.sql
-- Customer-portal cross-sell ("Buy more products"):
--   * portal_list_products()  — the catalog a logged-in customer may browse
--   * portal_request_quote()  — turns a customer's interest into a LEAD in the
--                               reseller's own pipeline (no payment taken)
--
-- Why RPCs (not direct table reads/writes):
--   A portal customer is in `customer_users`, NOT `users`, so operator RLS
--   (tenant via users) returns NOTHING for them on `items`/`leads`. More
--   importantly, `items` carries reseller-only economics — `wholesale`,
--   `margin_pct`, `partner_price` — which a CUSTOMER must never see. These
--   SECURITY DEFINER functions scope strictly to the caller's own tenant
--   (resolved from auth.uid() → customer_users) and return ONLY customer-safe
--   fields. The lead insert bypasses operator RLS by design (definer), but can
--   only ever create a lead in the caller's own tenant for the caller's own
--   customer identity — no cross-tenant surface.

-- ── 1. Catalog the customer may browse ─────────────────────────────────────
-- Returns active "main" SKUs for the caller's tenant. Price is the annual-commit
-- ₹/seat/month (best rate), falling back to the flat msrp. NO wholesale/margin.
create or replace function public.portal_list_products()
returns table (
  id                   text,
  name                 text,
  vendor               text,
  price_per_seat_month int,
  hsn                  text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    i.id,
    i.name,
    i.vendor::text,
    coalesce(
      nullif((i.prices->'annual'->>'msrp'), '')::int,
      i.msrp
    ) as price_per_seat_month,
    i.hsn
  from public.items i
  where i.is_active = true
    and i.kind = 'main'
    and i.tenant_id = (
      select cu.tenant_id from public.customer_users cu
      where cu.auth_user_id = auth.uid()
      limit 1
    )
  order by coalesce(nullif((i.prices->'annual'->>'msrp'),'')::int, i.msrp) asc, i.name asc;
$$;

grant execute on function public.portal_list_products() to authenticated;

-- ── 2. Customer requests a quote → creates a lead in the reseller pipeline ──
-- Returns the new lead id. Raises on bad input / unknown item / no session.
create or replace function public.portal_request_quote(
  p_item_id text,
  p_seats   int,
  p_note    text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_customer  record;
  v_item      record;
  v_seats     int;
  v_rate      int;
  v_value     int;
  v_lead_id   text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  -- Caller's customer identity (+ tenant) from their portal link.
  select c.id as customer_id, c.tenant_id, c.name, c.contact_email,
         c.contact_phone, c.gstin, c.state, c.state_code
    into v_customer
  from public.customer_users cu
  join public.customers c on c.id = cu.customer_id
  where cu.auth_user_id = v_uid
  limit 1;

  if v_customer.customer_id is null then
    raise exception 'no customer account' using errcode = 'no_data_found';
  end if;

  -- Validate the item belongs to the SAME tenant + is sellable.
  select i.id, i.name,
         coalesce(nullif((i.prices->'annual'->>'msrp'),'')::int, i.msrp) as rate
    into v_item
  from public.items i
  where i.id = p_item_id
    and i.tenant_id = v_customer.tenant_id
    and i.is_active = true
    and i.kind = 'main'
  limit 1;

  if v_item.id is null then
    raise exception 'product not available' using errcode = 'no_data_found';
  end if;

  v_seats := greatest(1, least(coalesce(p_seats, 1), 100000));
  v_rate  := coalesce(v_item.rate, 0);
  v_value := v_seats * v_rate * 12;   -- annual ₹ (display/pipeline value)

  v_lead_id := 'L-' || upper(substr(md5(gen_random_uuid()::text), 1, 10));

  insert into public.leads (
    id, tenant_id, company, contact_name, contact_email, contact_phone,
    plan, seats, value, stage, source, priority, gstin, state, state_code, notes
  ) values (
    v_lead_id,
    v_customer.tenant_id,
    v_customer.name,
    v_customer.name,
    v_customer.contact_email,
    v_customer.contact_phone,
    v_item.name,
    v_seats,
    v_value,
    'new',
    'Customer Portal',
    'high',                       -- existing customer asking to buy more = hot
    v_customer.gstin,
    v_customer.state,
    v_customer.state_code,
    'Portal upsell request from existing customer "' || v_customer.name ||
      '" for ' || v_item.name || ' × ' || v_seats || ' seats.' ||
      case when p_note is not null and length(trim(p_note)) > 0
           then ' Note: ' || left(trim(p_note), 500) else '' end
  );

  return v_lead_id;
end;
$$;

grant execute on function public.portal_request_quote(text, int, text) to authenticated;
