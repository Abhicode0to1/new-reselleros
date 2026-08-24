-- ═══════════════════════════════════════════════════════════════════════════
-- AI Support Agent — conversation memory, escalation, assignment, and the SLA clock
--
-- WHAT ALREADY EXISTED, CHECKED BEFORE WRITING (24 Aug 2026, against prod)
-- ------------------------------------------------------------------------
-- AGENTS.md §11 says search first. Almost all of the plumbing a support agent needs is
-- already here, and building a parallel copy of it would have been the expensive mistake:
--
--   · `support_tickets` — id, customer, raised_by_email, category, priority, status, tier,
--     sla_due_at, first_responded_at, resolved_at/by/note. Measured: 0 rows in production,
--     so extending it costs nothing and duplicating it would have cost a data migration.
--   · `lib/inbound/routing.ts` already routes support@ / help@ / helpdesk@ to a `support`
--     branch, and `api/webhooks/inbound-email` already OPENS a ticket from that branch and
--     links it back via `inbound_emails.ticket_id`.
--   · `stamp_support_ticket_sla` (20260817170100) already stamps `tier` and `sla_due_at`
--     on INSERT, from the customer's plan. The SLA hours live there, not in application code.
--   · `ai_autonomy` + `ai_action_log` (20260823140000) already gate and record every
--     unattended send.
--
-- So this migration adds only the three things that genuinely do not exist:
--
--   1. MEMORY OF THE CONVERSATION. Every AI call in this repo sees one message. A support
--      engineer who forgot the previous mail would ask the customer to re-run the same DNS
--      check twice, which is precisely how a support thread stops being trusted.
--   2. "A PERSON MUST TAKE THIS ONE." A service outage or a low-confidence read has to stop
--      and fetch a human. Without a flag and a reason, "stop" can only mean "do nothing",
--      which is indistinguishable from the agent being switched off.
--   3. AN ASSIGNMENT AND A REPLY CLOCK. "Escalated 40 minutes ago and nobody has picked it
--      up" is unanswerable today: there is no assignee column and nothing records when the
--      AI last spoke.
--
-- WHY THERE IS NO `ai_support_tickets` TABLE, THOUGH THE BRIEF ASKED FOR ONE
-- ------------------------------------------------------------------------
-- The brief specified a new `ai_support_tickets` table whose columns are, field for field,
-- the columns `support_tickets` already has. Two ticket tables would mean:
--   · the support dashboard's status counts add up to less than the truth, because it reads
--     one table (`api/support/tickets` → counts per status)
--   · `inbound_emails.ticket_id`, the SLA trigger, the portal's "my tickets" page and the
--     feedback back-fill would all point at the OLD table while the agent wrote to the new one
--   · "how many tickets are open" would have two defensible answers
-- One ticket is one row wherever it came from. The AI-specific facts are columns on that row,
-- below, and the transcript is its own table for the reason given in §2.
--
-- WHY NO NEW `status` VALUES, THOUGH THE BRIEF ASKED FOR `escalated_to_human`
-- ------------------------------------------------------------------------
-- `status` is a CLOSED vocabulary in the UI — open · in_progress · awaiting_customer ·
-- resolved · closed (database.types.ts:3168, and the dashboard renders one filter tab and one
-- count per value). A sixth value would create tickets that appear in no tab and in no count,
-- so the page would quietly under-report exactly the tickets that need a person most.
--
-- Escalation is therefore a FACT ON THE ROW (`ai_escalated`, with a reason and a timestamp)
-- and the status stays `open`, which is what an escalated ticket honestly is: nobody has
-- answered it yet. The three other outcomes map onto values that already exist and already
-- mean the right thing:
--   AUTO_REPLY_AND_RESOLVE  → status 'resolved'
--   REQUEST_MORE_INFO       → status 'awaiting_customer'
--   ESCALATE_TO_HUMAN       → status 'open'  + ai_escalated = true
--   48h with no reply       → status 'closed'
--
-- BEHAVIOUR IS UNCHANGED BY THIS MIGRATION
-- ------------------------------------------------------------------------
-- The new table starts empty, every new column is nullable or defaults to the status quo, and
-- the two new autonomy actions declare themselves `hold` in lib/ai/autonomy.ts — so the agent
-- drafts and files, and sends nothing, until somebody moves the dial. Adding the capability
-- must not be the same event as switching it on; same discipline as the two AI migrations
-- before this one.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. The key the composite FK below needs ────────────────────────────────
-- Additive and cannot fail on existing data: `id` is already the primary key, so any pair
-- containing it is unique for free. Same step the sales-agent migration needed on `leads`.
alter table public.support_tickets
  drop constraint if exists support_tickets_tenant_id_key;
alter table public.support_tickets
  add constraint support_tickets_tenant_id_key unique (tenant_id, id);

