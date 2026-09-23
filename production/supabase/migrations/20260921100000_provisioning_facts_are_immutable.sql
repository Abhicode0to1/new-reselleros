-- ============================================================================
-- provisioning_requests: the columns that decide whether seats get given away
-- are not writable by a tenant member.
--
-- THE HOLE
--   `provisioning_requests_update` allows any tenant member to update any row
--   in their tenant:
--       for update using (tenant_id = current_tenant_id())
--               with check (tenant_id = current_tenant_id())
--   That check validates the TENANT and nothing else, so it permits a write to
--   every column — including the two the provisioning gate reads.
--
--   `listReadyHostingRequests` (src/lib/provisioning/provisioning.server.ts:51)
--   selects the rows a worker may provision with:
--       .eq("payment_mode", "live").is("blocker", null)
--   So a tenant member could take a `test` row — a payment that settled ZERO
--   rupees while looking identical to a real one everywhere else — set
--   payment_mode to 'live', clear the blocker, and the worker would provision
--   real hosting against it. The column's own comment already says it is "what
--   stops seats being given away"; until now, the person it stops could edit it.
--
--   That is one layer wearing the shape of two. This migration makes them
--   independent: RLS decides which ROWS you may touch, this decides which
--   FIELDS, and neither can be satisfied by defeating the other.
--
-- WIDER THAN payment_mode, ON PURPOSE
--   `blocker` is the other half of the same WHERE clause. Locking only
--   payment_mode would leave the identical bypass one column to the left, and
--   a guard that closes one of two doors is a guard somebody trusts.
--   The rest of the locked set is the same argument: they are the record of
--   what was PAID FOR, written by the webhook from the verified payment. seats,
--   amount_paid, vendor and quote_id decide what gets activated and against
--   which quote; a member who can rewrite them can have the worker provision
--   something nobody bought.
--
-- WHAT A TENANT MEMBER MAY STILL DO — the whole existing workflow
--   status, activated_at, vendor_ref, note. That is "activate the seats in the
--   vendor console by hand, then tick the row off", which the policy comment
--   describes as the point of the UPDATE policy and which must not need the
--   owner to be awake. Nothing about this migration changes that.
--
-- WHY A TRIGGER AND NOT A POLICY
--   RLS cannot express "this column may not change" — it decides rows, not
--   fields. Column privileges (`grant update (col) ...`) are the other option
--   and were not taken: they must enumerate the ALLOWED columns, so adding a
--   column later silently makes it writable. This enumerates the FORBIDDEN
--   ones, so a new column is locked by omission until somebody decides
--   otherwise. Failing closed on the thing nobody remembered is the point.
--
-- ⚠️ THE CARVE-OUT
--   Triggers fire for service_role too, unlike RLS. The webhook that writes
--   these rows uses the service-role key and has no auth.uid(), so it must be
--   allowed through or the row could never be written at all. Following
--   20260818160000_users_privileged_columns_owner_only, which made the same
--   call for the same reason: anything holding the service-role key can still
--   change these columns, that key is server-only, and it is already trusted
--   with far more than this.
--
-- WHAT THIS BREAKS — CHECKED, NOT ASSUMED
--   Every writer of provisioning_requests, 21 Sep 2026:
--     src/lib/provisioning/provisioning.server.ts   INSERT via the service-role
--                                                   client — BEFORE UPDATE only,
--                                                   so unaffected
--     src/app/api/cron/provision-hosting/route.ts   service-role, takes the carve-out
--   There is no browser-side writer at all today: nothing under src/app reads
--   or writes this table on the typed client. So enabling this changes nothing
--   that currently works; it closes the direct-API path before a screen exists
--   that would make that path obvious.
-- ============================================================================

begin;

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
     and new.tenant_id   is not distinct from old.tenant_id then
    return new;
  end if;

  /* Trusted server code — see THE CARVE-OUT in the header. */
  if auth.uid() is null then
    return new;
  end if;

  raise exception
    'This row records what a customer paid for, so those fields cannot be edited here. '
    'You changed one of: payment mode, blocker, seats, amount paid, vendor or quote. '
    'They are written from the verified payment and are what decides whether seats are '
    'activated automatically. To complete a request, set its status (and vendor_ref / note) '
    'instead. If the payment details are genuinely wrong, the payment is what needs '
    'correcting, not this row.'
    using errcode = 'check_violation';
end;
$$;

comment on function public.guard_provisioning_request_facts() is
  'Blocks a tenant member from editing the columns that decide whether provisioning happens. '
  'payment_mode and blocker are read by listReadyHostingRequests; the rest are the record of '
  'what was paid for. service_role (auth.uid() is null) is carved out — see the migration.';

drop trigger if exists provisioning_requests_facts_immutable on public.provisioning_requests;
create trigger provisioning_requests_facts_immutable
  before update on public.provisioning_requests
  for each row
  execute function public.guard_provisioning_request_facts();

/* BEFORE UPDATE only, deliberately.
   INSERT is already service-role-only via provisioning_requests_service, and
   covering INSERT here would block the webhook that creates the row. Same
   reasoning as AGENTS.md L107: a rule about what may CHANGE belongs on UPDATE,
   and widening it to cover the write that legitimately sets the value is how a
   guard makes the correct path impossible. */

commit;
