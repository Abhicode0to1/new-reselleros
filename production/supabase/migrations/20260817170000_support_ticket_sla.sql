-- 20260817170000_support_ticket_sla
--
-- The SLA a ticket is judged against, and the plan that bought it.
--
-- ─── THE TIER IS FROZEN ON THE TICKET, NOT LOOKED UP LATER ──────────────────
-- The obvious design is to read the customer's current plan whenever a ticket is
-- displayed. It is wrong, and quietly so.
--
-- A customer on Enterprise raises a ticket with a one-hour SLA. Three weeks later
-- they downgrade to Standard. If the tier is looked up at read time, that ticket's
-- SLA silently becomes four hours — and a ticket that BREACHED at 65 minutes now
-- reads as comfortably met. The record of how we actually performed rewrites itself
-- every time a customer changes plan, in the direction that flatters us.
--
-- So `tier` and `sla_due_at` are stamped when the ticket is raised and never
-- recomputed. They are what was promised at the moment the customer asked.
--
-- ─── first_responded_at STOPS THE CLOCK, AND IS SEPARATE FROM resolved_at ───
-- The SLA these plans sell is FIRST RESPONSE, not resolution. A ticket answered in
-- forty minutes and closed a week later met a one-hour SLA. Measuring against
-- resolved_at would mark it breached and make the whole promise unsellable.

begin;

alter table public.support_tickets
  /* Which plan the customer was on WHEN THEY RAISED IT. Nullable because every
     ticket that already exists was raised before tiers existed, and inventing one
     for them would be a claim about a promise nobody made. */
  add column if not exists tier               text,
  /* When a first response is due. Null on pre-existing tickets, for the same reason. */
  add column if not exists sla_due_at         timestamptz,
  /* When a human first replied. Stops the SLA clock. */
  add column if not exists first_responded_at timestamptz;

alter table public.support_tickets
  drop constraint if exists support_tickets_tier_check;
alter table public.support_tickets
  add constraint support_tickets_tier_check
  check (tier is null or tier in ('free', 'standard', 'enterprise'));

comment on column public.support_tickets.tier is
  'Support plan the customer was on when this ticket was raised. FROZEN — never recomputed, or a later downgrade would rewrite the SLA a ticket was already judged against.';
comment on column public.support_tickets.sla_due_at is
  'When a FIRST RESPONSE is due. Stamped at raise time from the tier. Null on tickets raised before tiers existed.';
comment on column public.support_tickets.first_responded_at is
  'When a human first replied. Stops the SLA clock — the plans sell first response, not resolution, so a ticket answered in 40 minutes and closed a week later met a one-hour SLA.';

/* The queue's question: what is overdue or close to it, oldest first. Partial —
   answered tickets are no longer racing a clock. */
create index if not exists support_tickets_sla_open_idx
  on public.support_tickets (tenant_id, sla_due_at)
  where first_responded_at is null and sla_due_at is not null;

commit;
