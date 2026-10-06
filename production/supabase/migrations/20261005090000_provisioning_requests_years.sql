-- ============================================================================
-- R-031 (5 Oct 2026): how many YEARS a paid domain was bought for, on the queued row.
--
-- WHY
--   provisioning_requests had no term, so the register-domains cron could not know what the
--   customer paid for. R-035 (29 Sep) already made the cron send `years` from this row,
--   reading it defensively (absent / not 1–10 → 1) until this column existed. This adds it.
--
-- THE COLUMN
--   years int NOT NULL DEFAULT 1, CHECK 1–10 (DMS / ResellerClub's own range). Every row
--   written before today was a one-year sale — the site cart refuses any other term — so
--   the default is the truth for them, not a guess.
--
-- AND THE GUARD
--   guard_provisioning_request_facts() locks the fields that decide what gets activated,
--   by NAMING them (see 20260921100000 for why a forbidden-list). Three such fields were
--   never named, so a tenant member could still edit them on a queued row:
--     years  — a 1-year payment registered for 10 years (the engine's spend cap would stop
--              most of it, but a guard that leans on another guard is one layer, not two)
--     domain — the paid name swapped for another, which the cron would then REGISTER
--     plan   — the renewal marker, which decides register-vs-renew
--   All three are written from the verified payment by the webhook (service role, carved
--   out below) and by nothing else: every writer of this table, checked 5 Oct 2026, is
--   src/lib/provisioning/provisioning.server.ts on the service-role client, and the only
--   member-side UPDATE path is the operator ticking a row off (status / vendor_ref / note /
--   activated_at), which stays allowed.
-- ============================================================================

begin;

alter table public.provisioning_requests
  add column if not exists years integer not null default 1;

alter table public.provisioning_requests
  drop constraint if exists provisioning_requests_years_range;
alter table public.provisioning_requests
  add constraint provisioning_requests_years_range check (years between 1 and 10);

comment on column public.provisioning_requests.years is
  'Years the customer paid for (domains: the registration term sent to domain.register). '
  'Written by the payment webhook from the quote line; 1 for every non-domain row.';

create or replace function public.guard_provisioning_request_facts()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  /* Nothing that decides an activation changed — this is the operator ticking a
     row off. Leave it alone, so the common case pays no cost. */
  if new.payment_mode is not distinct from old.payment_mode
     and new.blocker     is not distinct from old.blocker
     and new.seats       is not distinct from old.seats
     and new.amount_paid is not distinct from old.amount_paid
     and new.vendor      is not distinct from old.vendor
     and new.quote_id    is not distinct from old.quote_id
     and new.tenant_id   is not distinct from old.tenant_id
     and new.domain      is not distinct from old.domain
     and new.plan        is not distinct from old.plan
     and new.years       is not distinct from old.years then
    return new;
  end if;

  /* Trusted server code — see THE CARVE-OUT in 20260921100000. */
  if auth.uid() is null then
    return new;
  end if;

  raise exception
    'This row records what a customer paid for, so those fields cannot be edited here. '
    'You changed one of: payment mode, blocker, seats, amount paid, vendor, quote, domain, '
    'plan or years. They are written from the verified payment and are what decides what is '
    'activated or registered automatically. To complete a request, set its status (and '
    'vendor_ref / note) instead. If the payment details are genuinely wrong, the payment is '
    'what needs correcting, not this row.'
    using errcode = 'check_violation';
end;
$$;

comment on function public.guard_provisioning_request_facts() is
  'Blocks a tenant member from editing the columns that decide whether and what provisioning '
  'happens (payment_mode, blocker, seats, amount_paid, vendor, quote_id, tenant_id, domain, '
  'plan, years). service_role (auth.uid() is null) is carved out — see 20260921100000.';

commit;
