-- ============================================================================
-- Referral partner codes — so a partner can share a link and the leads it brings are
-- counted against them.
--
-- Before this a partner was linked only to a customer, by hand, through
-- referral_agreements — the partner had no way to send a lead in that the app would
-- recognise. The link is an ordinary tracking link (lib/marketing/tracking-link.ts):
--   /enquiry?utm_source=referral&utm_medium=partner&utm_campaign=<code>
-- The public form routes already store utm_* on the lead (captureFromRequest), so nothing on
-- the public side changes; the Referrals page counts leads where utm_source = 'referral' and
-- utm_campaign = the partner's code, and ROAS & CAC files them under the Referral channel.
--
-- The code is lower-case letters, digits and hyphens (the same shape slugCampaign
-- produces, so the link never rewrites it), unique per company, made from the name on
-- insert when none is given, with a numeric suffix on a clash.
-- ============================================================================

alter table public.referral_partners add column if not exists code text;

create or replace function public.referral_code_slug(p_name text)
returns text
language sql
immutable
set search_path = public
as $$
  select coalesce(nullif(left(trim(both '-' from regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g')), 24), ''), 'partner')
$$;

create or replace function public.tg_referral_partner_code()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_base text;
  v_try  text;
  v_n    int := 1;
begin
  if new.code is not null and new.code <> '' then
    new.code := public.referral_code_slug(new.code);
    return new;
  end if;
  v_base := public.referral_code_slug(new.name);
  v_try  := v_base;
  while exists (select 1 from public.referral_partners
                 where tenant_id = new.tenant_id and code = v_try and id is distinct from new.id) loop
    v_n := v_n + 1;
    v_try := v_base || '-' || v_n;
  end loop;
  new.code := v_try;
  return new;
end $$;

drop trigger if exists trg_referral_partner_code on public.referral_partners;
create trigger trg_referral_partner_code
  before insert or update of code on public.referral_partners
  for each row execute function public.tg_referral_partner_code();

-- Backfill, oldest first so the earliest partner keeps the plain code.
do $$
declare r record;
begin
  for r in select id from public.referral_partners where code is null order by created_at, id loop
    update public.referral_partners set code = null where id = r.id;   -- fires the trigger
  end loop;
end $$;

create unique index if not exists referral_partners_tenant_code_uidx
  on public.referral_partners (tenant_id, code);
