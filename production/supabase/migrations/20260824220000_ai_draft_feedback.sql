-- ═══════════════════════════════════════════════════════════════════════════
-- What the person changed before sending the AI's draft
--
-- WHY THIS TABLE EXISTS
-- ------------------------------------------------------------------------
-- Asked on 24 Aug 2026: "does the AI sales agent do self-learning?" It does not. It
-- remembers a conversation and it reads the live catalogue; nothing about a won deal, a lost
-- deal, or a reply somebody rewrote ever reaches it.
--
-- Every improvement the agent has had came from a human reading what it wrote. Nine prompt
-- rules landed that same day, each traced to one real sentence in one real draft — it signed
-- off as "ResellerOS", it never asked monthly-or-annual, it recited all four selling points
-- every time. That loop works, and it does not scale, because it runs on somebody
-- remembering an anecdote.
--
-- This is the anecdote written down. When a rep sends a draft the agent produced, the pair is
-- kept: what the agent wrote, what actually went out, and how far apart they were. After a
-- hundred sends that is a ranked list of the places the agent is reliably wrong.
--
-- WHAT IT IS NOT
-- ------------------------------------------------------------------------
-- Not training data in the fine-tuning sense, and it must not be described as such anywhere.
-- Nothing here changes a model weight. It changes what the next person editing the prompt
-- knows, which is the only mechanism this system actually has.
--
-- WHY BOTH FULL TEXTS ARE STORED, WHEN THE DIFF IS ALSO STORED
-- ------------------------------------------------------------------------
-- Because a summary answers only the questions you thought of. `verdict` and `similarity`
-- make the table countable — "how often was it good enough" is one query — but the useful
-- afternoon is reading twenty rewrites side by side and noticing what they have in common.
-- That cannot be reconstructed from a similarity score, and the draft is not recoverable from
-- anywhere else: it lives in a `lead_activities` note as prose, and the sent version lives in
-- `inbound_emails`, and nothing joins them.
--
-- The duplication is deliberate and bounded: only sends that STARTED from an AI draft get a
-- row. A rep writing from scratch produces nothing here, which is correct — there is no draft
-- to have an opinion about.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create table if not exists public.ai_draft_feedback (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references public.tenants(id) on delete cascade,

  -- Which dial's draft this was: reply.send, followup.send, support.reply.send. TEXT and not
  -- validated against AI_ACTIONS, for the same reason `ai_autonomy.action` is not — a new
  -- action must be able to ship without a migration, and a row naming one this build does
  -- not know about is simply never asked for.
  action        text        not null,

  -- What the draft was ABOUT. `entity` is 'lead' or 'support_ticket'; `entity_id` is TEXT
  -- because both of those ids are human-readable text in this schema ('L-0007', 'TKT-…'),
  -- not uuids. Deliberately NOT a foreign key: this row is a record of what a person did,
  -- and it must survive the lead being deleted or merged. A composite FK would either take
  -- the row with it or block the delete, and both lose the lesson.
  entity        text        not null check (entity in ('lead', 'support_ticket')),
  entity_id     text        not null,

  -- The pair. See the header for why both are kept in full.
  draft_subject text,
  draft_body    text        not null,
  sent_subject  text,
  sent_body     text        not null,

  -- The summary, computed by lib/ai/draft-feedback.ts at insert time.
  verdict       text        not null check (verdict in ('sent_unchanged', 'lightly_edited', 'rewritten')),
  -- 0..1. numeric, not float: a similarity that logs as 0.9500000001 invites an argument
  -- about the threshold instead of about the draft. Same call as ai_sales_conversations.
  similarity    numeric(4,3) not null check (similarity >= 0 and similarity <= 1),
  -- The word-level diff, capped at twenty each by the caller. Stored so a reviewer can scan
  -- a page of rows without opening every body.
  words_added   text[]      not null default '{}',
  words_removed text[]      not null default '{}',

  -- WHO sent it. The point of the table is to learn from a person's judgement, and whose
  -- judgement it was is part of the signal: two reps disagreeing about the same draft is a
  -- different finding from one rep always rewriting.
  sent_by       uuid        references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);

comment on table public.ai_draft_feedback is
  'One row per email that STARTED as an AI draft and was then sent by a person: the draft, '
  'what actually went out, and how far apart they were. The agent does not learn from this — '
  'a human reads it and edits the prompt. That is the whole loop, and it is deliberate.';

comment on column public.ai_draft_feedback.verdict is
  'sent_unchanged | lightly_edited | rewritten. The rewrites are the rows worth reading; the '
  'unchanged count is the number that says whether the agent is ready for a wider dial.';

-- The two queries anybody will actually run: "show me the rewrites, newest first" and
-- "how is this action doing over time".
create index if not exists ai_draft_feedback_review_idx
  on public.ai_draft_feedback (tenant_id, verdict, created_at desc);

create index if not exists ai_draft_feedback_action_idx
  on public.ai_draft_feedback (tenant_id, action, created_at desc);

-- ── RLS — every table, no exceptions (CLAUDE.md §4) ────────────────────────
alter table public.ai_draft_feedback enable row level security;

-- Read: anyone in the tenant. This is the workspace's own record of its own drafts, and the
-- rep whose edit is in it is exactly who should be able to see the pattern.
drop policy if exists ai_draft_feedback_select on public.ai_draft_feedback;
create policy ai_draft_feedback_select on public.ai_draft_feedback
  for select using (tenant_id = public.current_tenant_id());

-- Writes belong to the service role. The row is written by the send route immediately after a
-- real send, and a forged row would be a lie about what a colleague did.
drop policy if exists ai_draft_feedback_service on public.ai_draft_feedback;
create policy ai_draft_feedback_service on public.ai_draft_feedback
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

commit;
