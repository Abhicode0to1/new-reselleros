-- 20260930177000_seat_increase_claims  (R-060, half 2)
--
-- WHAT WAS WRONG
--   POST /api/subscriptions/{id}/add-seats had no idempotency of any kind. The route
--   reads the subscription, then applySeatIncrease() mints a quote number, inserts the
--   quote, updates subscriptions.seats and drafts a PO — four writes, no claim, no lock.
--   Two POSTs of the same intent (a double-click, a browser retry on a slow response, a
--   proxy replay) run the whole thing twice: the seats go up TWICE and the customer gets
--   TWO pro-rata quotes for the same expansion.
--
--   The only thing standing in the way was `disabled={submitting}` on the button. That is
--   a UI convenience, not a guard — it does not survive a second tab, a retried request,
--   or anybody with curl. `docs/CLAUDE.md` §24 states the same rule the other way round
--   about a disabled button, and seat-requests/[id]/decide already learned it (it checks
--   `status <> 'pending'` server-side "because a disabled button is not a guard").
--
-- THE SHAPE, AND WHY IT IS THIS ONE
--   The house pattern for idempotency in this repo is a UNIQUE CONSTRAINT CLAIMED BEFORE
--   THE WORK, not a wrapper or a lock: campaign_sends, compliance_reminder_log,
--   birthday greetings ("the idempotency claim: unique (tenant, contact, kind, channel,
--   year)"), the Razorpay webhook, the inbound-email message_id. This follows it.
--
--   There is no NATURAL key here — "same subscription, same seat count" is a perfectly
--   legitimate second request an hour later, and refusing it would break a real workflow
--   to fix an imaginary one. So the key comes from the client: one uuid per submit
--   intent, reused by every retry of that intent. The route REQUIRES it, because a key
--   that callers may omit protects only the callers who remember.
--
-- WHY THE RESULT IS STORED, NOT JUST THE KEY
--   A replay has to answer the same question the first request answered — which quote,
--   which PO, how many seats now. Returning a bare "already done" would leave the
--   operator on a dialog with no quote to open, and their next move would be to try
--   again somewhere else. §24: a block must hand back the next step, and here the next
--   step is the quote that already exists.
--
-- WHY A FAILED ATTEMPT RELEASES THE KEY (and one case where it must not)
--   A key is claimed before the work, so a failure would otherwise burn it forever and
--   the operator could never retry the thing that did not happen. The route therefore
--   DELETES the claim when the attempt wrote nothing (bad seat count, no renewal date,
--   term ended, no document number, quote insert failed).
--
--   The exception is `sub_update_failed`: the quote was already inserted and only the
--   seat update failed. That claim is kept, marked 'failed', so a replay returns the same
--   report instead of minting a second quote on top of the first. Half-done must stay
--   visible — see the identical reasoning in seat-requests/[id]/decide when the request
--   cannot be marked approved.
--
-- HOW TO VERIFY (a SEPARATE run from the DDL — AGENTS.md §5):
--   select count(*) from public.seat_increase_claims;             -- expect 0
--   select indexname from pg_indexes where tablename = 'seat_increase_claims';
--   select policyname, cmd from pg_policies where tablename = 'seat_increase_claims';

begin;

create table if not exists public.seat_increase_claims (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  subscription_id  uuid not null references public.subscriptions(id) on delete cascade,
  /* Opaque to the server on purpose. It identifies ONE submit intent; the server never
     parses it, so a caller can use a uuid, a request id or a hash of its own state. */
  idempotency_key  text not null,
  requested_by     uuid,
  additional_seats integer not null check (additional_seats between 1 and 5000),
  /* 'in_progress' | 'done' | 'failed'. Text, matching the dunning log next door: the set
     is small and a migration per value is friction that ends in nobody adding one. */
  status           text not null default 'in_progress',
  /* The first attempt's answer, replayed verbatim. Not recomputed — recomputing would
     re-read a subscription that has moved on and report a number the caller never got. */
  result           jsonb,
  error_code       text,
  error_message    text,
  created_at       timestamptz not null default now(),
  completed_at     timestamptz
);

/* THE CONSTRAINT IS THE WHOLE MECHANISM. Scoped to the tenant, because the key is
   chosen by a client and two tenants must never be able to collide — deliberately or by
   accident with a fixed string. */
create unique index if not exists seat_increase_claims_key_uniq
  on public.seat_increase_claims (tenant_id, idempotency_key);

/* "Has this subscription been expanded recently?" — the question an operator asks after
   a double-submit, and the one a future audit will ask. */
create index if not exists seat_increase_claims_sub_idx
  on public.seat_increase_claims (subscription_id, created_at desc);

comment on table public.seat_increase_claims is
  'One row per add-seats submit intent. The unique (tenant_id, idempotency_key) is the idempotency: a replay finds the claim and returns the first attempt''s stored result instead of adding the seats and minting the quote a second time.';
comment on column public.seat_increase_claims.result is
  'The first attempt''s response body, replayed verbatim. Never recomputed — the subscription has moved on by then.';
comment on column public.seat_increase_claims.status is
  'in_progress until the work finishes. A claim whose attempt wrote nothing is DELETED rather than marked failed, so the operator can retry the thing that did not happen; only a half-written attempt (quote raised, seats not updated) is kept as failed.';

alter table public.seat_increase_claims enable row level security;

/* Read-only to the browser, and tenant-scoped. Every write goes through the route on the
   service-role client — there is no legitimate reason for a session to hand-write a claim,
   and one that could would be able to suppress a real seat increase by claiming its key
   first. Wrapped in a SELECT so the planner runs it once per query, not once per row
   (20260928100000). */
drop policy if exists seat_increase_claims_select on public.seat_increase_claims;
create policy seat_increase_claims_select on public.seat_increase_claims
  for select
  using (tenant_id = (select tenant_id from public.users where id = (select auth.uid())));

/* R-013 / S41: say the grants out loud rather than inheriting whatever the schema default
   happens to be today.
   `authenticated` IS on the revoke line, and that is not belt-and-braces — it is the
   whole point. Supabase ships `alter default privileges in schema public grant all on
   tables to anon, authenticated, service_role`, so `create table` had already handed
   `authenticated` INSERT, UPDATE, DELETE and TRUNCATE before this line ran; the grant
   below would have added nothing and the migration would have read as if it restricted
   something it did not. Measured on the local DB after the first apply — seven
   privileges for `authenticated`, not one. RLS would still have refused the writes (a
   table with only a SELECT policy denies the rest), but a privilege nobody meant to give
   is exactly the gap R-013 found, and it survives the day someone adds a policy. */
revoke all on table public.seat_increase_claims from public, anon, authenticated;
grant select on table public.seat_increase_claims to authenticated;
grant select, insert, update, delete on table public.seat_increase_claims to service_role;

commit;
