-- 0225_lead_loss_reason.sql
--
-- Capture WHY a deal was lost, at the moment it is marked lost.
--
-- Without this the pipeline can say "12 deals lost this quarter" but never why,
-- so there is nothing to act on. Three columns, deliberately small:
--
--   lost_reason  a short code from a fixed set (see lib/leads/loss-reasons.ts)
--   lost_note    optional free text — the detail a dropdown can never capture
--   lost_at      when it was marked lost, so "lost in the last 90 days" is a
--                real query. `updated_at` can't do this: any later edit moves it.
--
-- The reason set is enforced by a CHECK rather than a Postgres enum, matching how
-- this schema already handles small value sets (payments.method, items.kind).
-- A CHECK is far easier to extend later — adding a value to an enum used by a
-- column is a migration-and-a-half; here it is one ALTER.
--
-- Idempotent: safe to re-run.

alter table public.leads
  add column if not exists lost_reason text,
  add column if not exists lost_note   text,
  add column if not exists lost_at     timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_lost_reason_check') then
    alter table public.leads
      add constraint leads_lost_reason_check
      check (lost_reason is null or lost_reason in (
        'price',           -- too expensive / budget
        'competitor',      -- went with someone else
        'no_response',     -- went dark
        'timing',          -- not now, maybe later
        'not_qualified',   -- never a real fit
        'other'
      ));
  end if;
end $$;

-- Analytics query is always "lost deals, grouped by reason, within a window",
-- so index the pair rather than either column alone.
create index if not exists leads_lost_reason_idx
  on public.leads (tenant_id, lost_at desc)
  where stage = 'lost';

comment on column public.leads.lost_reason is
  'Why the deal was lost — fixed set, see lib/leads/loss-reasons.ts. NULL for deals lost before this was captured.';
comment on column public.leads.lost_note is
  'Optional free-text detail accompanying lost_reason.';
comment on column public.leads.lost_at is
  'When the lead was marked lost. Separate from updated_at, which any later edit moves.';

-- NOTE: no backfill. Deals already sitting in `lost` genuinely have no recorded
-- reason, and inventing one ("other") would put fabricated data into the very
-- analytics this exists to make trustworthy. They stay NULL and the UI reports
-- them as "Not recorded".
