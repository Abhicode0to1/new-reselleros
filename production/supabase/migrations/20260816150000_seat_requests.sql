-- 20260816150000_seat_requests
--
-- WHAT THIS ADDS
--   `seat_requests` — a customer asking for more (or fewer) seats, as STRUCTURED DATA
--   rather than as prose in a support ticket.
--
-- WHY IT IS NOT A SUPPORT TICKET
--   /portal/subscription already lets a customer request a seat change. It writes a
--   support_tickets row whose body reads:
--
--       "Request to change seats on subscription SUB-123:
--        Current: 10 users · Google Workspace
--        Requested: 30 users (+20)"
--
--   Every number a rep needs is in there as English. To act on it they re-read it,
--   re-key the seat count into the Add Seats dialog, and hope they typed the same
--   number the customer asked for. There is no way to tell an actioned request from
--   an ignored one except by reading ticket comments, and nothing links the request
--   to the quote that eventually came out of it.
--
--   Structured columns make the approval one click and make "what did we agree?"
--   answerable by a query instead of by reading.
--
-- WHY THE PRICE IS NOT STORED AT REQUEST TIME
--   A seat change is priced pro-rata to the renewal date, so the amount changes every
--   day the request sits unactioned. Freezing it at submission would show the customer
--   one figure and bill another. The request stores WHAT was asked; the price is
--   computed when it is approved, by the same addSeats() path a rep uses manually, and
--   the resulting quote id is written back here.
--
-- WHY status HAS NO 'applied' SEPARATE FROM 'approved'
--   Approving IS applying — addSeats() updates the subscription and raises the quote
--   in one call. A separate state would describe a moment that does not exist and
--   would eventually hold rows that are approved-but-not-applied, which is precisely
--   the ambiguity this table replaces.
--
-- HOW TO VERIFY (SEPARATE run from the DDL — AGENTS.md §5):
--
--   select status, count(*) from public.seat_requests group by 1;   -- expect 0 rows
--   select policyname, cmd from pg_policies where tablename='seat_requests';

begin;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'seat_request_status') then
    create type public.seat_request_status as enum ('pending', 'approved', 'rejected', 'withdrawn');
  end if;
end $$;

create table if not exists public.seat_requests (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  customer_id     uuid references public.customers(id) on delete set null,
  customer_name   text not null,
  /* Seats AS THEY WERE when the request was made. Kept so a rep can see that the
     subscription has since changed underneath the request — approving a "+20 from 10"
     against a subscription now at 40 is a different decision. */
  current_seats   integer not null,
  requested_seats integer not null,
  effective_on    date,
  note            text,
  requested_by_email text,
  status          public.seat_request_status not null default 'pending',
  /* The quote addSeats() produced. Null until approved — this is the link that was
     missing when requests were tickets. */
  quote_id        text references public.quotes(id) on delete set null,
  decided_by      uuid references public.users(id) on delete set null,
  decided_at      timestamptz,
  /* Shown to the CUSTOMER, so it is written for them and not as an internal note. */
  decision_note   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- A request that changes nothing is not a request.
alter table public.seat_requests
  drop constraint if exists seat_requests_seats_differ;
alter table public.seat_requests
  add constraint seat_requests_seats_differ
  check (requested_seats <> current_seats and requested_seats >= 0 and current_seats >= 0);

comment on table public.seat_requests is
  'Customer-raised seat changes, structured. Replaces prose in a support ticket so approval is one click and "what did we agree?" is a query. See the migration header.';
comment on column public.seat_requests.current_seats is
  'Seats at REQUEST time. Kept because the subscription can move underneath a pending request, and approving "+20 from 10" against a subscription now at 40 is a different decision.';
comment on column public.seat_requests.quote_id is
  'The quote addSeats() produced on approval. Null until then. This link is what tickets could not provide.';

create index if not exists seat_requests_pending_idx
  on public.seat_requests (tenant_id, created_at)
  where status = 'pending';
create index if not exists seat_requests_sub_idx
  on public.seat_requests (subscription_id, created_at desc);

alter table public.seat_requests enable row level security;

-- Staff read/act on their own tenant's requests.
drop policy if exists seat_requests_tenant on public.seat_requests;
create policy seat_requests_tenant on public.seat_requests
  for all
  using      (tenant_id = (select tenant_id from public.users where id = auth.uid()))
  with check (tenant_id = (select tenant_id from public.users where id = auth.uid()));

/* The portal has its own session keyed on customer_id and no `users` row (see
   lib/auth/roles.ts, EXTERNAL_ACTORS), so the customer side writes through the
   server with the service role. There is deliberately no anon insert policy: a
   table anyone can insert into is a table anyone can fill with seat requests for
   someone else's customer. */

commit;
