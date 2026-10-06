-- ============================================================================
-- Packages — a tenant's own named bundles of catalogue items (2 Oct 2026).
--
-- Pardeep: "packges ka world class system bana do". Until now a "package" was three
-- bundles hardcoded in lib/quotes/bundles.ts that found their parts by keyword
-- ("backup", "ssl") — this catalogue stocks neither, so every package added part of
-- itself, and nobody could make or change one.
--
-- A package is a recipe, not a product: it points at catalogue rows and says how
-- many of each (per seat, or a fixed count) and whether the deal stands without it.
-- It has no price of its own — the price is the catalogue's, less the package's
-- discount, computed at quote time (lib/packages/price.ts). So a catalogue price
-- change flows into every package without anyone re-saving it.
--
-- Reads: anyone in the tenant (the quote builder shows them to every rep).
-- Writes: owner / manager only — a package carries a discount, which is pricing.
-- ============================================================================
begin;

create table if not exists public.packages (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 2 and 80),
  pitch         text check (pitch is null or char_length(pitch) <= 240),
  -- Off the catalogue price of every line in the package. Capped: a package is a
  -- nudge to buy the set, not a way around the approval rules for deep discounts.
  discount_pct  numeric(5,2) not null default 0 check (discount_pct >= 0 and discount_pct <= 30),
  is_active     boolean not null default true,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, name)
);

create table if not exists public.package_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  package_id  uuid not null references public.packages(id) on delete cascade,
  item_id     text not null references public.items(id) on delete cascade,
  -- per_seat: sized to the quote's seat count. fixed: always fixed_qty (a domain, one support plan).
  qty_mode    text not null default 'per_seat' check (qty_mode in ('per_seat', 'fixed')),
  fixed_qty   integer check (fixed_qty is null or fixed_qty > 0),
  optional    boolean not null default false,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  unique (package_id, item_id),
  check (qty_mode = 'per_seat' or fixed_qty is not null)
);

create index if not exists packages_tenant_idx on public.packages (tenant_id, is_active, sort_order);
create index if not exists package_items_package_idx on public.package_items (package_id, sort_order);

do $$
declare t text;
begin
  foreach t in array array['packages', 'package_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "%s_select" on public.%I', t, t);
    execute format('create policy "%s_select" on public.%I for select to authenticated using (tenant_id = (select public.current_tenant_id()))', t, t);
    execute format('drop policy if exists "%s_write" on public.%I', t, t);
    execute format($p$create policy "%s_write" on public.%I for all to authenticated
                     using (tenant_id = (select public.current_tenant_id()) and public.current_user_has_role('owner', 'manager'))
                     with check (tenant_id = (select public.current_tenant_id()) and public.current_user_has_role('owner', 'manager'))$p$, t, t);
    execute format('drop policy if exists zzz_service_role_all on public.%I', t);
    execute format('create policy zzz_service_role_all on public.%I as permissive for all to service_role using (true) with check (true)', t);
  end loop;
end $$;

/* A package line must point at an item of the SAME tenant — a foreign key alone would
   let one tenant's package reference another's catalogue row by id. */
create or replace function public.package_items_same_tenant()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.packages p where p.id = new.package_id and p.tenant_id = new.tenant_id) then
    raise exception 'package % is not in tenant %', new.package_id, new.tenant_id;
  end if;
  if not exists (select 1 from public.items i where i.id = new.item_id and i.tenant_id = new.tenant_id) then
    raise exception 'item % is not in tenant %', new.item_id, new.tenant_id;
  end if;
  return new;
end $$;

drop trigger if exists package_items_same_tenant on public.package_items;
create trigger package_items_same_tenant before insert or update on public.package_items
  for each row execute function public.package_items_same_tenant();

create or replace function public.packages_touch_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists packages_touch_updated_at on public.packages;
create trigger packages_touch_updated_at before update on public.packages
  for each row execute function public.packages_touch_updated_at();

