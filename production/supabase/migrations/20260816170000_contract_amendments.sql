-- 20260816170000_contract_amendments
--
-- WHAT THIS ADDS
--   `contract_amendments` — an append-only record of every change to a subscription's
--   commercial terms: seats, price, plan, term, status.
--
-- WHY IT IS A TRIGGER AND NOT APPLICATION CODE
--   A subscription's seats change through at least five paths today: addSeats(), the
--   approved seat-request route, the "Correct details" dialog, Extend term, and the
--   renewal cron's roll-forward. Recording amendments in the app means five call
--   sites and a sixth added later by someone who does not know about the others —
--   and the one that gets forgotten is exactly the one somebody will need in a
--   dispute.
--
--   A trigger sees every write, including one typed into the SQL editor at midnight.
--   Same reasoning as trg_quotes_raise_provisioning.
--
-- WHAT PROBLEM THIS ACTUALLY SOLVES
--   Today a rep can open "Correct details" and change seats from 10 to 30, or the
--   plan from Business Starter to Enterprise, and NOTHING records what it was
--   before, when, or who did it. When a customer says "we never agreed to 30 seats",
--   there is no answer — only the current row, which agrees with the customer's
--   invoice and with nobody's memory.
--
-- HOW "IMMUTABLE" IS MEANT HERE, PRECISELY
--   Append-only, enforced by a trigger that raises on UPDATE and DELETE. That stops
--   the application, the service role, and anything going through PostgREST. It does
--   NOT stop a superuser who disables the trigger — nothing in Postgres can — so this
--   is tamper-EVIDENT at the database level, not tamper-proof against someone with
--   the keys to the database. Saying "immutable" without that sentence would overstate
--   what a ledger like this can promise.
--
-- WHY changed_by CAN BE NULL
--   auth.uid() is null for anything running under the service role — the crons, the
--   webhook, addSeats() called from an API route. Recording null and a `source` of
--   'system' is honest; attributing those to the last logged-in user would put a
--   person's name on a machine's change, which is worse than an unattributed one.
--
-- HOW TO VERIFY (SEPARATE run from the DDL — AGENTS.md §5):
--
--   select count(*) from public.contract_amendments;   -- expect 0
--   select tgname from pg_trigger where tgrelid = 'public.contract_amendments'::regclass;
--   -- expect trg_contract_amendments_append_only
--   update public.contract_amendments set note = 'x';  -- expect: raises

begin;

create table if not exists public.contract_amendments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  customer_name   text,
  /* What changed. Several can be true of one edit, so this is the headline and
     `changes` carries the detail. */
  kind            text not null,
  /* {field: {from, to}} for every commercial field that moved. jsonb because the set
     of fields will grow, and a column per field would need a migration each time. */
  changes         jsonb not null default '{}'::jsonb,
  /* Denormalised for the two the ledger is read for most — a seat dispute and a
     price dispute — so the common query needs no jsonb extraction. */
  seats_from      integer,
  seats_to        integer,
  mrr_from        integer,
  mrr_to          integer,
  changed_by      uuid references public.users(id) on delete set null,
  /* 'user' when a signed-in person did it, 'system' for crons and service-role
     routes. See the header on why these are not conflated. */
  source          text not null default 'user',
  note            text,
  created_at      timestamptz not null default now()
);

comment on table public.contract_amendments is
  'Append-only record of changes to a subscription''s commercial terms. Written by a trigger so no code path can forget. Tamper-EVIDENT, not tamper-proof: the append-only trigger stops the app and the service role, but not a superuser who disables it.';
comment on column public.contract_amendments.source is
  '"user" when auth.uid() was present, "system" otherwise. Attributing a cron''s change to the last logged-in user would put a person''s name on a machine''s edit.';

create index if not exists contract_amendments_sub_idx
  on public.contract_amendments (subscription_id, created_at desc);
create index if not exists contract_amendments_tenant_idx
  on public.contract_amendments (tenant_id, created_at desc);

alter table public.contract_amendments enable row level security;

drop policy if exists contract_amendments_select on public.contract_amendments;
create policy contract_amendments_select on public.contract_amendments
  for select using (tenant_id = (select tenant_id from public.users where id = auth.uid()));

-- No insert/update/delete policy: rows arrive only from the trigger below, which runs
-- as definer.

