-- 20260816101730_add_lead_pipeline
--
-- WHAT THIS CHANGES
--   Adds `leads.pipeline` — which sales motion a deal belongs to:
--     new_logo   winning a customer who is not ours yet
--     migration  moving a customer off another reseller or vendor
--     renewal    renewing or expanding an existing customer
--
-- WHY IT IS BACKFILLED FROM subscription_type RATHER THAN STARTED EMPTY
--   `leads.subscription_type` already carries 'fresh' | 'switch', which is two thirds of
--   the same idea under a different name. Adding an independent column and leaving it
--   blank would create a FOURTH overlapping vocabulary in this codebase — it already has
--   three product-price lists that drifted apart (PRODUCTS_BY_VENDOR, the lead form's
--   PLAN_PRICE_PER_SEAT_PM, and the `items` catalog), and every one of them was written
--   in good faith.
--
--   So the two are tied together at the start:
--       subscription_type = 'fresh'   ->  pipeline = 'new_logo'
--       subscription_type = 'switch'  ->  pipeline = 'migration'
--       NULL                          ->  pipeline = 'new_logo'  (the default motion)
--
--   They can diverge afterwards — a rep may recategorise — and that is fine. What
--   matters is that they do not start life disagreeing.
--
-- WHY 'renewal' HAS NO BACKFILL
--   Nothing in `leads` identifies a renewal today. Renewals live on `subscriptions`
--   (renewal_date, auto_renew) and are worked from /renewals, not from the lead inbox.
--   The value exists because the brief asks for the motion and a rep can select it — but
--   guessing which existing leads are renewals would put a made-up category on real
--   deals. Nothing is guessed here.
--
-- HOW TO VERIFY (SEPARATE run from the DDL — AGENTS.md §5):
--
--   select pipeline, subscription_type, count(*)
--     from public.leads group by 1, 2 order by 1, 2;
--
--   Expect: no row where pipeline='new_logo' and subscription_type='switch', and none
--   where pipeline='migration' and subscription_type='fresh'.

begin;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'lead_pipeline') then
    create type public.lead_pipeline as enum ('new_logo', 'migration', 'renewal');
  end if;
end $$;

alter table public.leads
  add column if not exists pipeline public.lead_pipeline not null default 'new_logo';

comment on column public.leads.pipeline is
  'Which sales motion this deal belongs to. Seeded from subscription_type (fresh -> new_logo, switch -> migration) so the two do not start life disagreeing; they may diverge afterwards. "renewal" is never inferred — nothing in leads identifies one.';

update public.leads
   set pipeline = case subscription_type
                    when 'switch' then 'migration'::public.lead_pipeline
                    else 'new_logo'::public.lead_pipeline
                  end
 where pipeline = 'new_logo';

create index if not exists leads_pipeline_idx
  on public.leads (tenant_id, pipeline);

commit;
