-- 20260816100506_add_lead_stage_changed_at
--
-- WHAT THIS CHANGES
--   Adds `leads.stage_changed_at` and a trigger that sets it whenever `stage` actually
--   changes. This is the only record of WHEN a deal entered the stage it is sitting in.
--
-- WHY
--   "5 days in Quote Sent" cannot be computed from anything this database already holds:
--
--     • `updated_at` bumps on ANY edit. Correct a phone number and a deal that has been
--       stuck in `quote` for three weeks reads as one day old. Using it for stage age
--       would make the stalest deals look the freshest — precisely inverted.
--     • `activity_log` records only the fact of an update: action, entity, entity_id and
--       a 120-character label. It does not carry which column changed, nor the old and
--       new values, so a stage move is indistinguishable from a note edit.
--     • `lead_activities` has a 'stage' kind available, but nothing writes it — the
--       stage mutation in lib/queries/leads.ts updates the row and logs nothing.
--
--   So the choice was to derive stage age from a proxy that is wrong in the worst
--   direction, or to record the fact. This records the fact.
--
-- THE BACKFILL IS DELIBERATELY NARROW
--   Only leads still at `new` are backfilled, to `created_at`. For those the value is
--   provably right: the lead has never moved, so it entered `new` when it was created.
--
--   Every other lead is left NULL, and the UI renders NULL as "—" rather than a number.
--   Backfilling them from `updated_at` would have produced stage ages that look precise
--   and are not — a wrong number is worse than a missing one, and this codebase has
--   spent two days proving that. They fill in as deals move.
--
-- HOW TO VERIFY (SEPARATE run from the DDL — a SELECT inside the same transaction sees
-- uncommitted changes and reports success for something about to roll back, AGENTS.md §5):
--
--   select count(*) filter (where stage_changed_at is not null) as dated,
--          count(*) filter (where stage_changed_at is null)     as undated,
--          count(*) filter (where stage = 'new')                as at_new
--     from public.leads;
--
--   Expect: dated = at_new, and undated = everything else.

begin;

alter table public.leads
  add column if not exists stage_changed_at timestamptz;

comment on column public.leads.stage_changed_at is
  'When this lead last entered its current stage. NULL means unknown — it has not moved since the column existed, and updated_at is NOT a usable substitute (it bumps on any edit). Set by trg_leads_stage_changed_at.';

create or replace function public.leads_stage_changed_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  /* IS DISTINCT FROM, not <>: a NULL on either side makes <> return NULL, and the stamp
     would silently not be set on the one transition most worth recording. */
  if tg_op = 'INSERT' then
    new.stage_changed_at := coalesce(new.stage_changed_at, now());
  elsif new.stage is distinct from old.stage then
    new.stage_changed_at := now();
  end if;
  return new;
end;
$$;

comment on function public.leads_stage_changed_at() is
  'Stamps leads.stage_changed_at when the stage actually changes. Any other edit leaves it alone — that is the whole point, since updated_at already moves on everything.';

drop trigger if exists trg_leads_stage_changed_at on public.leads;

create trigger trg_leads_stage_changed_at
  before insert or update of stage
  on public.leads
  for each row
  execute function public.leads_stage_changed_at();

/* Narrow backfill — only where the answer is provable. See the header. */
update public.leads
   set stage_changed_at = created_at
 where stage = 'new'
   and stage_changed_at is null
   and created_at is not null;

commit;