-- ── Append-only ───────────────────────────────────────────────────────────────
create or replace function public.contract_amendments_append_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- An edit is never allowed. A ledger that can be rewritten answers nothing.
  if tg_op = 'UPDATE' then
    raise exception 'contract_amendments is append-only — an amendment ledger that can be edited answers nothing in a dispute'
      using errcode = 'insufficient_privilege';
  end if;

  /* DELETE is allowed in exactly one case: the parent subscription is going away in
     this same transaction, so this is Postgres tidying up a child rather than
     somebody erasing history.

     Found by testing the cleanup rather than assuming it: blocking every delete made
     any subscription with an amendment permanently undeletable — and "Cancel /
     delete" exists precisely to fix a mistyped or duplicate entry, which is the one
     kind of subscription that certainly HAS amendments. The rule was making the
     button fail exactly where it was needed.

     During a cascade Postgres removes the parent first, so by the time this fires the
     subscription is already gone from the transaction's view. That is the
     discriminator. */
  if not exists (select 1 from public.subscriptions where id = old.subscription_id) then
    return old;
  end if;

  raise exception 'contract_amendments is append-only — delete the subscription itself if the whole record is being removed'
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists trg_contract_amendments_append_only on public.contract_amendments;
create trigger trg_contract_amendments_append_only
  before update or delete on public.contract_amendments
  for each row execute function public.contract_amendments_append_only();

-- ── The recorder ──────────────────────────────────────────────────────────────
create or replace function public.record_contract_amendment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changes jsonb := '{}'::jsonb;
  v_kinds   text[] := '{}';
  v_uid     uuid   := auth.uid();
begin
  /* Only COMMERCIAL terms. A domain correction or a reminder timestamp is not an
     amendment, and recording every column change would bury the seat history that
     the ledger exists for under cron noise. */
  if new.seats is distinct from old.seats then
    v_changes := v_changes || jsonb_build_object('seats', jsonb_build_object('from', old.seats, 'to', new.seats));
    v_kinds := v_kinds || (case when new.seats > old.seats then 'seats_added' else 'seats_reduced' end)::text;
  end if;

  if new.mrr is distinct from old.mrr then
    v_changes := v_changes || jsonb_build_object('mrr', jsonb_build_object('from', old.mrr, 'to', new.mrr));
    v_kinds := v_kinds || 'price_changed'::text;
  end if;

  if new.plan is distinct from old.plan then
    v_changes := v_changes || jsonb_build_object('plan', jsonb_build_object('from', old.plan, 'to', new.plan));
    v_kinds := v_kinds || 'plan_changed'::text;
  end if;

  if new.renewal_date is distinct from old.renewal_date then
    v_changes := v_changes || jsonb_build_object('renewal_date', jsonb_build_object('from', old.renewal_date, 'to', new.renewal_date));
    v_kinds := v_kinds || 'term_changed'::text;
  end if;

  if new.status is distinct from old.status then
    v_changes := v_changes || jsonb_build_object('status', jsonb_build_object('from', old.status, 'to', new.status));
    v_kinds := v_kinds || 'status_changed'::text;
  end if;

  if new.billing_cycle is distinct from old.billing_cycle then
    v_changes := v_changes || jsonb_build_object('billing_cycle', jsonb_build_object('from', old.billing_cycle, 'to', new.billing_cycle));
    v_kinds := v_kinds || 'billing_cycle_changed'::text;
  end if;

  if v_changes = '{}'::jsonb then
    return new;   -- nothing commercial moved
  end if;

  insert into public.contract_amendments (
    tenant_id, subscription_id, customer_name, kind, changes,
    seats_from, seats_to, mrr_from, mrr_to, changed_by, source
  ) values (
    new.tenant_id, new.id, new.customer_name,
    array_to_string(v_kinds, '+'),
    v_changes,
    case when new.seats is distinct from old.seats then old.seats end,
    case when new.seats is distinct from old.seats then new.seats end,
    case when new.mrr   is distinct from old.mrr   then old.mrr   end,
    case when new.mrr   is distinct from old.mrr   then new.mrr   end,
    v_uid,
    case when v_uid is null then 'system' else 'user' end
  );

  return new;
end;
$$;

drop trigger if exists trg_subscriptions_record_amendment on public.subscriptions;
create trigger trg_subscriptions_record_amendment
  after update on public.subscriptions
  for each row execute function public.record_contract_amendment();

comment on function public.record_contract_amendment() is
  'Writes an amendment row when a subscription''s COMMERCIAL terms move. In Postgres rather than the app because seats change through five different code paths and the one that gets forgotten is the one needed in a dispute.';

commit;
