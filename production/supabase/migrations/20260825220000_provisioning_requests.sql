-- ═══════════════════════════════════════════════════════════════════════════
-- Provisioning queue — a paid quote's seats, waiting to be activated
--
-- ─── WHAT THIS IS INSTEAD OF ────────────────────────────────────────────────
-- The brief was "payment receive hote hi ... seats 5 seconds mein automatically activate ho
-- jayengi". Two things make that impossible today, and both are facts rather than caution:
--
--   1. THERE IS NOTHING TO CALL. `src/lib/google-csp/` does not exist. The Google Workspace
--      Reseller API needs an approved reseller agreement and OAuth credentials, and the setup
--      wizard's own step 4 describes it as "a preview of the 5–7 day application" — an
--      application that has not been made.
--
--   2. THE PAYMENT MAY NOT BE MONEY. `tenant_secrets.razorpay_key_id` on production starts
--      `rzp_test_` (measured 25 Aug 2026). A test-mode payment completes a checkout, fires
--      `payment.captured`, verifies its signature and matches the quote amount — and settles
--      zero rupees. Auto-activating against that means handing out seats for free, in seconds,
--      to anybody who reaches a sandbox checkout, with nobody watching.
--
-- So a paid quote writes a REQUEST here with everything an activation needs, and the desk sees
-- "paid, awaiting activation". That is not the feature that was asked for. It is the honest
-- version, and it is strictly better than what happens today, which is nothing at all: a paid
-- quote currently produces no activation signal anywhere. When CSP access exists, this table is
-- what the adapter drains — see lib/provisioning/provisioning.ts for the gate it must pass.
--
-- ─── ONE REQUEST PER QUOTE ──────────────────────────────────────────────────
-- Razorpay delivers the same event twice often enough that the webhook already checks
-- `payment_status = 'received'` before doing anything. The unique index below is the second
-- line: two rows would mean two activations for one payment, and seats given away twice are
-- seats somebody has to take back from a customer who did nothing wrong.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create table if not exists public.provisioning_requests (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references public.tenants(id) on delete cascade,
  -- TEXT, matching quotes.id (Q-ADPL-2026-27-0058).
  quote_id      text        not null,

  vendor        text        not null check (vendor in ('google', 'microsoft', 'zoho', 'other')),
  seats         integer     not null check (seats > 0),
  /* The customer's own domain, which is what the reseller API provisions against. Nullable
     because a quote can be paid before anybody has told us the domain — and that is itself a
     reason the request cannot complete, recorded rather than guessed. */
  domain        text,
  plan          text,

  /* ₹ whole rupees, as received. Kept on the row so the queue can be reconciled against
     `payments` without a join, and so a mismatch is visible rather than inferred. */
  amount_paid   integer     not null check (amount_paid >= 0),

  /* 'live' | 'test' — from the Razorpay key prefix, the single source of truth for this.
     A `test` row must never be activated automatically at any dial setting. */
  payment_mode  text        not null check (payment_mode in ('live', 'test')),

  status        text        not null default 'queued'
                            check (status in ('queued', 'activated', 'failed', 'cancelled')),

  /* Why it is still queued, in the words the operator reads. From decideProvisioning. */
  blocker       text,
  /* Set when somebody or something completed it. */
  activated_at  timestamptz,
  /* The vendor's own identifier for what was created, once there is one. */
  vendor_ref    text,
  note          text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Tenant-safe link (CLAUDE.md §4). `quotes_tenant_id_key` was added by 20260825200000.
  --
  -- CASCADE: a provisioning request for a deleted quote is not evidence of anything, and
  -- leaving it would keep a stale activation in a queue somebody drains. Opposite call to
  -- ai_telecall_logs, which keeps a record of what was said to a real person.
  constraint provisioning_requests_quote_fk
    foreign key (tenant_id, quote_id)
    references public.quotes (tenant_id, id)
    on delete cascade
);

comment on table public.provisioning_requests is
  'Seats waiting to be activated against a paid quote. Written by the Razorpay webhook once '
  'record_payment has committed. Nothing drains it automatically yet: there is no Google '
  'reseller API adapter, and a test-mode payment must never auto-activate — see '
  'lib/provisioning/provisioning.ts.';

comment on column public.provisioning_requests.payment_mode is
  'From the Razorpay key prefix. A ''test'' payment settles zero rupees while looking identical '
  'to a real one everywhere else, so this column is what stops seats being given away.';

-- One request per quote. See the header: two would mean two activations for one payment.
create unique index if not exists provisioning_requests_one_per_quote
  on public.provisioning_requests (tenant_id, quote_id);

-- The only list anybody opens: what is still waiting, oldest first, because the customer who
-- has been waiting longest is the one to activate next.
create index if not exists provisioning_requests_queued_idx
  on public.provisioning_requests (tenant_id, created_at)
  where status = 'queued';

alter table public.provisioning_requests enable row level security;

-- Read: anyone in the tenant. "Has this customer been activated" is what the person answering
-- the phone needs, and a queue only the owner can see is a queue nobody drains.
drop policy if exists provisioning_requests_select on public.provisioning_requests;
create policy provisioning_requests_select on public.provisioning_requests
  for select using (tenant_id = public.current_tenant_id());

-- Mark one done: anyone in the tenant. Activating seats by hand in the vendor console and then
-- ticking the row off is the whole workflow until an adapter exists, and it must not need the
-- owner to be awake. UPDATE-only — a user may complete a request, not invent one.
drop policy if exists provisioning_requests_update on public.provisioning_requests;
create policy provisioning_requests_update on public.provisioning_requests
  for update using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- Writes belong to the service role. The writer is a payment webhook with no session, and an
-- invented row would put seats into a queue that somebody then activates for free.
drop policy if exists provisioning_requests_service on public.provisioning_requests;
create policy provisioning_requests_service on public.provisioning_requests
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create or replace function public.provisioning_requests_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists provisioning_requests_touch_trg on public.provisioning_requests;
create trigger provisioning_requests_touch_trg
  before update on public.provisioning_requests
  for each row execute function public.provisioning_requests_touch();

commit;
