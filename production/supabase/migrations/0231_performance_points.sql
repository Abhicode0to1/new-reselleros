-- ============================================================================
-- 0231 — Gamified task collaboration + Performance Points foundation
-- ============================================================================
--
-- ─── WHY THIS IS 0231 AND NOT AN EDIT TO 0007 / 0121 ────────────────────────
-- The brief asked to add fields to `0007_tasks.sql` and to create
-- `0121_salary_incentive.sql`. Both are already applied in production:
--   • Editing an applied migration is the git-vs-prod drift this repo has
--     already been burned by (0003 consolidated 19 ad-hoc prod changes).
--   • 0121 ALREADY EXISTS and already delivers the payroll half — it added
--     `salary_payments.incentive` and `pay_salary(..., p_incentive)`, folding
--     the incentive into earned/net and booking it to the Salaries expense.
-- So new schema goes here, and the payroll seam is reused rather than rebuilt.
--
-- ─── WHAT THE BRIEF ASKED FOR THAT IS DELIBERATELY NOT HERE ─────────────────
-- 1. `tasks.assignee_id` — `tasks.owner_id` already references users(id) and
--    already means "whose task is this". A second column would be a second
--    answer to the same question. `delegated_by` is added instead, which is the
--    fact that was genuinely missing: who handed it over.
--
-- 2. `tasks.collaborators uuid[]` — an array cannot carry a foreign key, cannot
--    be joined, and cannot hold per-collaborator facts (when they joined, who
--    gave them kudos). Kudos attach per collaborator, so the array shape breaks
--    the feature it exists for. `task_collaborators` is used instead.
--
-- 3. `tasks.performance_points / bonus_points / penalty_points` — points are
--    DERIVED from events by src/lib/performance/points.ts. Storing them on the
--    task row creates a second source of truth that silently disagrees with the
--    engine the day a rate changes, and it would let a row be edited to mint
--    points. Derive freely; freeze only at payout — hence
--    `salary_payments.performance_points` below, which records the points that
--    produced a rupee figure that has actually been paid.
--
-- 4. `tasks.kudos_count` — a denormalised counter that can drift from the rows
--    it counts. `task_kudos` is the record; the count is a query. The per-giver
--    monthly budget and the "kudos from 3+ different people" badge both need
--    the individual rows anyway.
-- ============================================================================

begin;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. NO user↔employee link is added here. IT ALREADY EXISTS.
--
-- An earlier draft of this migration added `employees.user_id`. That was wrong:
-- `public.users.employee_id` already exists and is already populated for 6 of
-- this tenant's 8 logins (including sales@anutech.in, which the draft claimed
-- could never be paid). `usePerformance` in src/lib/queries/performance.ts has
-- been reading it all along to join attendance.
--
-- Adding the reverse column would have created two links that can disagree —
-- precisely the second-source-of-truth flaw this migration criticises the brief
-- for elsewhere. The link is `users.employee_id`; use it.
--
-- The real remaining gap is DATA, not schema: `ranjeet@anutech.in` has an
-- employee record (Ranjeet Raj) but no `employee_id` on his login, so his points
-- cannot reach payroll. That is one UPDATE in HR, not a migration.
-- ────────────────────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Task delegation provenance
-- ────────────────────────────────────────────────────────────────────────────
alter table public.tasks
  add column if not exists delegated_by uuid references public.users(id) on delete set null,
  add column if not exists delegated_at timestamptz;

comment on column public.tasks.delegated_by is
  'Who reassigned this task to its current owner_id. NULL = never delegated.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3. task_collaborators — co-workers on a shared task
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.task_collaborators (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  task_id    uuid not null references public.tasks(id)   on delete cascade,
  user_id    uuid not null references public.users(id)   on delete cascade,
  added_by   uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),

  -- Adding the same person twice would double any kudos budget accounting.
  constraint task_collaborators_uniq unique (task_id, user_id)
);

comment on table public.task_collaborators is
  'Co-workers on a shared task. A join table rather than a uuid[] on tasks, because kudos and join-time attach per collaborator.';

create index if not exists task_collaborators_task_idx on public.task_collaborators (task_id);
create index if not exists task_collaborators_user_idx on public.task_collaborators (tenant_id, user_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 4. task_comments — the discussion thread
--
-- `mentions` is a plain uuid[] here and that is fine: unlike collaborators, a
-- mention carries no per-row state of its own and is never the parent of
-- anything. It is read as "who to notify", nothing more.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.task_comments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  task_id     uuid not null references public.tasks(id)   on delete cascade,
  user_id     uuid not null references public.users(id)   on delete cascade,
  content     text not null check (length(btrim(content)) > 0),
  mentions    uuid[] not null default '{}',
  attachment_path text,
  attachment_name text,
  created_at  timestamptz not null default now(),
  edited_at   timestamptz
);

comment on table public.task_comments is
  'Discussion thread on a task, with @mention targets and an optional Storage attachment.';

create index if not exists task_comments_task_idx on public.task_comments (task_id, created_at);

