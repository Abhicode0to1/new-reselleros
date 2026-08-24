-- ═══════════════════════════════════════════════════════════════════════════
-- AI Sales Agent — conversation memory, follow-up loops, and the handover flag
--
-- WHAT THIS ADDS THAT DID NOT EXIST (checked before writing, 24 Aug 2026)
-- ------------------------------------------------------------------------
-- The inbound pipeline already captures an enquiry, creates a lead, drafts a quote and can
-- draft a reply (api/webhooks/inbound-email → lib/quotes/auto-quote-for-lead →
-- lib/ai/run-auto-reply). Three things it cannot do, and they are what this migration is for:
--
--   1. REMEMBER THE CONVERSATION. Every AI call today sees one message. A salesperson who
--      forgot the previous email would not be trusted with a customer, and the failure is
--      not cosmetic: the second reply re-asks what the customer already answered, so the
--      agent reads as a bot on turn two and the lead goes cold.
--   2. COME BACK LATER. There is no place to write "chase this on Thursday". The five
--      existing crons all iterate over rows that mean something else (subscriptions,
--      invoices), so a follow-up had nowhere to live but a person's memory.
--   3. SAY "I SHOULD NOT DO THIS ONE." A big deal or a low-confidence read must stop and
--      fetch a human. Without a flag on the lead, "stop" can only mean "do nothing", which
--      is indistinguishable from the agent being switched off.
--
-- WHY A NEW TABLE FOR MESSAGES AND NOT lead_activities
-- ------------------------------------------------------------------------
-- Checked first, because a second log overlapping the first is worse than no log.
-- lead_activities is the TIMELINE A PERSON READS: (kind, detail) free text, one row per
-- notable event, and the app already writes notes there. A conversation needs the things it
-- has no room for — which channel, who spoke, the model's intent/sentiment read, and the
-- confidence behind it — and it needs to be queried as an ordered transcript to build the
-- next prompt. Storing prompts-worth of transcript in the human timeline would drown the
-- thing the operator actually looks at. So: transcript here, notable events there.
--
-- COMPOSITE FOREIGN KEYS, AND THE CONSTRAINT THIS HAS TO ADD FIRST
-- ------------------------------------------------------------------------
-- CLAUDE.md §4: "Foreign keys MUST stay within tenant boundaries." A plain
-- `lead_id references leads(id)` cannot enforce that — it would happily let tenant A's
-- conversation point at tenant B's lead, and RLS would not catch it because the row's own
-- tenant_id looks correct. The composite FK `(tenant_id, lead_id) → leads(tenant_id, id)`
-- makes the crossing impossible in the database.
--
-- That target needs a unique key, and `leads` had only `PRIMARY KEY (id)` — measured, not
-- assumed. So this adds `unique (tenant_id, id)` to leads. It is additive and cannot fail on
-- existing data: id is already unique on its own, so any pair containing it is too.
--
-- NOTE ON lead_id's TYPE: it is TEXT, not uuid. `leads.id` is a human-readable text id in
-- this schema (e.g. 'L-0007'), not a uuid. A uuid column here would have been unlinkable.
--
-- BEHAVIOUR IS UNCHANGED BY THIS MIGRATION
-- ------------------------------------------------------------------------
-- Both tables start empty, requires_human_attention defaults FALSE, and the two new autonomy
-- actions declare themselves `hold` in lib/ai/autonomy.ts — so nothing sends until somebody
-- moves the dial. Same discipline as the autonomy migration that preceded this one: adding
-- the capability must not be the same event as switching it on.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. The key the composite FKs below need ────────────────────────────────
-- Additive. `id` is already the primary key, so (tenant_id, id) is unique for free and this
-- cannot conflict with any existing row.
alter table public.leads
  drop constraint if exists leads_tenant_id_key;
alter table public.leads
  add constraint leads_tenant_id_key unique (tenant_id, id);

