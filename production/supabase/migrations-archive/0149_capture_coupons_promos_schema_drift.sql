-- 0149_capture_coupons_promos_schema_drift.sql
-- ---------------------------------------------------------------------------
-- Captures the coupons / site_promos / coupon_redemptions subsystem that had
-- been created directly in prod with NO migration file (audit bug #34,
-- violates CLAUDE.md §17). Without this, a fresh environment rebuild silently
-- loses all coupon + site-promo functionality.
--
-- Definitions below are copied VERBATIM from the live prod catalog
-- (pg_get_functiondef / pg_get_constraintdef / pg_get_triggerdef / pg_policies).
--
-- IDEMPOTENT: every statement is CREATE ... IF NOT EXISTS / CREATE OR REPLACE /
-- guarded, so on prod (where all objects already exist) this is a safe no-op,
-- and on a fresh rebuild it creates the whole subsystem. Inline table
-- constraints only fire on a fresh CREATE (skipped entirely on prod), so prod's
-- live constraints are never touched.
-- ---------------------------------------------------------------------------

-- ── Tables ─────────────────────────────────────────────────────────────────

create table if not exists public.coupons (
  code             text primary key,
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  description      text,
  discount_type    text not null default 'percent' check (discount_type = any (array['percent'::text, 'flat'::text])),
  discount_value   integer not null check (discount_value > 0),
  applies_to_tier  text,
  applies_to_vendor text default 'google',
  min_seats        integer not null default 1,
  max_seats        integer,
  max_redemptions  integer,
  redemption_count integer not null default 0,
  valid_from       timestamptz not null default now(),
  valid_until      timestamptz,
  is_active        boolean not null default true,
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists coupons_tenant_idx on public.coupons using btree (tenant_id);
create index if not exists coupons_active_idx on public.coupons using btree (tenant_id, is_active) where (is_active = true);

create table if not exists public.site_promos (
  id               text primary key,
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  headline         text not null,
  subheadline      text,
  badge_text       text,
  discount_type    text not null check (discount_type = any (array['percent'::text, 'flat'::text])),
  discount_value   integer not null check (discount_value > 0),
  applies_to_tier  text,
  applies_to_vendor text default 'google',
  min_seats        integer not null default 1 check (min_seats > 0),
  max_seats        integer,
  banner_style     text not null default 'amber' check (banner_style = any (array['amber'::text, 'rose'::text, 'emerald'::text, 'indigo'::text, 'ink'::text])),
  valid_from       timestamptz not null default now(),
  valid_until      timestamptz,
  is_active        boolean not null default true,
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint site_promos_check check ((max_seats is null) or (max_seats >= min_seats))
);
create index if not exists idx_site_promos_tenant_active on public.site_promos using btree (tenant_id, is_active);

create table if not exists public.coupon_redemptions (
  id            uuid primary key default gen_random_uuid(),
  coupon_code   text not null references public.coupons(code) on delete cascade,
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  quote_id      text references public.quotes(id) on delete set null,
  lead_id       text references public.leads(id) on delete set null,
  contact_email text,
  contact_name  text,
  tier_id       text,
  seats         integer,
  amount_saved  integer not null,
  redeemed_at   timestamptz not null default now()
);
create index if not exists coupon_red_code_idx   on public.coupon_redemptions using btree (coupon_code);
create index if not exists coupon_red_tenant_idx on public.coupon_redemptions using btree (tenant_id);

-- ── RLS ─────────────────────────────────────────────────────────────────────

alter table public.coupons            enable row level security;
alter table public.site_promos        enable row level security;
alter table public.coupon_redemptions enable row level security;

-- Policies — guarded so prod's live policies are never dropped/recreated.
do $$
begin
  -- coupons
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='coupons' and policyname='coupons_select') then
    create policy coupons_select on public.coupons for select to authenticated using (tenant_id = current_tenant_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='coupons' and policyname='coupons_insert') then
    create policy coupons_insert on public.coupons for insert to authenticated with check (tenant_id = current_tenant_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='coupons' and policyname='coupons_update') then
    create policy coupons_update on public.coupons for update to authenticated using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='coupons' and policyname='coupons_delete') then
    create policy coupons_delete on public.coupons for delete to authenticated using (tenant_id = current_tenant_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='coupons' and policyname='coupons_service_role') then
    create policy coupons_service_role on public.coupons for all to service_role using (true) with check (true);
  end if;

  -- coupon_redemptions
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='coupon_redemptions' and policyname='coupon_red_select') then
    create policy coupon_red_select on public.coupon_redemptions for select to authenticated using (tenant_id = current_tenant_id());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='coupon_redemptions' and policyname='coupon_red_service_role') then
    create policy coupon_red_service_role on public.coupon_redemptions for all to service_role using (true) with check (true);
  end if;

  -- site_promos (policies apply to all roles; gated by the tenant subquery)
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='site_promos' and policyname='site_promos_tenant_read') then
    create policy site_promos_tenant_read on public.site_promos for select
      using (tenant_id = (select users.tenant_id from public.users where users.id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='site_promos' and policyname='site_promos_tenant_write') then
    create policy site_promos_tenant_write on public.site_promos for all
      using (tenant_id = (select users.tenant_id from public.users where users.id = auth.uid()))
      with check (tenant_id = (select users.tenant_id from public.users where users.id = auth.uid()));
  end if;
end $$;

-- Table grants (match the Supabase default the prod tables carry).
grant all on table public.coupons            to anon, authenticated, service_role;
grant all on table public.site_promos        to anon, authenticated, service_role;
grant all on table public.coupon_redemptions to anon, authenticated, service_role;

-- ── Trigger functions ───────────────────────────────────────────────────────

create or replace function public.coupons_touch()
 returns trigger
 language plpgsql
as $function$
begin new.updated_at := now(); return new; end;
$function$;

create or replace function public.site_promos_touch_updated_at()
 returns trigger
 language plpgsql
as $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;

drop trigger if exists trg_coupons_updated on public.coupons;
create trigger trg_coupons_updated before update on public.coupons
  for each row execute function public.coupons_touch();

drop trigger if exists trg_site_promos_touch on public.site_promos;
create trigger trg_site_promos_touch before update on public.site_promos
  for each row execute function public.site_promos_touch_updated_at();

-- ── Business functions (SECURITY DEFINER) ────────────────────────────────────

create or replace function public.create_site_promo(p_tenant_id uuid, p_headline text, p_subheadline text, p_badge_text text, p_discount_type text, p_discount_value integer, p_applies_to_tier text, p_min_seats integer, p_max_seats integer, p_banner_style text, p_valid_until timestamp with time zone, p_created_by uuid)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_id text;
begin
  v_id := 'SP-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
  insert into site_promos (
    id, tenant_id, headline, subheadline, badge_text,
    discount_type, discount_value,
    applies_to_tier, min_seats, max_seats,
    banner_style, valid_until, created_by
  ) values (
    v_id, p_tenant_id, p_headline, p_subheadline, p_badge_text,
    p_discount_type, p_discount_value,
    p_applies_to_tier, coalesce(p_min_seats, 1), p_max_seats,
    coalesce(p_banner_style, 'amber'), p_valid_until, p_created_by
  );
  return v_id;
end;
$function$;

create or replace function public.get_active_site_promo(p_tenant_id uuid, p_tier_id text DEFAULT NULL::text, p_seats integer DEFAULT NULL::integer)
 returns site_promos
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_row site_promos;
begin
  select sp.*
  into v_row
  from site_promos sp
  where sp.tenant_id = p_tenant_id
    and sp.is_active = true
    and sp.valid_from <= now()
    and (sp.valid_until is null or sp.valid_until > now())
    and (sp.applies_to_tier is null or p_tier_id is null
         or lower(sp.applies_to_tier) = lower(p_tier_id))
    and (p_seats is null or p_seats >= sp.min_seats)
    and (sp.max_seats is null or p_seats is null or p_seats <= sp.max_seats)
  order by sp.updated_at desc
  limit 1;
  return v_row;  -- null row if none match
end;
$function$;

create or replace function public.redeem_coupon(p_code text, p_tenant_id uuid, p_tier_id text, p_seats integer, p_gross_amount integer, p_quote_id text DEFAULT NULL::text, p_lead_id text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_name text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_coupon       record;
  v_discount     integer;
  v_now          timestamptz := now();
begin
  -- Lock + load
  select * into v_coupon
  from public.coupons
  where code = upper(trim(p_code)) and tenant_id = p_tenant_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'invalid_code');
  end if;

  if not v_coupon.is_active then
    return jsonb_build_object('ok', false, 'reason', 'inactive');
  end if;
  if v_coupon.valid_from > v_now then
    return jsonb_build_object('ok', false, 'reason', 'not_started');
  end if;
  if v_coupon.valid_until is not null and v_coupon.valid_until < v_now then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if v_coupon.max_redemptions is not null
     and v_coupon.redemption_count >= v_coupon.max_redemptions then
    return jsonb_build_object('ok', false, 'reason', 'maxed_out');
  end if;
  if v_coupon.applies_to_tier is not null
     and lower(v_coupon.applies_to_tier) <> lower(coalesce(p_tier_id, '')) then
    return jsonb_build_object('ok', false, 'reason', 'wrong_tier',
      'required_tier', v_coupon.applies_to_tier);
  end if;
  if p_seats < v_coupon.min_seats then
    return jsonb_build_object('ok', false, 'reason', 'min_seats_not_met',
      'min_seats', v_coupon.min_seats);
  end if;
  if v_coupon.max_seats is not null and p_seats > v_coupon.max_seats then
    return jsonb_build_object('ok', false, 'reason', 'max_seats_exceeded',
      'max_seats', v_coupon.max_seats);
  end if;

  -- Compute discount in paise — clamp to gross amount
  if v_coupon.discount_type = 'percent' then
    v_discount := round(p_gross_amount * v_coupon.discount_value / 100.0);
  else
    v_discount := v_coupon.discount_value;
  end if;
  v_discount := least(v_discount, p_gross_amount);

  -- Record redemption + bump counter
  insert into public.coupon_redemptions (
    coupon_code, tenant_id, quote_id, lead_id, contact_email, contact_name,
    tier_id, seats, amount_saved
  ) values (
    v_coupon.code, p_tenant_id, p_quote_id, p_lead_id, p_email, p_name,
    p_tier_id, p_seats, v_discount
  );

  update public.coupons
    set redemption_count = redemption_count + 1
    where code = v_coupon.code;

  return jsonb_build_object(
    'ok',             true,
    'discount',       v_discount,
    'discount_type',  v_coupon.discount_type,
    'discount_value', v_coupon.discount_value,
    'code',           v_coupon.code
  );
end;
$function$;

-- ── Function EXECUTE grants (deny-by-default since 0145) ──────────────────────

grant execute on function public.coupons_touch()                 to anon, authenticated, service_role;
grant execute on function public.site_promos_touch_updated_at()  to anon, authenticated, service_role;
grant execute on function public.create_site_promo(uuid, text, text, text, text, integer, text, integer, integer, text, timestamptz, uuid) to authenticated, service_role;
grant execute on function public.get_active_site_promo(uuid, text, integer) to authenticated, service_role;
grant execute on function public.redeem_coupon(text, uuid, text, integer, integer, text, text, text, text) to authenticated, service_role;
