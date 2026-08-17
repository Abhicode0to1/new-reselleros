-- 20260817170100_stamp_support_ticket_sla
--
-- Stamp the tier and the SLA deadline when a ticket is raised.
--
-- ─── WHY A TRIGGER ──────────────────────────────────────────────────────────
-- Three different things create a support ticket today:
--   · api/webhooks/inbound-email  — a customer emails support
--   · (public)/portal/support/new — a customer raises one in the portal
--   · components/shared/feedback-dialog — raised from inside the app
--
-- Stamping in each of them is one rule written three times, and the fourth caller
-- will not remember it. The fact belongs on the ROW, so it is stamped where every
-- path has to pass.
--
-- It also means the SLA hours live in exactly one place that MATTERS. lib/support/
-- tiers.ts still knows them, but only to print "First response in 4h" on a plan card
-- — it never stamps. Display drift is visible on screen; stamping drift is not.
--
-- ─── IT ONLY EVER FIRES ON INSERT ───────────────────────────────────────────
-- The tier is what was promised at the moment the customer asked. Re-deriving it on
-- update would let a downgrade three weeks later rewrite the SLA of a ticket already
-- judged against the old one — and rewrite it in the direction that flatters us.
--
-- ─── A CALLER MAY STILL BE EXPLICIT ─────────────────────────────────────────
-- If both columns arrive filled, they are left alone. Back-filling a historic import
-- with its real tier must be possible without this guessing over the top of it.

begin;

create or replace function public.stamp_support_ticket_sla()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_plan  text;
  v_tier  text;
  v_hours integer;
begin
  if new.tier is not null and new.sla_due_at is not null then
    return new;
  end if;

  /* The customer's active SUPPORT subscription. Ordered best-tier-first: a customer
     who somehow holds two is entitled to the one they pay more for, and picking
     arbitrarily would answer an Enterprise customer on a Standard clock. */
  select s.plan into v_plan
    from public.subscriptions s
   where s.customer_id = new.customer_id
     and s.status = 'active'
     and s.plan ilike '%support%'
   order by case
     when s.plan ilike '%enterprise%' then 1
     when s.plan ilike '%standard%'   then 2
     else 3
   end
   limit 1;

  /* No support subscription IS the free tier — that is the plan, not a fallback. */
  v_tier := case
    when v_plan ilike '%enterprise%' then 'enterprise'
    when v_plan ilike '%standard%'   then 'standard'
    else 'free'
  end;

  /* Must agree with SUPPORT_TIERS in lib/support/tiers.ts. */
  v_hours := case v_tier
    when 'enterprise' then 1
    when 'standard'   then 4
    else 24
  end;

  new.tier       := coalesce(new.tier, v_tier);
  new.sla_due_at := coalesce(new.sla_due_at, now() + make_interval(hours => v_hours));

  return new;
end;
$function$;

drop trigger if exists support_tickets_stamp_sla on public.support_tickets;
create trigger support_tickets_stamp_sla
  before insert on public.support_tickets
  for each row
  execute function public.stamp_support_ticket_sla();

comment on function public.stamp_support_ticket_sla() is
  'Stamps tier + sla_due_at when a support ticket is raised. On the table because three separate code paths create tickets. INSERT only — the tier is what was promised when the customer asked, and a later downgrade must not rewrite it.';

commit;