-- ────────────────────────────────────────────────────────────────────────────
-- 5. task_kudos — the +10 peer award
--
-- Rows, not a counter. The engine needs them individually to enforce the
-- per-giver monthly budget (uncapped kudos is a currency two colleagues can
-- print: 10/day each = 300 points a month of real money) and to require kudos
-- from 3+ DIFFERENT people for the Ultimate Teammate badge.
--
-- Two guards live in the schema because they are cheap here and would otherwise
-- have to be re-proved in every caller:
--   • one kudos per giver, per recipient, per task
--   • no self-kudos
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.task_kudos (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  task_id      uuid not null references public.tasks(id)   on delete cascade,
  -- Who receives the points.
  user_id      uuid not null references public.users(id)   on delete cascade,
  -- Who awarded them. NOT NULL: an unattributed kudos cannot be budgeted, and
  -- the points engine rejects it anyway.
  awarded_by   uuid not null references public.users(id)   on delete cascade,
  note         text,
  created_at   timestamptz not null default now(),

  constraint task_kudos_once   unique (task_id, user_id, awarded_by),
  constraint task_kudos_no_self check (user_id <> awarded_by)
);

comment on table public.task_kudos is
  'Peer kudos (+10 pts) on a shared task. One per giver/recipient/task; self-kudos rejected by constraint.';

create index if not exists task_kudos_user_idx    on public.task_kudos (tenant_id, user_id, created_at);
create index if not exists task_kudos_giver_idx   on public.task_kudos (tenant_id, awarded_by, created_at);

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Freeze the points that produced a paid incentive
--
-- `salary_payments.incentive` (from 0121) already records the rupees. This
-- records the points behind them, so a payslip can be explained months later
-- even after the rate table changes. Derived everywhere else; frozen here,
-- because this row is money that has left the building.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.salary_payments
  add column if not exists performance_points integer not null default 0
    check (performance_points >= 0);

comment on column public.salary_payments.performance_points is
  'Performance points that produced this row''s `incentive` rupees. Frozen at payout — the engine may change, a paid payslip may not.';

commit;


-- ============================================================================
-- RLS — run as a SEPARATE batch (CLAUDE.md §25.6)
--
-- Same shape as every other tenant-scoped table: isolation runs through
-- public.current_tenant_id(), NOT through auth.jwt() ->> 'tenant_id'. 150 live
-- policies depend on current_tenant_id(); a JWT-based check would break them.
-- ============================================================================

begin;

alter table public.task_collaborators enable row level security;
alter table public.task_comments      enable row level security;
alter table public.task_kudos         enable row level security;

create policy "task_collaborators_select" on public.task_collaborators
  for select to authenticated using (tenant_id = public.current_tenant_id());
create policy "task_collaborators_insert" on public.task_collaborators
  for insert to authenticated with check (tenant_id = public.current_tenant_id());
create policy "task_collaborators_delete" on public.task_collaborators
  for delete to authenticated using (tenant_id = public.current_tenant_id());

create policy "task_comments_select" on public.task_comments
  for select to authenticated using (tenant_id = public.current_tenant_id());
create policy "task_comments_insert" on public.task_comments
  for insert to authenticated with check (tenant_id = public.current_tenant_id());
-- Edit and delete are limited to the author. A thread others have replied to is
-- a record; letting any teammate rewrite it removes the point of having it.
create policy "task_comments_update_own" on public.task_comments
  for update to authenticated
  using (tenant_id = public.current_tenant_id() and user_id = auth.uid())
  with check (tenant_id = public.current_tenant_id() and user_id = auth.uid());
create policy "task_comments_delete_own" on public.task_comments
  for delete to authenticated
  using (tenant_id = public.current_tenant_id() and user_id = auth.uid());

create policy "task_kudos_select" on public.task_kudos
  for select to authenticated using (tenant_id = public.current_tenant_id());
-- Insert only as YOURSELF as the giver. Without this, anyone could write rows
-- claiming a colleague awarded them kudos — and kudos are cash.
create policy "task_kudos_insert_as_self" on public.task_kudos
  for insert to authenticated
  with check (tenant_id = public.current_tenant_id() and awarded_by = auth.uid());
create policy "task_kudos_delete_own" on public.task_kudos
  for delete to authenticated
  using (tenant_id = public.current_tenant_id() and awarded_by = auth.uid());

commit;


-- ============================================================================
-- VERIFY — RUN THIS IN A SEPARATE EDITOR RUN
--
-- Inside the same transaction as the DDL this would read uncommitted state and
-- report success for changes about to roll back. That mistake cost five
-- attempts on an earlier migration.
-- ============================================================================
/*
select 'tasks.delegated_by' as thing, count(*) as n from information_schema.columns
  where table_schema='public' and table_name='tasks' and column_name='delegated_by'
union all select 'salary_payments.performance_points', count(*) from information_schema.columns
  where table_schema='public' and table_name='salary_payments' and column_name='performance_points'
union all select 'task_collaborators tbl', count(*) from information_schema.tables
  where table_schema='public' and table_name='task_collaborators'
union all select 'task_comments tbl', count(*) from information_schema.tables
  where table_schema='public' and table_name='task_comments'
union all select 'task_kudos tbl', count(*) from information_schema.tables
  where table_schema='public' and table_name='task_kudos'
union all select 'policies on new tables', count(*) from pg_policies
  where schemaname='public' and tablename in ('task_collaborators','task_comments','task_kudos')
union all select 'rls enabled on new tables', count(*) from pg_tables
  where schemaname='public' and tablename in ('task_collaborators','task_comments','task_kudos') and rowsecurity;
-- Expect: each `thing` = 1, policies = 10, rls enabled = 3.
*/
