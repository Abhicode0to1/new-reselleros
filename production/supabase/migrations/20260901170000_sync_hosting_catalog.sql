-- Ingest hosting plans from the DMS engine (app.anutech.in) into THIS app's
-- own product catalogue, so ResellerOS can sell hosting under Anutech Digital's
-- GST billing while DirectAdmin still provisions it. Same "one source of price"
-- idea as the domain rate card — Pardeep picked auto-sync (1 Sep 2026): the
-- engine's price is the catalogue's price, refreshed on every sync.
--
-- The caller (POST /api/catalog/sync-hosting) fetches the DMS public API
-- (GET /api/public/hosting-plans) and passes the plans array in as p_plans.
-- Doing the write as ONE RPC keeps it atomic (all plans upsert together) and
-- consistent with sync_partner_item, the app's other catalogue-sync path.
--
-- Idempotent: each plan maps to a deterministic item id
--   HOST-<PLANID>-<tenant6>  (tenant fragment because items.id is a GLOBAL pk),
-- so a re-sync UPDATES the same row instead of duplicating it.
--
-- MONEY NOTES (both are Pardeep-confirmable, defaults chosen to be safe):
--   • DMS prices can be fractional rupees (e.g. 49.99). This app stores WHOLE
--     rupees (CLAUDE.md §13), so msrp = round(price). The raw value is kept in
--     `prices` for reference. These look like placeholder tiers anyway; the
--     imported number is a seed Pardeep can edit.
--   • The public API carries no reseller COST, so wholesale defaults to msrp
--     (breakeven) on first import and is PRESERVED on re-sync — a cost Pardeep
--     sets by hand is never clobbered by a later sync.
--   • HSN defaults to 998315 (hosting / IT-infrastructure provisioning). If the
--     CA wants a different head, change it here.

create or replace function public.sync_hosting_catalog(p_plans jsonb)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_plan   jsonb;
  v_planid text;
  v_id     text;
  v_msrp   integer;
  v_count  integer := 0;
begin
  if v_tenant is null then
    raise exception 'No tenant in context' using errcode = 'insufficient_privilege';
  end if;
  -- The catalogue is an owner-managed surface (same bar as editing an item).
  if not public.current_user_is_owner() then
    raise exception 'Only an owner can sync the catalogue' using errcode = 'insufficient_privilege';
  end if;
  if jsonb_typeof(p_plans) is distinct from 'array' then
    raise exception 'p_plans must be a JSON array' using errcode = 'invalid_parameter_value';
  end if;

  for v_plan in select * from jsonb_array_elements(p_plans)
  loop
    v_planid := nullif(trim(v_plan->>'planId'), '');
    if v_planid is null then continue; end if;  -- skip a malformed entry, don't fail the batch

    v_id   := 'HOST-' || upper(v_planid) || '-' || substr(replace(v_tenant::text, '-', ''), 1, 6);
    v_msrp := greatest(0, round(coalesce((v_plan->>'price')::numeric, 0))::int);

    insert into public.items (
      id, tenant_id, name, vendor, hsn, msrp, wholesale,
      item_type, kind, is_active, prices, synced_from_partner_id
    ) values (
      v_id, v_tenant,
      coalesce(nullif(trim(v_plan->>'name'), ''), initcap(v_planid) || ' Hosting'),
      'hosting', '998315', v_msrp, v_msrp,
      'subscription', 'main', true,
      jsonb_build_object(
        'msrp',         v_msrp,
        'price_raw',    v_plan->'price',
        'renewal',      v_plan->'renewalPrice',
        'currency',     coalesce(v_plan->>'currency', 'INR'),
        'period',       coalesce(v_plan->>'period', '/mo'),
        'quotaMB',      v_plan->'quotaMB',
        'bandwidthMB',  v_plan->'bandwidthMB',
        'features',     coalesce(v_plan->'features', '[]'::jsonb),
        'popular',      coalesce((v_plan->>'popular')::boolean, false)
      ),
      v_planid
    )
    on conflict (id) do update set
      name       = excluded.name,
      vendor     = 'hosting',
      hsn        = coalesce(public.items.hsn, excluded.hsn),
      -- Auto-sync: price refreshes from the engine (Pardeep's explicit choice).
      msrp       = excluded.msrp,
      -- Cost is NOT in the public feed — keep any hand-set wholesale.
      wholesale  = public.items.wholesale,
      is_active  = true,
      prices     = excluded.prices,
      synced_from_partner_id = excluded.synced_from_partner_id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

grant execute on function public.sync_hosting_catalog(jsonb) to authenticated;