grant select, insert, update, delete on public.packages, public.package_items to authenticated;

/* Save a package and its parts in ONE transaction — header + delete-and-reinsert of the
   parts. Two client calls would leave a package with no parts when the second fails.
   SECURITY INVOKER: the caller's RLS applies, so a rep (not owner/manager) is refused
   by the write policy, not by a check that could drift from it. */
create or replace function public.save_package(
  p_id uuid, p_name text, p_pitch text, p_discount_pct numeric, p_is_active boolean, p_items jsonb
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_id uuid;
begin
  if v_tenant is null then raise exception 'not signed in to a tenant'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'a package needs at least one item';
  end if;

  if p_id is null then
    insert into public.packages (tenant_id, name, pitch, discount_pct, is_active)
    values (v_tenant, btrim(p_name), nullif(btrim(coalesce(p_pitch, '')), ''), coalesce(p_discount_pct, 0), coalesce(p_is_active, true))
    returning id into v_id;
  else
    update public.packages
       set name = btrim(p_name), pitch = nullif(btrim(coalesce(p_pitch, '')), ''),
           discount_pct = coalesce(p_discount_pct, 0), is_active = coalesce(p_is_active, true)
     where id = p_id and tenant_id = v_tenant
    returning id into v_id;
    if v_id is null then raise exception 'package not found or not yours to change'; end if;
    delete from public.package_items where package_id = v_id;
  end if;

  insert into public.package_items (tenant_id, package_id, item_id, qty_mode, fixed_qty, optional, sort_order)
  select v_tenant, v_id, x->>'item_id', coalesce(x->>'qty_mode', 'per_seat'),
         nullif(x->>'fixed_qty', '')::integer, coalesce((x->>'optional')::boolean, false),
         (ord - 1)::integer
    from jsonb_array_elements(p_items) with ordinality as t(x, ord);

  return v_id;
end $$;

revoke all on function public.save_package(uuid, text, text, numeric, boolean, jsonb) from public, anon;
grant execute on function public.save_package(uuid, text, text, numeric, boolean, jsonb) to authenticated;

/* ── Starter packages, from each tenant's own catalogue ───────────────────────
   One per main licence product that has its product-wise support add-on
   (20261002160000): "<product> + Support", the licence per seat and one yearly
   support plan. No discount — the operator decides that. Idempotent. */
insert into public.packages (tenant_id, name, pitch, discount_pct, sort_order)
select p.tenant_id,
       left(p.name || ' + Support', 80),
       'Licences plus our support plan — priority help, WhatsApp, live calls.',
       0,
       row_number() over (partition by p.tenant_id order by p.vendor, p.msrp)
  from public.items p
  join public.items s on s.id = 'SUP-' || p.id || '-YR' and s.tenant_id = p.tenant_id
 where p.kind = 'main' and p.item_type = 'subscription'
   and p.vendor in ('google', 'microsoft', 'zoho') and p.is_active
on conflict (tenant_id, name) do nothing;

insert into public.package_items (tenant_id, package_id, item_id, qty_mode, fixed_qty, optional, sort_order)
select pk.tenant_id, pk.id, x.item_id, x.qty_mode, x.fixed_qty, false, x.ord
  from public.packages pk
  join public.items p on p.tenant_id = pk.tenant_id and pk.name = left(p.name || ' + Support', 80)
 cross join lateral (values
   (p.id,                     'per_seat', null::integer, 0),
   ('SUP-' || p.id || '-YR',  'fixed',    1,             1)
 ) as x(item_id, qty_mode, fixed_qty, ord)
 where exists (select 1 from public.items i where i.id = x.item_id and i.tenant_id = pk.tenant_id)
on conflict (package_id, item_id) do nothing;

comment on table public.packages is 'A tenant''s named bundle of catalogue items (a recipe — priced from the catalogue at quote time, less discount_pct).';
comment on table public.package_items is 'One catalogue item in a package: per seat or a fixed count, required or optional.';

commit;