-- ── 2. Which channel the ticket arrived on ─────────────────────────────────
-- NULLABLE, with no default, and that is deliberate. Three existing paths create tickets
-- (inbound email, the customer portal, the in-app feedback dialog) and none of them will set
-- this until it is touched. A default of 'app' would label every historic and portal-raised
-- ticket as something it is not, and a wrong value is worse than an absent one — the whole of
-- AGENTS.md §2. NULL reads as "not recorded", which is true.
--
-- It is load-bearing for more than reporting: the agent answers on the channel the customer
-- wrote in on. Replying to an email over WhatsApp would be a surprising thing to do to a
-- stranger.
alter table public.support_tickets
  add column if not exists channel text;

alter table public.support_tickets
  drop constraint if exists support_tickets_channel_check;
alter table public.support_tickets
  add constraint support_tickets_channel_check
  check (channel is null or channel in ('email', 'whatsapp', 'portal', 'app'));

comment on column public.support_tickets.channel is
  'Where this ticket came in: email, whatsapp, portal or app. NULL means it was created '
  'before the column existed, or by a path that does not record it — not "app". It also tells '
  'you how to read raised_by_email: see that column''s comment.';

-- `raised_by_email` is NOT NULL and is the only "who asked" column on this table, so a
-- WhatsApp ticket has to put its E.164 phone number there. That is stated on the column
-- rather than worked around, because the two alternatives are worse: a placeholder address
-- would be a value that looks like an email and reaches nobody (AGENTS.md §2 — a failure
-- converted into a plausible value), and a second identity column would leave every existing
-- reader (the Support screen, the portal, api/support/tickets) looking at the wrong one.
comment on column public.support_tickets.raised_by_email is
  'How to reach whoever raised this. An email address when channel is email/portal/app, and '
  'an E.164 phone number when channel is ''whatsapp'' — the column is NOT NULL and is the only '
  'contact field, so read it together with `channel` rather than assuming it parses as mail.';

-- ── 3. Escalation: the flag, the reason, and when ──────────────────────────
alter table public.support_tickets
  add column if not exists ai_escalated boolean not null default false;

alter table public.support_tickets
  add column if not exists ai_escalation_reason text;

alter table public.support_tickets
  add column if not exists ai_escalated_at timestamptz;

comment on column public.support_tickets.ai_escalated is
  'The AI support agent stopped and asked for a person: the issue looked like an outage, or '
  'its own confidence was too low to answer a customer unattended. Set by '
  'lib/ai/actions/support-dispatcher.ts. Cleared when a human is assigned.';

comment on column public.support_tickets.ai_escalation_reason is
  'One sentence a non-engineer can act on — "the customer reports mail has been down for '
  'the whole office since 09:00", not "severity CRITICAL". This is what the support rep '
  'reads, so it must name the problem, not the rule that fired.';

-- ── 4. Assignment, so "nobody has picked this up" is answerable ────────────
-- There was no assignee column at all, which meant the brief's "alert if an escalated ticket
-- is unassigned for 30 minutes" could not be evaluated: every ticket was unassigned forever.
alter table public.support_tickets
  add column if not exists assigned_agent uuid references auth.users(id) on delete set null;

alter table public.support_tickets
  add column if not exists assigned_at timestamptz;

comment on column public.support_tickets.assigned_agent is
  'The human support engineer who owns this ticket. NULL means nobody has taken it — which '
  'is what api/cron/ai-support-sla alerts on once an escalated ticket has waited too long.';

-- ── 5. The two clocks the SLA cron reads ───────────────────────────────────
-- Separate columns rather than one, because they answer different questions and the answers
-- diverge: `ai_answered_at` moves every time the agent speaks, `ai_awaiting_reply_since` is
-- set once when the ball goes back to the customer and is CLEARED when they write. Deriving
-- either from `updated_at` would tie the auto-close clock to any edit anybody makes.
alter table public.support_tickets
  add column if not exists ai_answered_at timestamptz;

alter table public.support_tickets
  add column if not exists ai_awaiting_reply_since timestamptz;

comment on column public.support_tickets.ai_awaiting_reply_since is
  'When the agent last put the ball in the customer''s court — a resolution they have not '
  'acknowledged, or a request for more information. Cleared the moment they write back. '
  'api/cron/ai-support-sla closes a ticket that has sat here for 48 hours.';

-- Stamped when the breach alert actually went, so a ticket that stays unassigned for a day
-- is alerted ONCE. An alarm that repeats every sweep is an alarm people filter out — AGENTS.md
-- L37, and the reason the dunning ladder records what it sent rather than recomputing it.
alter table public.support_tickets
  add column if not exists sla_alert_sent_at timestamptz;

