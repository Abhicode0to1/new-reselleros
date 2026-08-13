-- 0236 — MRR movements ledger
--
-- WHY THIS EXISTS
-- ---------------
-- /accounting/saas-metrics is supposed to show the standard SaaS waterfall:
--   Starting + New + Expansion - Contraction - Churn = Ending
-- Two of those five cannot be computed today. `subscriptions` stores one current
-- `mrr` per row and no history; `activity_log` (0222) records THAT a subscription
-- changed but never what it changed FROM. So an upgrade and a downgrade are
-- indistinguishable after the fact, and the waterfall silently under-reports.
--
-- This table is the missing ledger: one row per MRR change, with the before and
-- after values, written by a trigger.
--
-- WHY A TRIGGER AND NOT APPLICATION CODE
-- --------------------------------------
-- Subscription MRR is changed from several places — the add-seats RPC, the
-- subscription edit form, the renewal roll-forward, CSV import, and manual fixes
-- run straight against the table. Asking every one of those to remember to write
-- a ledger row is how a ledger ends up 80% complete, which is worse than none:
-- it looks authoritative and is quietly wrong. The trigger fires on the column,
-- so every path is covered including ones written later.
--
-- HISTORY IS NOT BACKFILLED, DELIBERATELY
-- ---------------------------------------
-- Past upgrades and downgrades are simply gone — there is no source to recover
-- them from. Inventing rows from today's values would produce a ledger that
-- reconciles perfectly and describes events that never happened. The waterfall
-- reports `basis = 'reconstructed'` until this table has covered a full period,
-- and the UI says so.

create table if not exists public.mrr_movements (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,

  -- Whole rupees, matching subscriptions.mrr.
  from_mrr        integer not null,
  to_mrr          integer not null,

  -- Classified by the trigger from the direction of change and the status.
  reason          text not null check (reason in
                    ('new','expansion','contraction','churn','reactivation')),

  occurred_at     timestamptz not null default now(),
  -- Who caused it, when a JWT is present. Cron and service-role writes leave this
  -- null rather than being attributed to whoever happens to be logged in.
  changed_by      uuid references auth.users(id) on delete set null,

  created_at      timestamptz not null default now()
);

-- The waterfall always queries one tenant over one date window.
create index if not exists mrr_movements_tenant_time_idx
  on public.mrr_movements (tenant_id, occurred_at desc);

create index if not exists mrr_movements_subscription_idx
  on public.mrr_movements (subscription_id);

alter table public.mrr_movements enable row level security;

-- Matches every other table in this schema: isolation runs through
-- public.current_tenant_id(), NOT auth.jwt() ->> 'tenant_id'.
drop policy if exists mrr_movements_tenant_read on public.mrr_movements;
create policy mrr_movements_tenant_read on public.mrr_movements
  for select using (tenant_id = public.current_tenant_id());

-- No INSERT/UPDATE/DELETE policy on purpose. This is an append-only audit trail
-- written by a SECURITY DEFINER trigger; nobody edits it through the API, and a
-- ledger a user can rewrite is not evidence of anything.

comment on table public.mrr_movements is
  'Append-only MRR change ledger feeding the SaaS waterfall. Written by trigger only; not backfilled.';


-- ─────────────────────────────────────────────────────────────────────────────
-- The trigger
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.record_mrr_movement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from   integer := 0;
  v_to     integer := 0;
  v_reason text;
  v_dead   constant text[] := array['cancelled','canceled','expired','churned','terminated'];
begin
  if tg_op = 'INSERT' then
    v_from := 0;
    v_to   := coalesce(new.mrr, 0);
    -- A subscription created already-cancelled is an import artefact, not revenue.
    if lower(coalesce(new.status,'')) = any (v_dead) then
      return new;
    end if;
    v_reason := 'new';

  elsif tg_op = 'UPDATE' then
    v_from := coalesce(old.mrr, 0);
    v_to   := coalesce(new.mrr, 0);

    -- Going dead is churn regardless of what happened to the number, and the
    -- full remaining MRR is what leaves.
    if lower(coalesce(new.status,'')) = any (v_dead)
       and lower(coalesce(old.status,'')) <> all (v_dead) then
      v_to     := 0;
      v_reason := 'churn';

    -- Coming back from dead.
    elsif lower(coalesce(old.status,'')) = any (v_dead)
          and lower(coalesce(new.status,'')) <> all (v_dead) then
      v_from   := 0;
      v_reason := 'reactivation';

    elsif v_to > v_from then
      v_reason := 'expansion';
    elsif v_to < v_from then
      v_reason := 'contraction';
    else
      -- No money moved. An edit to the plan name is not a waterfall event, and
      -- logging it would bury the real ones.
      return new;
    end if;
  else
    return new;
  end if;

  insert into public.mrr_movements
    (tenant_id, subscription_id, from_mrr, to_mrr, reason, changed_by)
  values
    (new.tenant_id, new.id, v_from, v_to, v_reason, auth.uid());

  return new;
end;
$$;

comment on function public.record_mrr_movement() is
  'Writes one mrr_movements row per real MRR change. Status changes to/from a dead state win over the numeric direction.';

drop trigger if exists subscriptions_mrr_movement on public.subscriptions;
create trigger subscriptions_mrr_movement
  after insert or update of mrr, status on public.subscriptions
  for each row
  execute function public.record_mrr_movement();
