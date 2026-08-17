-- 20260817180000_support_call_requests
--
-- A customer asking for a live 1-on-1 call, and what happened to it.
--
-- ─── WHY THE MEETING LINK IS NULLABLE ───────────────────────────────────────
-- The brief says "auto-generate Google Meet room link". A valid Meet room can only be
-- created by Google — through the Calendar API, creating an event with
-- `conferenceData` under an OAuth token with calendar scope. There is no offline
-- algorithm for a meeting code.
--
-- Inventing one (meet.google.com/abc-defg-hij) produces a link that LOOKS right and
-- is dead: the customer clicks it and gets "invalid video call name". That is worse
-- than having no link, because everyone believes the call is booked until the moment
-- it fails, which is the moment of the call.
--
-- So `meet_url` starts NULL and is filled when a real link exists — pasted by the
-- engineer today, or written by the Calendar integration when it lands. A request
-- with no link is an honest state the UI can show ("waiting for a link"), not a
-- broken one.
--
-- ─── THE ALLOWANCE IS COUNTED FROM THESE ROWS ───────────────────────────────
-- Standard includes two calls a month. That count is the number of rows here for the
-- customer in the current IST month, so the entitlement is derived from what actually
-- happened rather than a counter someone has to remember to decrement.

begin;

create table if not exists public.support_call_requests (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  customer_id   uuid references public.customers(id) on delete set null,
  /* The ticket it came from, when it came from one. A customer can also ask for a
     call without a ticket existing yet. */
  ticket_id     text references public.support_tickets(id) on delete set null,

  /* The plan they were on when they asked — frozen, for the same reason the ticket's
     tier is (migration 20260817170000). */
  tier          text not null check (tier in ('free', 'standard', 'enterprise')),

  requested_by_email text not null,
  note          text,

  /* NULL until a REAL Meet link exists. See the header. */
  meet_url      text,
  /* Who is taking it. */
  assigned_to   uuid references public.users(id) on delete set null,
  scheduled_at  timestamptz,

  status        text not null default 'requested'
                check (status in ('requested', 'scheduled', 'completed', 'cancelled')),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.support_call_requests is
  'A customer asking for a live 1-on-1 call. meet_url is NULL until a real Google Meet link exists — a fabricated meeting code is a dead link that looks correct until the moment of the call.';
comment on column public.support_call_requests.meet_url is
  'Filled when a genuine link exists (pasted, or created via the Calendar API when that integration lands). Never generated locally.';
comment on column public.support_call_requests.tier is
  'The plan the customer was on when they asked. Frozen — the monthly allowance is judged against what they had at the time.';

/* The allowance query: this customer's calls this month. */
create index if not exists support_call_requests_customer_idx
  on public.support_call_requests (customer_id, created_at desc);

create index if not exists support_call_requests_open_idx
  on public.support_call_requests (tenant_id, created_at desc)
  where status in ('requested', 'scheduled');

alter table public.support_call_requests enable row level security;

drop policy if exists support_call_requests_select on public.support_call_requests;
create policy support_call_requests_select on public.support_call_requests
  for select using (tenant_id = (select tenant_id from public.users where id = auth.uid()));

/* Staff may schedule, assign, add the link and close it. */
drop policy if exists support_call_requests_update on public.support_call_requests;
create policy support_call_requests_update on public.support_call_requests
  for update
  using      (tenant_id = (select tenant_id from public.users where id = auth.uid()))
  with check (tenant_id = (select tenant_id from public.users where id = auth.uid()));

/* No insert policy: requests are created server-side, where the tier and the monthly
   allowance are checked. A client-side insert would let a Free-tier customer book a
   call the plan does not include. */

commit;
