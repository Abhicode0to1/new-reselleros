-- 0248_subscriptions_item_id.sql
--
-- Give `subscriptions` a real link to the catalog: `item_id`.
--
-- ─── WHY ─────────────────────────────────────────────────────────────────────
-- Until now the only link between a subscription and its catalog row was the plan
-- TEXT, and the two are written from different vocabularies: the add-subscription
-- dialog writes from a hardcoded list that never consults the catalog. Measured on
-- 14 Aug 2026, an exact name match found a catalog row for only 6 of the 29 products
-- that dialog can write — missing "Google Workspace Business Standard" and
-- "…Business Plus", the two highest-volume Google plans, because the catalog calls
-- them "Google Workspace Standard" and "Google Workspace Plus".
--
-- Everything that needs a vendor COST goes through that link: the add-seats quote
-- line, the draft purchase order sent to the distributor, and margin reporting. A
-- missed link silently fell back to a hardcoded 17% margin, which is ₹224 against a
-- real ₹110 on Business Starter — double.
--
-- A normaliser (lib/subscriptions/plan-match.ts) papers over the mismatch for reads.
-- This is the actual fix: store the id, so renaming a catalog row cannot break the
-- link at all.
--
-- ─── WHY A TRIGGER AND NOT SIX EDITED CALL SITES ─────────────────────────────
-- Subscriptions are created from at least six places: three client dialogs (manual
-- add, CSV import, Google import), the `record_payment` RPC — which is where most of
-- them really come from, when a quote is paid — the inbound-purchase webhook, and the
-- public checkout route. Editing each one leaves the NEXT write path to be forgotten,
-- which is exactly how this app ended up with three role vocabularies and a plan
-- vocabulary that does not match its own catalog. The trigger resolves item_id at
-- write time wherever the row comes from, and an explicitly supplied item_id always
-- wins over it.
--
-- ─── WHAT IT REFUSES TO DO ───────────────────────────────────────────────────
-- Links ONLY when exactly one catalog row in the same tenant AND the same vendor
-- normalises to the same key. Two candidates → no link. The catalog has one
-- "Google Workspace Enterprise" while the dialog sells Enterprise Starter / Standard
-- / Plus; guessing there would put an invented cost behind a real margin figure and a
-- real purchase order. An unlinked subscription is a visible gap. A wrongly linked one
-- is a number someone trusts.
--
-- Applied 14 Aug 2026. There are 0 subscriptions in the database at this point (the
-- tenant reset), so the backfill below is a no-op here and exists to be correct for
-- any tenant restored from a backup.

begin;

