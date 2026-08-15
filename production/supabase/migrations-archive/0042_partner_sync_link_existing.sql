-- 0042_partner_sync_link_existing.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds the p_link_existing_id parameter to sync_partner_item so the UI can
-- offer "Link existing row" instead of cloning when the child already has
-- a row that visibly matches the parent's SKU (same name / vendor / kind).
--
-- Behaviour priority when called:
--   1. p_link_existing_id provided  → link that specific row, update wholesale
--   2. existing synced_from_partner_id match → refresh (idempotent re-sync)
--   3. neither                              → clone a fresh row (Slice 1 default)
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.sync_partner_item(
  p_partner_item_id  text,
  p_my_msrp          integer default null,
  p_link_existing_id text    default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_child_tenant  uuid;
  v_parent_tenant uuid;
  v_parent        items%rowtype;
  v_short         text;
  v_new_id        text;
  v_existing_id   text;
begin
  select u.tenant_id, t.parent_tenant_id
    into v_child_tenant, v_parent_tenant
  from public.users u
  join public.tenants t on t.id = u.tenant_id
  where u.id = auth.uid()
  limit 1;

  if v_parent_tenant is null then
    raise exception 'Your tenant is not linked to a distributor — cannot sync partner items';
  end if;

  select * into v_parent
  from public.items
  where id = p_partner_item_id
    and tenant_id = v_parent_tenant
    and is_partner_visible = true
    and is_active = true;

  if not found then
    raise exception 'Partner item % not found or not visible to your tenant', p_partner_item_id;
  end if;

  v_short := substr(v_child_tenant::text, 1, 3);

  -- 1. Caller asked to link a specific existing row → verify ownership, update.
  if p_link_existing_id is not null then
    if not exists (
      select 1 from public.items
      where id = p_link_existing_id and tenant_id = v_child_tenant
    ) then
      raise exception 'Cannot link to item % — not in your tenant', p_link_existing_id;
    end if;
    update public.items
      set synced_from_partner_id = p_partner_item_id,
          wholesale              = v_parent.partner_price,
          msrp                   = case when p_my_msrp is not null then p_my_msrp else msrp end,
          is_active              = true
      where id = p_link_existing_id and tenant_id = v_child_tenant;
    return p_link_existing_id;
  end if;

  -- 2. Already synced from this exact parent → idempotent refresh.
  select id into v_existing_id
  from public.items
  where tenant_id = v_child_tenant
    and synced_from_partner_id = p_partner_item_id
  limit 1;

  if v_existing_id is not null then
    update public.items
      set wholesale = v_parent.partner_price,
          msrp      = case when p_my_msrp is not null then p_my_msrp else msrp end,
          prices    = v_parent.prices,
          is_active = true,
          name      = v_parent.name,
          vendor    = v_parent.vendor,
          kind      = v_parent.kind,
          hsn       = v_parent.hsn
      where id = v_existing_id;
    return v_existing_id;
  end if;

  -- 3. New clone.
  v_new_id := regexp_replace(p_partner_item_id, '-[a-f0-9]{2,}$', '') || '-' || v_short;
  if exists (select 1 from public.items where id = v_new_id) then
    v_new_id := v_new_id || '-' || substr(md5(random()::text), 1, 4);
  end if;

  insert into public.items (
    id, tenant_id, name, vendor, kind, hsn,
    msrp, wholesale, prices, is_active,
    synced_from_partner_id, is_partner_visible, partner_price
  ) values (
    v_new_id, v_child_tenant, v_parent.name, v_parent.vendor, v_parent.kind, v_parent.hsn,
    coalesce(p_my_msrp, v_parent.msrp), v_parent.partner_price, v_parent.prices, true,
    p_partner_item_id, false, null
  );

  return v_new_id;
end $$;

revoke all on function public.sync_partner_item(text, integer, text) from public;
grant  execute on function public.sync_partner_item(text, integer, text) to authenticated;
