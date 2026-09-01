-- Brick #2 of the merge: ingest the domain rate card from the DMS engine
-- (app.anutech.in, GET /api/public/tld-pricing) into THIS app's catalogue, so
-- ResellerOS can sell domains under Anutech Digital's GST billing while
-- ResellerClub still registers them. Sibling of sync_hosting_catalog
-- (20260901170000) — same shape, same "one source of price" (Pardeep's
-- auto-sync choice, 1 Sep 2026): the engine's register price is the catalogue's
-- price, refreshed each sync; a hand-set cost survives.
--
-- The caller (POST /api/catalog/sync-domains) fetches tld-pricing and passes
-- the rows in as p_tlds: [{ tld: ".in", register, renew, transfer, currency }].
--
-- MODELLING: a domain is a ONE-TIME yearly registration (item_type='one_time'),
-- not a per-seat/month subscription — so it lands in the Items Catalog, not the
-- Subscription Catalog whose price column is "/seat/mo". msrp = the 1-year
-- register price; renew/transfer are kept in `prices`.
--
-- MONEY NOTES (Pardeep-confirmable defaults):
--   • Whole rupees (§13); tld-pricing already returns rounded integers.
--   • wholesale defaults to msrp (breakeven) and is PRESERVED on re-sync — the
--     public feed carries no reseller cost.
--   • HSN defaults to 998319 (other IT services) for domain registration —
--     confirm with the CA (hosting used 998315).
--   • A TLD whose register price is missing/<= 0 is SKIPPED, never sold at ₹0.

create or replace function public.sync_domain_catalog(p_tlds jsonb)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_row    jsonb;
  v_tld    text;
  v_id     text;
  v_reg    integer;
  v_count  integer := 0;
begin
  if v_tenant is null then
    raise exception 'No tenant in context' using errcode = 'insufficient_privilege';
  end if;
  if not public.current_user_is_owner() then
    raise exception 'Only an owner can sync the catalogue' using errcode = 'insufficient_privilege';
  end if;
  if jsonb_typeof(p_tlds) is distinct from 'array' then
    raise exception 'p_tlds must be a JSON array' using errcode = 'invalid_parameter_value';
  end if;

  for v_row in select * from jsonb_array_elements(p_tlds)
  loop
    v_tld := lower(nullif(trim(v_row->>'tld'), ''));
    if v_tld is null then continue; end if;               -- malformed → skip, don't fail the batch
    v_reg := round(coalesce((v_row->>'register')::numeric, 0))::int;
    if v_reg <= 0 then continue; end if;                  -- no price → never a ₹0 domain

    -- ".co.in" → "COIN"; id is globally unique (items.id is a global pk).
    v_id := 'DOMAIN-' || upper(regexp_replace(v_tld, '[^a-z0-9]', '', 'g'))
            || '-' || substr(replace(v_tenant::text, '-', ''), 1, 6);

    insert into public.items (
      id, tenant_id, name, vendor, hsn, msrp, wholesale,
      item_type, kind, is_active, prices, synced_from_partner_id
    ) values (
      v_id, v_tenant,
      'Domain ' || v_tld,
      'domain', '998319', v_reg, v_reg,
      'one_time', 'main', true,
      jsonb_build_object(
        'msrp',     v_reg,
        'register', v_reg,
        'renew',    v_row->'renew',
        'transfer', v_row->'transfer',
        'currency', coalesce(v_row->>'currency', 'INR')
      ),
      v_tld
    )
    on conflict (id) do update set
      name       = excluded.name,
      vendor     = 'domain',
      hsn        = coalesce(public.items.hsn, excluded.hsn),
      msrp       = excluded.msrp,                 -- auto-sync: refresh from engine
      wholesale  = public.items.wholesale,        -- keep any hand-set cost
      is_active  = true,
      prices     = excluded.prices,
      synced_from_partner_id = excluded.synced_from_partner_id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

grant execute on function public.sync_domain_catalog(jsonb) to authenticated;