-- ── 2. The handover flag ───────────────────────────────────────────────────
-- On the lead, because "a person needs to take this over" is a fact about the deal, and the
-- pipeline screens already read the lead. A separate table would mean every lead list needs
-- a join to know whether it is waiting on someone.
alter table public.leads
  add column if not exists requires_human_attention boolean not null default false;

alter table public.leads
  add column if not exists human_attention_reason text;

alter table public.leads
  add column if not exists human_attention_at timestamptz;

comment on column public.leads.requires_human_attention is
  'The AI sales agent stopped and asked for a person: the deal is large, or its own '
  'confidence was too low to answer a customer unattended. Set by lib/ai/actions/'
  'quote-dispatcher.ts. Cleared by a human taking the lead on.';

comment on column public.leads.human_attention_reason is
  'One sentence a non-engineer can act on — "38 seats is above the 50-seat auto-quote '
  'ceiling", not "threshold exceeded". The operator sees this, not a code.';

-- Partial index: the only query anyone makes of this is "what is waiting on me".
create index if not exists leads_human_attention_idx
  on public.leads (tenant_id, human_attention_at desc)
  where requires_human_attention;

-- ── 3. The conversation transcript ─────────────────────────────────────────
create table if not exists public.ai_sales_conversations (
  id               uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null references public.tenants(id) on delete cascade,
  -- TEXT, matching leads.id. Nullable: the first inbound message can arrive before we have
  -- decided it is a lead at all, and losing the message to protect the link would be the
  -- wrong trade.
  lead_id          text,
  channel          text        not null check (channel in ('email', 'whatsapp')),
  -- The customer's address on that channel — an email or an E.164 phone number. Kept on the
  -- row rather than resolved through the lead, because a thread can start before a lead
  -- exists and must still be findable.
  customer_contact text        not null,
  role             text        not null check (role in ('user', 'agent', 'system')),
  content          text        not null,
  -- The model's read of THIS message. Null on 'user' rows we have not analysed yet and on
  -- 'system' rows, which are notes to ourselves rather than anybody's opinion.
  intent           text,
  sentiment        text,
  -- 0..1. numeric, not float: a confidence that reads 0.7000000001 in a log invites an
  -- argument about the threshold instead of about the decision.
  confidence_score numeric(4,3) check (confidence_score is null
                                       or (confidence_score >= 0 and confidence_score <= 1)),
  created_at       timestamptz not null default now(),

  -- Tenant-safe link. See the header: this is what makes a cross-tenant lead_id impossible
  -- rather than merely unlikely.
  --
  -- `SET NULL (lead_id)` — THE COLUMN LIST IS NOT OPTIONAL, and a bare `on delete set null`
  -- here is a live bug rather than a style choice. On a COMPOSITE foreign key Postgres sets
  -- EVERY referencing column, so the bare form would try to null `tenant_id` too — which is
  -- NOT NULL. The failure does not appear now; it appears the first time somebody deletes a
  -- lead that has a transcript, and it appears as the DELETE being refused outright.
  -- Requires PG 15+; this database is 17.6 (checked, not assumed).
  --
  -- SET NULL rather than CASCADE, unlike ai_sales_loops below. A scheduled follow-up for a
  -- deleted lead is meaningless and should go. A record of what this app said to a real
  -- customer is not meaningless — `customer_contact` is still on the row, so the conversation
  -- stays readable and answerable after the lead itself is gone.
  constraint ai_sales_conversations_lead_fk
    foreign key (tenant_id, lead_id)
    references public.leads (tenant_id, id)
    on delete set null (lead_id)
);

comment on table public.ai_sales_conversations is
  'What the customer and the AI sales agent actually said to each other, in order, across '
  'email and WhatsApp. Read to build the next prompt so the agent does not re-ask what has '
  'already been answered. The human-readable timeline stays in lead_activities.';

-- The prompt builder''s query: this thread, oldest first.
create index if not exists ai_sales_conv_thread_idx
  on public.ai_sales_conversations (tenant_id, lead_id, created_at);

