-- ═══════════════════════════════════════════════════════════════════════════
-- AI autonomy dial, kill switch, and the log of what the app did on its own
--
-- WHY, and the measurement behind it (23 Aug 2026)
-- ------------------------------------------------------------------------
-- Asked whether an AI sales agent could replace a salesperson. The audit turned up
-- something more urgent than the answer: THERE IS NO WAY TO STOP THIS APP EMAILING
-- CUSTOMERS FROM INSIDE THIS APP. Five crons send unattended today — invoice dunning,
-- renewals, trial expiry, compliance reminders, birthday greetings — and stopping any of
-- them means disabling a Cloud Scheduler job in a Google console. Grepped for ai_enabled /
-- emails_paused / sending_paused / DISABLE_EMAIL: nothing existed.
--
-- So this migration is not scaffolding for a future agent. It is the brake the current app
-- is missing.
--
-- WHY NOT REUSE activity_log
-- ------------------------------------------------------------------------
-- Checked first, because a second log that overlaps the first is worse than no log.
-- activity_log holds (tenant_id, user_id, action, entity, entity_id, label) and answers
-- "what happened". An automated action needs three things it has no room for: the REASON in
-- a sentence a non-engineer can act on; the FACTS the decision rested on (if a quote went
-- out wrong, the first question is what we thought we knew); and HELD versus DONE, because
-- restraint is most of what this system does and a log of only sends would make a careful
-- system look idle.
--
-- BEHAVIOUR IS UNCHANGED BY THIS MIGRATION, deliberately
-- ------------------------------------------------------------------------
-- ai_kill_switch defaults FALSE and ai_autonomy starts EMPTY. lib/ai/autonomy.ts falls back
-- to each action's declared current behaviour when there is no row, so nothing starts or
-- stops today. Introducing a brake must not itself change what the car is doing; turning
-- something off is a separate, visible decision.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. The kill switch ─────────────────────────────────────────────────────
-- On the tenant, because it is a property of the workspace and has to be readable in the
-- same breath as the tenant row. Additive with a default, so no existing row changes
-- meaning and no code that does not know about it can break.
alter table public.tenants
  add column if not exists ai_kill_switch boolean not null default false;

comment on column public.tenants.ai_kill_switch is
  'When true, every automated customer-facing action is refused, whatever ai_autonomy says. '
  'The switch somebody reaches for when a wrong price has gone out — it must work without '
  'reading ten rows first. Enforced in lib/ai/autonomy.ts (resolveAutonomy).';

-- ── 2. The per-action dial ─────────────────────────────────────────────────
create table if not exists public.ai_autonomy (
  tenant_id  uuid        not null references public.tenants(id) on delete cascade,
  -- Matches a key of AI_ACTIONS in lib/ai/autonomy.ts. Text and not an enum on purpose:
  -- adding an action must not need a migration, and an unknown key is already handled —
  -- resolveAutonomy falls back to the action's declared default and says it did.
  action     text        not null,
  mode       text        not null check (mode in ('off', 'hold', 'auto')),
  updated_at timestamptz not null default now(),
  updated_by uuid        references public.users(id) on delete set null,
  primary key (tenant_id, action)
);

comment on table public.ai_autonomy is
  'Per-action autonomy: off = never, hold = prepare and wait for a person, auto = act '
  'unattended. A MISSING ROW is not "off" — lib/ai/autonomy.ts falls back to what the app '
  'does today, so this table starting empty changes nothing.';

-- ── 3. The log ─────────────────────────────────────────────────────────────
create table if not exists public.ai_action_log (
  id         bigserial   primary key,
  tenant_id  uuid        not null references public.tenants(id) on delete cascade,
  created_at timestamptz not null default now(),
  action     text        not null,
  -- did = done unattended · held = prepared, waiting for a person · skipped = deliberately
  -- not done (mode off, or kill switch) · failed = tried and broke.
  -- skipped and failed are kept APART: merging them would make a working kill switch look
  -- like an outage.
  outcome    text        not null check (outcome in ('did', 'held', 'skipped', 'failed')),
  -- One sentence, for somebody who did not write the code. Not an error code.
  reason     text        not null,
  -- The autonomy mode in force at the time, so a row stays explicable after a dial moves.
  mode       text        not null check (mode in ('off', 'hold', 'auto')),
  entity     text,
  entity_id  text,
  -- Flat scalars only; message bodies are redacted by key name before they get here.
  -- See buildAiActionRecord in lib/ai/action-log.ts, which is the only intended writer.
  facts      jsonb       not null default '{}'::jsonb
);

comment on table public.ai_action_log is
  'What the app did on its own, and why. Written by buildAiActionRecord (lib/ai/action-log.ts), '
  'which redacts message bodies by key name and refuses nested facts so this cannot become a '
  'request dump. HELD rows are the ones worth reading: each is a customer waiting on a '
  'decision only a person can make.';

-- The one query the UI will make: this workspace, newest first.
create index if not exists ai_action_log_tenant_time_idx
  on public.ai_action_log (tenant_id, created_at desc);

-- And the one the operator will make: what is waiting on me.
create index if not exists ai_action_log_held_idx
  on public.ai_action_log (tenant_id, created_at desc)
  where outcome = 'held';

-- ── 4. RLS — every table, no exceptions (CLAUDE.md §4) ─────────────────────
alter table public.ai_autonomy    enable row level security;
alter table public.ai_action_log  enable row level security;

-- Read: anyone in the tenant. This is the tenant's own record of its own automation, and a
-- log only the owner can read is a log nobody reads.
drop policy if exists ai_autonomy_select on public.ai_autonomy;
create policy ai_autonomy_select on public.ai_autonomy
  for select using (tenant_id = public.current_tenant_id());

drop policy if exists ai_action_log_select on public.ai_action_log;
create policy ai_action_log_select on public.ai_action_log
  for select using (tenant_id = public.current_tenant_id());

-- Write the dial: owners and managers only. Turning automation on is a commercial decision
-- and a sales user must not be able to make it for the workspace.
drop policy if exists ai_autonomy_write on public.ai_autonomy;
create policy ai_autonomy_write on public.ai_autonomy
  for all using (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.tenant_id = public.current_tenant_id()
        and u.role in ('owner', 'manager')
    )
  );

-- NO insert/update/delete policy on ai_action_log, and that is the point: an audit trail
-- the audited party can edit is not an audit trail. The app writes it through the service
-- role, which bypasses RLS; nothing holding a user session can add, alter or remove a row.
-- If a retention policy is ever wanted, it belongs in a dated job that says what it deleted,
-- not in a user-facing DELETE.

commit;
