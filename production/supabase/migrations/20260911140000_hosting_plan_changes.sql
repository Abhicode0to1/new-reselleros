-- Customers can ask for a bigger hosting plan themselves.
--
-- Pardeep, 11 Sep 2026, on `daChangePackage` having no caller anywhere:
-- "Implement this functionality fully."
--
-- ─── WHY A REQUEST AND NOT AN INSTANT CHANGE ────────────────────────────────
-- A bigger plan costs more, and this app holds no card (migration 0063's
-- decision, which is also why /portal/domains has no auto-renew toggle). So a
-- one-click "upgrade now" would hand over more disk and bandwidth with no way to
-- charge for it, and the reseller would find out at renewal. That is the same
-- reasoning `seat_requests` was built on, and this table is deliberately its
-- twin: the customer asks, the amount is worked out pro-rata AT APPROVAL, and a
-- person presses the button that spends money and changes a live server.
--
-- The customer's experience is still self-serve: they pick the plan themselves
-- from /portal/hosting, they see what it will cost, and nobody has to raise a
-- ticket. What they do not get is the power to change their own bill.
--
-- ─── WHY THE PLAN AT REQUEST TIME IS STORED ─────────────────────────────────
-- `from_plan_code` is not decoration and it is not derivable later. A customer
-- asks Starter → Plus; a week later a rep has already moved them by hand. Without
-- the plan as it was, "approve" cannot tell the difference between a request that
-- is still wanted and one the world has overtaken — and would charge for a
-- package the customer already has. `lib/hosting/plan-change.ts` refuses that
-- case, and this column is the only reason it can.
--
-- ─── NO PRICE COLUMN, ON PURPOSE ────────────────────────────────────────────
-- An upgrade is priced pro-rata to the renewal date, so the amount falls every
-- day the request waits. A number stored at request time would be shown to the
-- customer and then not charged. The quote created at approval is the first and
-- only place an amount is written down; `quote_id` points at it.
--
-- ─── THE CUSTOMER MAY READ, NEVER WRITE ─────────────────────────────────────
-- There is no insert policy for `authenticated`. A portal session has no `users`
-- row (lib/auth/roles.ts, EXTERNAL_ACTORS), and a table any signed-in customer
-- could insert into is a table they could fill with requests against somebody
-- else's account. The request is written by POST /api/portal/hosting/:id/upgrade
-- through the service role, which reads the tenant, the customer and the current
-- plan off the ACCOUNT — never off the request body. Same shape as
-- /api/portal/seat-request.
--
-- They do get a read policy, which `seat_requests` does not have. Without it the
-- portal cannot show "you already asked for this", and a customer who cannot see
-- their own pending request will click the button again — which is also why the
-- unique index below exists.

create table if not exists public.hosting_plan_changes (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  hosting_account_id  uuid not null references public.hosting_accounts(id) on delete cascade,
  /* Nullable to match `hosting_accounts.customer_id`'s own history of
     hand-provisioned rows; the request route refuses to write one without it. */
  customer_id         uuid references public.customers(id) on delete restrict,

  /* Denormalised for display and for the audit trail, the same way
     `seat_requests.customer_name` is: six months later the account row may have
     been renamed or closed, and a request that cannot say which domain it was
     about is not an audit trail. */
  domain_name         text not null,

  /* The plan as it was when they asked. See the header — this is the only reason
     "somebody changed it underneath" can be detected. */
  from_plan_code      text,
  requested_plan_code text not null,

  note                text,
  requested_by_email  text,

  status              text not null default 'pending'
                      check (status in ('pending', 'approved', 'rejected', 'withdrawn', 'failed')),

  /* Written at approval. The ONLY place an amount for this upgrade is recorded. */
  quote_id            text,

  decided_by          uuid references public.users(id) on delete restrict,
  decided_at          timestamptz,
  decision_note       text,

  /* Set once DirectAdmin has really been moved. `approved` with a null
     `applied_at` is the state where the books say Plus and the server says
     Starter, and it is the state the worker exists to end. */
  applied_at          timestamptz,
  /* What the server actually said, kept verbatim. A failure here is an operator's
     problem to read, not a customer's. */
  da_result           text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_hosting_plan_changes_tenant
  on public.hosting_plan_changes (tenant_id, created_at desc);

create index if not exists idx_hosting_plan_changes_account
  on public.hosting_plan_changes (hosting_account_id, created_at desc);

/* One open request per account.
   A customer who does not see their request will press the button again, and two
   pending rows for one account means two approvals and two charges for one
   upgrade. Partial, so the history of decided requests is unlimited. */
create unique index if not exists uq_hosting_plan_changes_one_pending
  on public.hosting_plan_changes (hosting_account_id)
  where status = 'pending';

alter table public.hosting_plan_changes enable row level security;

/* Staff: their tenant's requests, read and write. Mirrors seat_requests_tenant,
   including resolving the tenant through `users` — which is what makes it staff
   only, since a portal customer has no row there. */
drop policy if exists hosting_plan_changes_staff on public.hosting_plan_changes;
create policy hosting_plan_changes_staff on public.hosting_plan_changes
  for all
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

/* The customer: their OWN requests, read only. No `with check`, because there is
   no command here that writes. */
drop policy if exists hosting_plan_changes_select_own_customer on public.hosting_plan_changes;
create policy hosting_plan_changes_select_own_customer on public.hosting_plan_changes
  for select
  using (customer_id = public.current_customer_id());

/* The route that writes, and the worker that applies. Named `zzz_` to match the
   convention already used on hosting_accounts. */
drop policy if exists zzz_service_role_all on public.hosting_plan_changes;
create policy zzz_service_role_all on public.hosting_plan_changes
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop trigger if exists trg_hosting_plan_changes_updated_at on public.hosting_plan_changes;
create trigger trg_hosting_plan_changes_updated_at
  before update on public.hosting_plan_changes
  for each row execute function public.handle_updated_at();

comment on table public.hosting_plan_changes is
  'Customer-raised hosting plan upgrades from /portal/hosting. The twin of seat_requests: the customer asks, the pro-rata amount is computed AT APPROVAL (never stored at request time, because it falls daily), and a person approves — which creates the quote and moves the DirectAdmin package. Downgrades never come through here; see lib/hosting/plan-change.ts.';

comment on column public.hosting_plan_changes.from_plan_code is
  'The plan the account was on when the customer asked. Not derivable later, and the only way to detect that somebody changed the plan by hand in the meantime — which would otherwise be charged for twice.';

comment on column public.hosting_plan_changes.applied_at is
  'Null on an approved row means the quote exists and DirectAdmin has NOT been moved yet. That is the state where our records and the server disagree.';