-- The pre-lead query: this contact on this channel, before a lead_id exists.
create index if not exists ai_sales_conv_contact_idx
  on public.ai_sales_conversations (tenant_id, channel, customer_contact, created_at desc);

-- ── 4. The follow-up loops ─────────────────────────────────────────────────
create table if not exists public.ai_sales_loops (
  id                uuid        primary key default gen_random_uuid(),
  tenant_id         uuid        not null references public.tenants(id) on delete cascade,
  lead_id           text        not null,
  scheduled_at      timestamptz not null,
  status            text        not null default 'pending'
                                check (status in ('pending', 'processed', 'cancelled')),
  -- WHY this follow-up was scheduled, in the agent's own words: "quote sent, no reply
  -- expected before Thursday". The cron puts this in the prompt, so a follow-up can refer to
  -- what it is following up ON instead of saying "just checking in".
  trigger_condition text        not null,
  -- Stamped when the cron acts on the row. Separate from status so "processed at 09:00" and
  -- "cancelled because the customer replied" are distinguishable after the fact.
  processed_at      timestamptz,
  created_at        timestamptz not null default now(),

  constraint ai_sales_loops_lead_fk
    foreign key (tenant_id, lead_id)
    references public.leads (tenant_id, id)
    on delete cascade
);

comment on table public.ai_sales_loops is
  'Scheduled "come back to this lead" rows for the AI sales agent, drained by '
  'api/cron/ai-sales-loop. A customer reply cancels the pending row rather than leaving it '
  'to fire — an automated nudge arriving after the customer has already answered is the '
  'fastest way to look like a robot.';

-- The cron''s only query: what is due, oldest first. Partial, because processed and
-- cancelled rows are history and the due-list must not have to walk them.
create index if not exists ai_sales_loops_due_idx
  on public.ai_sales_loops (scheduled_at)
  where status = 'pending';

-- The cancel-on-reply query: this lead's pending rows.
create index if not exists ai_sales_loops_lead_pending_idx
  on public.ai_sales_loops (tenant_id, lead_id)
  where status = 'pending';

-- At most one pending nudge per lead. Without this, two inbound messages in a minute
-- schedule two follow-ups and the customer gets nudged twice for one silence.
create unique index if not exists ai_sales_loops_one_pending_per_lead
  on public.ai_sales_loops (tenant_id, lead_id)
  where status = 'pending';

-- ── 5. RLS — every table, no exceptions (CLAUDE.md §4) ─────────────────────
alter table public.ai_sales_conversations enable row level security;
alter table public.ai_sales_loops         enable row level security;

-- Read: anyone in the tenant. This is the tenant's own record of its own conversations, and
-- a transcript only the owner can read is a transcript nobody reads — the sales user working
-- the lead is exactly who needs to see what the agent already said.
drop policy if exists ai_sales_conversations_select on public.ai_sales_conversations;
create policy ai_sales_conversations_select on public.ai_sales_conversations
  for select using (tenant_id = public.current_tenant_id());

drop policy if exists ai_sales_loops_select on public.ai_sales_loops;
create policy ai_sales_loops_select on public.ai_sales_loops
  for select using (tenant_id = public.current_tenant_id());

-- Cancel a scheduled nudge: anyone in the tenant. "Stop emailing my customer" must not need
-- the owner to be awake. Deliberately UPDATE-only — a user may cancel a loop, not invent one.
drop policy if exists ai_sales_loops_cancel on public.ai_sales_loops;
create policy ai_sales_loops_cancel on public.ai_sales_loops
  for update using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- Writes belong to the service role only. Both tables are written by webhooks and a cron,
-- neither of which is a logged-in user, and neither table is something a person should be
-- able to forge: an invented transcript row would become context the agent believes, and an
-- invented loop row would send mail on the tenant's behalf.
drop policy if exists ai_sales_conversations_service on public.ai_sales_conversations;
create policy ai_sales_conversations_service on public.ai_sales_conversations
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists ai_sales_loops_service on public.ai_sales_loops;
create policy ai_sales_loops_service on public.ai_sales_loops
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

commit;
