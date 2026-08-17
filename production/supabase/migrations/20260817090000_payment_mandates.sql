-- 20260817090000_payment_mandates
--
-- WHAT THIS ADDS
--   `payment_mandates` — a customer's standing permission for us to debit them
--   (UPI Autopay / e-NACH), and the gateway ids needed to manage it.
--
-- WHY `status` HAS NO DEFAULT OF 'active' AND NO APP WRITE PATH TO IT
--   A mandate is a legal authorisation to take money out of someone's bank account.
--   "Autopay is on" must mean the GATEWAY says the customer approved it — never that
--   a row in our database says so.
--
--   If the app could write 'active', a reseller would stop chasing a renewal that is
--   never going to collect, and would find out on the day the money did not arrive.
--   So the only path into 'active' is /api/webhooks/razorpay handling a
--   subscription.* event whose HMAC signature verified. The RLS policy below lets
--   staff READ mandates and CANCEL them; it does not let anything mark one active.
--
-- WHY max_amount IS STORED AND WHY IT MATTERS MORE THAN IT LOOKS
--   A UPI Autopay mandate authorises up to a fixed amount per debit, set when the
--   customer approves it, and it CANNOT be raised afterwards — a higher figure needs
--   a new mandate the customer approves again.
--
--   So a subscription that grows past its cap silently stops collecting: the debit is
--   declined, nothing errors on our side, and the first sign is an unpaid renewal
--   everyone assumed was automatic. Storing the cap is what lets
--   lib/payments/mandate.ts warn before that happens instead of after.
--
-- WHY test_mode IS A COLUMN AND NOT INFERRED
--   Razorpay keys carry their mode in the key id, but a mandate outlives the key
--   configuration it was created under. Recording the mode ON THE MANDATE means a row
--   created in test can never later be read as a live authorisation because somebody
--   swapped the keys.
--
-- HOW TO VERIFY (SEPARATE run from the DDL — AGENTS.md §5):
--
--   select count(*) from public.payment_mandates;            -- expect 0
--   select policyname, cmd from pg_policies where tablename='payment_mandates';
--   -- expect select + update(cancel) only; NO insert policy

begin;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'mandate_status') then
    create type public.mandate_status as enum (
      'pending_authorisation', 'active', 'paused', 'cancelled', 'expired'
    );
  end if;
end $$;

create table if not exists public.payment_mandates (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  customer_id     uuid not null references public.customers(id) on delete cascade,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  /* 'upi' | 'emandate' | 'card'. Text rather than an enum: the set of rails a
     gateway supports changes faster than a migration cycle. */
  method          text not null default 'upi',
  status          public.mandate_status not null default 'pending_authorisation',
  /* ₹ per debit the customer approved. NULL until the gateway confirms — an amount
     we requested is not an amount anyone authorised. */
  max_amount      integer,
  /* ₹ we asked for, kept separately so a mismatch between request and approval is
     visible rather than overwritten. */
  requested_amount integer not null,
  /* Razorpay ids. plan and subscription are what the gateway manages; the auth link
     is what the customer opens to approve. */
  gateway               text not null default 'razorpay',
  gateway_plan_id       text,
  gateway_subscription_id text unique,
  gateway_customer_id   text,
  auth_link             text,
  /* TRUE when created against test keys. See the header — a mandate outlives the key
     configuration it was made under. */
  test_mode       boolean not null default true,
  authorised_at   timestamptz,
  cancelled_at    timestamptz,
  end_date        date,
  /* Why it stopped, in the gateway's words where it gave a reason. */
  status_note     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.payment_mandates
  drop constraint if exists payment_mandates_amounts_positive;
alter table public.payment_mandates
  add constraint payment_mandates_amounts_positive
  check (requested_amount > 0 and (max_amount is null or max_amount > 0));

/* One live mandate per subscription. Two active mandates means two debits for the
   same bill, which is the single worst bug this table could have. */
create unique index if not exists payment_mandates_one_live_per_sub
  on public.payment_mandates (subscription_id)
  where status in ('pending_authorisation', 'active') and subscription_id is not null;

create index if not exists payment_mandates_customer_idx
  on public.payment_mandates (tenant_id, customer_id, created_at desc);

comment on table public.payment_mandates is
  'Standing permission to debit a customer (UPI Autopay / e-NACH). "active" is set ONLY by a signature-verified gateway webhook — if the app could set it, a reseller would stop chasing a renewal that never collects.';
comment on column public.payment_mandates.max_amount is
  '₹ per debit the customer actually approved. Cannot be raised — a bigger bill needs a NEW mandate. A subscription that grows past this stops collecting silently, which is what lib/payments/mandate.ts warns about.';
comment on column public.payment_mandates.test_mode is
  'TRUE when created against test keys. On the row rather than inferred from current config, so a test mandate can never be read as a live authorisation after a key swap.';

alter table public.payment_mandates enable row level security;

drop policy if exists payment_mandates_select on public.payment_mandates;
create policy payment_mandates_select on public.payment_mandates
  for select using (tenant_id = (select tenant_id from public.users where id = auth.uid()));

/* Staff may CANCEL. Withdrawing permission must never depend on a webhook arriving —
   if a customer asks us to stop, we stop. Everything else about a mandate's state is
   the gateway's to say, and the service role is what writes it. */
drop policy if exists payment_mandates_cancel on public.payment_mandates;
create policy payment_mandates_cancel on public.payment_mandates
  for update
  using      (tenant_id = (select tenant_id from public.users where id = auth.uid()))
  with check (tenant_id = (select tenant_id from public.users where id = auth.uid())
              and status = 'cancelled');

-- No insert policy: mandates are created server-side after the gateway accepts one.

commit;
