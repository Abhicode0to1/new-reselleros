-- ============================================================
-- ResellerOS — follow-up task management
-- Migration: 0007_tasks.sql
-- ============================================================
-- Purpose
--   Sales reps need to capture "call this lead Friday", "email Rohit
--   the proposal Monday", "follow up on Cosmo Tech renewal in 30 days"
--   and have the system surface them at the right time. Without a
--   tasks table everything lives in someone's head (or worse, a
--   sticky note that gets lost).
--
--   This migration adds the `tasks` table — a polymorphic to-do
--   anchored to a lead / quote / customer / subscription (any one
--   of them) with a due timestamp + owner.
--
-- Status lifecycle
--   pending → done (rep marks complete)
--           → snoozed (push due_at forward, status returns to pending)
--           → cancelled (no longer relevant)
--
-- Reminders (Phase 1)
--   Surfaced in-app only: dashboard "today" widget, /tasks page,
--   top-bar notification bell badge. Push / WhatsApp / email
--   reminders come later when Resend + Gupshup are wired.
-- ============================================================

begin;

-- ============================================================
-- Enums
-- ============================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'task_status') then
    create type public.task_status as enum ('pending', 'done', 'snoozed', 'cancelled');
  end if;
  if not exists (select 1 from pg_type where typname = 'task_kind') then
    create type public.task_kind as enum ('call', 'email', 'meeting', 'followup', 'custom');
  end if;
end $$;

-- ============================================================
-- Table
-- ============================================================
create table if not exists public.tasks (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,

  -- The sales rep this task is for. Nullable so deleting a user doesn't
  -- wipe their open tasks — those should land in an "unassigned" bucket
  -- for re-assignment by the owner.
  owner_id     uuid references public.users(id) on delete set null,

  title        text not null,
  notes        text,
  kind         public.task_kind   not null default 'followup',

  -- Due timestamp in UTC; clients render in IST.
  due_at       timestamptz        not null,

  -- How many minutes before due_at to surface in the "soon" bucket.
  -- 0 = surface at due_at exactly. Default 60 = one-hour heads-up.
  reminder_minutes_before smallint not null default 60 check (reminder_minutes_before >= 0),

  status       public.task_status not null default 'pending',

  -- Polymorphic links — at most one of these will be set per task.
  -- Using multiple typed columns rather than a (type, id) pair so FK
  -- integrity + cascade delete work natively. The CHECK enforces the
  -- "at most one" rule.
  lead_id         text  references public.leads(id)         on delete cascade,
  quote_id        text  references public.quotes(id)        on delete cascade,
  customer_id     uuid  references public.customers(id)     on delete cascade,
  subscription_id uuid  references public.subscriptions(id) on delete cascade,

  created_at   timestamptz not null default now(),
  completed_at timestamptz,
  completed_by uuid references public.users(id) on delete set null,

  -- Audit hint: how many times has this task been pushed forward
  -- without completing? Useful for surfacing chronic-snoozer leads.
  snooze_count smallint not null default 0 check (snooze_count >= 0),

  -- "At most one linked entity" enforced via check constraint.
  constraint tasks_one_link_only check (
    (case when lead_id         is null then 0 else 1 end)
  + (case when quote_id        is null then 0 else 1 end)
  + (case when customer_id     is null then 0 else 1 end)
  + (case when subscription_id is null then 0 else 1 end)
  <= 1
  )
);

comment on table  public.tasks            is 'Follow-up to-dos for sales reps. Polymorphic — anchored to one lead/quote/customer/subscription.';
comment on column public.tasks.due_at     is 'UTC timestamp when this task is due. Clients render in IST.';
comment on column public.tasks.kind       is 'Affordance hint for the rendering UI (icon, default reminder window).';
comment on column public.tasks.snooze_count is 'Increment each time due_at is pushed forward — surfaces chronic snoozers.';

-- ============================================================
-- Indexes — tuned for the queries the UI will actually run
-- ============================================================

-- "My open tasks, soonest first" — primary list-page query
create index if not exists tasks_owner_due_pending_idx
  on public.tasks (owner_id, due_at)
  where status = 'pending';

-- "All open tasks in tenant due today / overdue" — dashboard widget,
-- bell badge count, /tasks Today + Overdue tabs.
create index if not exists tasks_tenant_due_pending_idx
  on public.tasks (tenant_id, due_at)
  where status = 'pending';

-- Per-link drawer queries
create index if not exists tasks_lead_idx         on public.tasks (lead_id)         where lead_id         is not null;
create index if not exists tasks_quote_idx        on public.tasks (quote_id)        where quote_id        is not null;
create index if not exists tasks_customer_idx     on public.tasks (customer_id)     where customer_id     is not null;
create index if not exists tasks_subscription_idx on public.tasks (subscription_id) where subscription_id is not null;

-- ============================================================
-- RLS — same shape as every other tenant-scoped table
-- ============================================================
alter table public.tasks enable row level security;

create policy "tasks_select"
  on public.tasks for select to authenticated
  using (tenant_id = public.current_tenant_id());

create policy "tasks_insert"
  on public.tasks for insert to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy "tasks_update"
  on public.tasks for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy "tasks_delete"
  on public.tasks for delete to authenticated
  using (tenant_id = public.current_tenant_id());

-- ============================================================
-- Trigger: when a task is marked 'done', stamp completed_at / completed_by.
-- Lets callers do a plain `update ... set status='done'` without
-- remembering to set the audit columns themselves.
-- ============================================================
create or replace function public.handle_task_completion()
returns trigger language plpgsql as $$
begin
  if new.status = 'done' and (old.status is distinct from 'done') then
    new.completed_at := now();
    new.completed_by := auth.uid();
  end if;
  -- If reopened (done → pending), clear the audit stamps
  if old.status = 'done' and new.status <> 'done' then
    new.completed_at := null;
    new.completed_by := null;
  end if;
  return new;
end $$;

drop trigger if exists trg_tasks_completion on public.tasks;
create trigger trg_tasks_completion
  before update on public.tasks
  for each row execute function public.handle_task_completion();

commit;

-- ============================================================
-- Smoke (run manually):
--
--   -- Create a task linked to the Sharma lead, due in 30 minutes
--   insert into public.tasks (tenant_id, owner_id, title, due_at, lead_id)
--   select t.id, u.id, 'Call Ananya about renewal', now() + interval '30 min', 'L-MPI2HG3A'
--   from public.tenants t, public.users u
--   where t.email = 'pardeep.webmaster@gmail.com' and u.email = 'pardeep.webmaster@gmail.com'
--   limit 1;
--
--   -- Verify the polymorphic check fires
--   insert into public.tasks (tenant_id, title, due_at, lead_id, quote_id)
--   values ('<tid>', 'bad', now(), 'L-X', 'Q-X');
--   -- → expect: tasks_one_link_only violation
-- ============================================================