-- ── 1. plan_key(): the SQL twin of lib/subscriptions/plan-match.ts:planKey ────
--
-- Lowercase, non-alphanumeric to spaces, drop the filler word "business" — that one
-- word is the whole difference between the dialog's names and the catalog's. Written
-- as split → filter → join, exactly like the TypeScript, rather than as a clever
-- regex: a regex with /g/ and overlapping matches diverges from the TS on inputs like
-- "business business", and two functions that are supposed to agree must not have
-- separate edge cases. WITH ORDINALITY + ORDER BY because word order is not otherwise
-- guaranteed through unnest → string_agg.
create or replace function public.plan_key(p_name text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(
    (select string_agg(w, ' ' order by ord)
       from unnest(
         regexp_split_to_array(
           regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', ' ', 'g'),
           ' '
         )
       ) with ordinality as t(w, ord)
      where w <> '' and w <> 'business'),
    ''
  );
$$;

comment on function public.plan_key(text) is
  'Comparable key for a product name (lowercase, punctuation stripped, filler word "business" dropped). Twin of planKey() in lib/subscriptions/plan-match.ts — change both together.';

commit;

begin;

-- ── 2. The column + a TENANT-SAFE foreign key ────────────────────────────────
--
-- items_pkey is PRIMARY KEY (id) alone, so a plain `item_id references items(id)`
-- would happily point at ANOTHER tenant's catalog row — and the cost read through it
-- would be another tenant's price. CLAUDE.md §4 requires foreign keys to stay inside
-- tenant boundaries, so this is composite on (tenant_id, item_id).
--
-- MATCH SIMPLE (the default) means the constraint is not enforced when any column of
-- the key is NULL, so a subscription with no item_id is allowed — which is the normal
-- state for the 21-of-29 products that have no catalog row.
--
-- NOTE, not a change made here: subscriptions' existing customer_id / quote_id /
-- renewal_quote_id FKs are all single-column and therefore cross-tenant-capable too.
-- Tightening them is a separate piece of work with its own backfill risk.
alter table public.items
  add constraint items_tenant_id_id_key unique (tenant_id, id);

alter table public.subscriptions
  add column if not exists item_id text;

alter table public.subscriptions
  add constraint subscriptions_item_fkey
  foreign key (tenant_id, item_id)
  references public.items (tenant_id, id)
  on delete set null;

comment on column public.subscriptions.item_id is
  'Catalog row this subscription sells, for vendor cost / margin. NULL when the plan has no catalog row (normal). Auto-filled by trg_subscriptions_resolve_item when unambiguous; an explicit value always wins.';

create index if not exists subscriptions_tenant_item_idx
  on public.subscriptions (tenant_id, item_id);

commit;

begin;

-- ── 3. Resolve at write time, from wherever the row came from ────────────────
/* INVOKER rights, deliberately — not SECURITY DEFINER. items_select is
   `tenant_id = current_tenant_id()` with no role condition (verified in pg_policy),
   so every member of a tenant can already read their own catalog, and the trigger
   filters on new.tenant_id anyway. The service_role and SECURITY DEFINER callers
   (record_payment) bypass RLS on their own. Nothing here needs elevation, so it does
   not get any. */
create or replace function public.subscriptions_resolve_item()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_id     text;
  v_count  int;
begin
  -- An explicitly supplied item_id is never second-guessed.
  if new.item_id is not null then
    return new;
  end if;
  if new.plan is null or new.tenant_id is null then
    return new;
  end if;

  /* Same tenant, same vendor, same normalised name. Vendor is part of the match
     because "Standard" exists under google, hosting and support in this tenant's own
     catalog — a mix-up would price a Google seat at hosting's ₹0 and invent a 100%
     margin. */
  select count(*), min(i.id)
    into v_count, v_id
    from public.items i
   where i.tenant_id = new.tenant_id
     and i.vendor::text = new.vendor::text
     and public.plan_key(i.name) = public.plan_key(new.plan);

  -- Exactly one candidate, or nothing. Stricter than the TypeScript, which tolerates
  -- duplicates that agree on price; here any ambiguity simply declines to link.
  if v_count = 1 then
    new.item_id := v_id;
  end if;

  return new;
end;
$$;

comment on function public.subscriptions_resolve_item() is
  'Fills subscriptions.item_id from the catalog when exactly one row of the same tenant + vendor matches plan_key(plan). Declines to guess when 0 or 2+ match.';

drop trigger if exists trg_subscriptions_resolve_item on public.subscriptions;

/* Fires on plan/vendor changes too: correcting a mis-typed plan in the Edit dialog
   should re-point the link, otherwise the cost stays attached to the wrong product
   with nothing on screen to say so. Only recomputes when item_id was not set by the
   caller. */
create trigger trg_subscriptions_resolve_item
  before insert or update of plan, vendor, item_id
  on public.subscriptions
  for each row
  execute function public.subscriptions_resolve_item();

commit;

begin;

-- ── 4. Backfill existing rows ────────────────────────────────────────────────
-- 0 rows today; correct for a tenant restored from backup.
update public.subscriptions s
   set item_id = m.id
  from (
    select s2.id as sub_id, min(i.id) as id
      from public.subscriptions s2
      join public.items i
        on i.tenant_id = s2.tenant_id
       and i.vendor::text = s2.vendor::text
       and public.plan_key(i.name) = public.plan_key(s2.plan)
     where s2.item_id is null
     group by s2.id
    having count(*) = 1
  ) m
 where s.id = m.sub_id
   and s.item_id is null;

commit;

