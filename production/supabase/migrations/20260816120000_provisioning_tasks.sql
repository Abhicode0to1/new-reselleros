-- 20260816120000_provisioning_tasks
--
-- WHAT THIS ADDS
--   `provisioning_tasks` — one row per thing that has to be created at a vendor once a
--   quote is paid, plus a trigger that raises those rows automatically.
--
-- WHY THE TRIGGER LIVES IN POSTGRES AND NOT IN THE APP
--   A quote reaches payment_status='received' by four different routes today: the
--   Razorpay webhook, the operator's "Record payment" dialog, the simulation path on
--   the public pay route, and record_payment called from a renewal. Hooking the app
--   would mean four call sites and a fifth one added later by someone who did not know
--   about the other four — this codebase has already been bitten three times by one
--   rule written twice. A trigger on the row is the single place the fact becomes true.
--
-- WHY THE TRIGGER DOES NOT PARSE PLANS OR DECIDE VENDORS
--   It raises exactly ONE row per paid quote, deliberately unresolved, and the app
--   expands it into per-line tasks using lib/provisioning/plan.ts. Vendor matching is a
--   string-matching rule that will change; a copy of it in PL/pgSQL is a second rule
--   table to keep in step, which is the mistake this migration's own comment warns
--   about above. Postgres records THAT provisioning is owed; TypeScript decides what.
--
-- WHAT NO VENDOR API MEANS FOR THIS TABLE
--   Nothing here calls Google CSP or Microsoft Partner Center, because no credential
--   for either exists on this project. Every task is `mode='manual'` and a human does
--   the work from a specific, actionable line. The alternative — writing 'done' on
--   insert — would show "Provisioned ✓" on a quote where nobody created a mailbox.
--
-- HOW TO VERIFY (SEPARATE run from the DDL — AGENTS.md §5):
--
--   select count(*) from public.provisioning_tasks;   -- expect 0: no quote is paid yet
--   select tgname from pg_trigger where tgrelid = 'public.quotes'::regclass
--     and tgname = 'trg_quotes_raise_provisioning';
--   select policyname from pg_policies where tablename='provisioning_tasks';

begin;

create table if not exists public.provisioning_tasks (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  quote_id     text not null references public.quotes(id) on delete cascade,
  /* Null until the app expands the quote's lines. See the header on why the trigger
     does not do this itself. */
  vendor       text,
  plan         text,
  seats        integer,
  domain       text,
  /* 'api' the day a vendor client exists; 'manual' until then. */
  mode         text not null default 'manual',
  status       text not null default 'pending',
  error_message text,
  /* Who did it, when — a manual task still needs an audit trail. */
  completed_by uuid references public.users(id) on delete set null,
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.provisioning_tasks is
  'Seats to be created at a vendor once a quote is paid. Raised by trg_quotes_raise_provisioning as ONE unresolved row per quote; the app expands it per line using lib/provisioning/plan.ts. No vendor API is connected, so every task is manual — see the migration header.';
comment on column public.provisioning_tasks.status is
  'pending | in_progress | done | failed | not_required. "not_required" is a real outcome (a services-only quote), NOT a silent success.';

create index if not exists provisioning_tasks_quote_idx  on public.provisioning_tasks (quote_id);
create index if not exists provisioning_tasks_open_idx
  on public.provisioning_tasks (tenant_id, created_at desc)
  where status in ('pending', 'in_progress', 'failed');

alter table public.provisioning_tasks enable row level security;

drop policy if exists provisioning_tasks_select on public.provisioning_tasks;
create policy provisioning_tasks_select on public.provisioning_tasks
  for select using (tenant_id = (select tenant_id from public.users where id = auth.uid()));

drop policy if exists provisioning_tasks_write on public.provisioning_tasks;
create policy provisioning_tasks_write on public.provisioning_tasks
  for all
  using      (tenant_id = (select tenant_id from public.users where id = auth.uid()))
  with check (tenant_id = (select tenant_id from public.users where id = auth.uid()));

-- ── The trigger ───────────────────────────────────────────────────────────────
create or replace function public.raise_provisioning_on_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  /* Only on the TRANSITION into paid. Firing on every update of a paid quote would
     raise a fresh task each time anyone edited a note. */
  if new.payment_status in ('received', 'invoiced')
     and coalesce(old.payment_status, 'none') not in ('received', 'invoiced')
  then
    /* Idempotent regardless: a quote may reach 'received' then 'invoiced', and both
       are "paid". One provisioning obligation per quote, ever. */
    if not exists (select 1 from public.provisioning_tasks where quote_id = new.id) then
      insert into public.provisioning_tasks (tenant_id, quote_id, status)
      values (new.tenant_id, new.id, 'pending');
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_quotes_raise_provisioning on public.quotes;
create trigger trg_quotes_raise_provisioning
  after update of payment_status on public.quotes
  for each row
  execute function public.raise_provisioning_on_payment();

comment on function public.raise_provisioning_on_payment() is
  'Raises ONE provisioning obligation when a quote first becomes paid. Records THAT provisioning is owed; lib/provisioning/plan.ts decides WHAT — vendor matching is a rule that changes, and a copy of it here would be a second rule table to keep in step.';

commit;