-- ── 6. The transcript ──────────────────────────────────────────────────────
-- A separate table from `support_tickets.body` for the same reason `ai_sales_conversations` is
-- separate from `lead_activities`: the ticket row is what a PERSON reads — one subject, one
-- body, one resolution note. A conversation needs what it has no room for (who spoke, on which
-- channel, the model's read of the issue and its confidence) and it needs to be queried as an
-- ordered transcript to build the next prompt. Storing prompt-sized history on the ticket
-- would drown the thing the operator actually looks at.
create table if not exists public.ai_support_conversations (
  id                uuid        primary key default gen_random_uuid(),
  tenant_id         uuid        not null references public.tenants(id) on delete cascade,
  -- TEXT, matching support_tickets.id ('TKT-…'). Nullable: the first message can arrive
  -- before the ticket insert succeeds, and losing the customer's words to protect a link
  -- would be the wrong trade.
  ticket_id         text,
  channel           text        not null check (channel in ('email', 'whatsapp', 'portal', 'app')),
  -- The customer's address on that channel — an email or an E.164 phone number. Kept on the
  -- row rather than resolved through the ticket, because a thread must stay findable when the
  -- ticket link is missing, and because WhatsApp arrives with a number and nothing else.
  customer_contact  text        not null,
  role              text        not null check (role in ('user', 'agent', 'system')),
  message_content   text        not null,
  -- The agent's read of THIS message. `intent` is the KB topic it matched (dns_records,
  -- workspace_admin, …) which is FINER than support_tickets.category — that column is a
  -- five-value closed vocabulary the dashboard filters on, and flattening the agent's read
  -- into it would lose the only field that says which runbook was used.
  intent            text,
  -- What the agent decided to do about it, in its own vocabulary:
  -- resolved | more_info_needed | escalated | none. Not a status — the TICKET has the status;
  -- this is what happened on this TURN.
  resolution_status text        check (resolution_status is null or resolution_status in
                                       ('resolved', 'more_info_needed', 'escalated', 'none')),
  -- 0..1. numeric, not float: a confidence that logs as 0.7500000001 invites an argument
  -- about the threshold instead of about the decision.
  confidence_score  numeric(4,3) check (confidence_score is null
                                        or (confidence_score >= 0 and confidence_score <= 1)),
  created_at        timestamptz not null default now(),

  -- Tenant-safe link (CLAUDE.md §4). A plain `ticket_id references support_tickets(id)` would
  -- happily let tenant A's transcript point at tenant B's ticket, and RLS would not catch it
  -- because the row's own tenant_id looks correct.
  --
  -- `SET NULL (ticket_id)` — THE COLUMN LIST IS NOT OPTIONAL. On a COMPOSITE foreign key
  -- Postgres sets EVERY referencing column, so the bare `on delete set null` would try to
  -- null `tenant_id` too, which is NOT NULL. The failure does not appear now; it appears the
  -- first time somebody deletes a ticket that has a transcript, and it appears as the DELETE
  -- being refused. Requires PG 15+; this database is 17.6 (checked, not assumed).
  --
  -- SET NULL rather than CASCADE: a deleted ticket does not make what we said to a real
  -- customer meaningless, and `customer_contact` keeps the thread readable and answerable.
  constraint ai_support_conversations_ticket_fk
    foreign key (tenant_id, ticket_id)
    references public.support_tickets (tenant_id, id)
    on delete set null (ticket_id)
);

comment on table public.ai_support_conversations is
  'What the customer and the AI support agent actually said to each other, in order, across '
  'email and WhatsApp. Read to build the next prompt so the agent does not ask the customer '
  'to run the same DNS check twice. The human-readable record stays on support_tickets.';

-- The prompt builder's query: this thread, oldest first.
create index if not exists ai_support_conv_thread_idx
  on public.ai_support_conversations (tenant_id, ticket_id, created_at);

-- The pre-ticket query: this contact on this channel, before a ticket_id exists.
create index if not exists ai_support_conv_contact_idx
  on public.ai_support_conversations (tenant_id, channel, customer_contact, created_at desc);

-- ── 7. The two queries the SLA cron makes, and nothing else ────────────────
-- Partial indexes, because both sweeps must not have to walk the resolved history. The
-- dashboard's own filters are served by the table's existing indexes.
create index if not exists support_tickets_awaiting_reply_idx
  on public.support_tickets (ai_awaiting_reply_since)
  where ai_awaiting_reply_since is not null;

create index if not exists support_tickets_escalated_unassigned_idx
  on public.support_tickets (ai_escalated_at)
  where ai_escalated and assigned_agent is null;

-- ── 8. RLS — every table, no exceptions (CLAUDE.md §4) ─────────────────────
alter table public.ai_support_conversations enable row level security;

-- Read: anyone in the tenant. The support rep working the ticket is exactly who needs to see
-- what the agent already told the customer — a transcript only the owner can read is a
-- transcript nobody reads.
drop policy if exists ai_support_conversations_select on public.ai_support_conversations;
create policy ai_support_conversations_select on public.ai_support_conversations
  for select using (tenant_id = public.current_tenant_id());

-- Writes belong to the service role only. This table is written by webhooks and a cron,
-- neither of which is a logged-in user, and an invented transcript row would become context
-- the agent believes on the next turn.
drop policy if exists ai_support_conversations_service on public.ai_support_conversations;
create policy ai_support_conversations_service on public.ai_support_conversations
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

commit;
