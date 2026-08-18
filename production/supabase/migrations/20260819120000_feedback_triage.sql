-- 20260819120000_feedback_triage
--
-- User feedback gets its own table, and a place to put a machine triage of it.
--
-- ─── WHY NOT support_tickets, WHICH IS WHERE THIS WAS GOING ─────────────────
-- `components/shared/feedback-dialog.tsx` filed every internal bug report as a
-- `support_tickets` row. Measured on prod before writing this: support_tickets holds
-- 4 rows and ALL 4 of them are internal feedback. The table meant for "a CUSTOMER has
-- a problem" currently contains only "a TEAMMATE found a bug", which means the SLA
-- clock (20260817170000), the tier allowance, the customer-facing reply path and the
-- support dashboard are all counting the wrong thing. Separating them is not tidiness;
-- it stops an internal bug report from being answered as if a paying customer raised it.
--
-- ─── THE SCREENSHOT PROBLEM, MEASURED ───────────────────────────────────────
-- The dialog serialised each screenshot as a base64 data: URL and concatenated it into
-- `support_tickets.body`. The largest body on prod is 214,531 characters — one PNG. A
-- text column is not a file store: every list query that selects body drags a quarter of
-- a megabyte per row across the wire, and Postgres TOASTs it rather than storing a file
-- cheaply. Screenshots move to Supabase Storage and the row keeps a path.
--
-- ─── NO NEW BUCKET, DELIBERATELY ────────────────────────────────────────────
-- Files go to the EXISTING `documents` bucket under `<tenant_id>/feedback/<id>/…`.
-- That bucket already carries the four tenant policies this needs
-- (documents_select/insert/update/delete_own_tenant, all keyed on
-- `(storage.foldername(name))[1] = current_tenant_id()::text`), already limits uploads
-- to 20 MB, and already allows image/png + image/jpeg + image/webp. A new bucket would
-- mean four more policies saying exactly the same sentence, and a fifth place for that
-- sentence to be got wrong later. Nothing surfaces in the Documents vault UI, because
-- that screen lists rows of the `documents` TABLE and these files have no such row.
--
-- ─── THE TRIAGE COLUMNS ARE DERIVED, AND THAT IS WHY THEY ARE STORED ────────
-- Everything under "triage output" can be recomputed from the report text by
-- lib/feedback/triage.ts. It is persisted anyway for one reason: the AI half of the
-- engine is non-deterministic, so a directive an operator READ and a directive
-- recomputed later are not guaranteed to be the same text. If the operator dispatched
-- a directive to an agent, the exact words that were dispatched have to still exist.
-- `triage_mode` records which half produced it so that is never a guess.
--
-- ─── NO MONEY HERE ──────────────────────────────────────────────────────────
-- This feature stores no amount, so the whole-rupees rule has nothing to bind to.
-- Recorded explicitly so nobody later adds a "cost to fix" column in paise.

begin;

create table if not exists public.feedback (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,

  -- ─── what the reporter said ───────────────────────────────────────────────
  /* What the reporter PICKED. Kept separate from inferred_type below because on the
     4 real reports the picker was wrong half the time — see inferred_type. */
  reported_type     text not null default 'bug'
                    check (reported_type in ('bug', 'feature', 'ui_improvement')),
  reported_severity text not null default 'medium'
                    check (reported_severity in ('low', 'medium', 'high', 'critical')),

  title         text not null,
  body          text not null,

  /* The URL as captured, dynamic segments and all: "/quotes/Q-ADPL-2026-27-0002". */
  page_path     text,
  /* The same path collapsed to its Next.js route: "/quotes/[id]". Stored rather than
     derived on read so the admin list can GROUP BY it — "which screen generates the
     most reports" is unanswerable while every row carries a different quote number. */
  route_pattern text,

  reported_by    uuid references public.users(id) on delete set null,
  reporter_name  text,
  reporter_email text,

  -- ─── triage output ────────────────────────────────────────────────────────
  triage_status text not null default 'pending'
                check (triage_status in ('pending', 'triaged', 'failed')),
  /* 'gemini' or 'stub'. Which engine wrote the directive below. An operator reading a
     weak directive must be able to tell "the model is poor" from "no key is set". */
  triage_mode   text check (triage_mode in ('gemini', 'stub')),
  triaged_at    timestamptz,

  problem_summary text,
  /* What the TEXT says it is, regardless of what the reporter picked. On the 4 reports
     that existed when this was written, all 4 were filed as 'bug' and 2 were plainly
     feature requests ("Allow the user to see his attendance History with Selfies",
     "…popup mil jaye jisse wo attendance miss na kare"). Trusting the picker would put
     both into a bug queue and age them as defects. */
  inferred_type text check (inferred_type in ('bug', 'feature', 'ui_improvement')),
  /* 0..100. A number, not a label, because the queue is sorted by it. */
  severity_score int check (severity_score between 0 and 100),

  /* Repo-relative source paths the fix most likely touches. text[] and not a child
     table: these are guesses about files, not entities anything can reference. */
  target_files  text[] not null default '{}',

  /* The step-by-step prompt an operator hands to a coding agent. */
  directive     text,

  /* Why the triage decided what it decided, one reason per element. An array and not a
     string for the reason channel-economics.ts already records: when a report trips two
     conditions at once, a single string shows one of them and silently drops the other. */
  triage_notes  text[] not null default '{}',

  -- ─── workflow ─────────────────────────────────────────────────────────────
  status text not null default 'open'
         check (status in ('open', 'agent_queued', 'fixed', 'wont_fix', 'duplicate')),
  /* Set when an operator pressed Run AI Auto-Fix. This records that a directive was
     HANDED OUT — not that any code changed. Nothing in this app can edit the repo. */
  dispatched_at timestamptz,
  dispatched_by uuid references public.users(id) on delete set null,

  resolved_at     timestamptz,
  resolution_note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.feedback is
  'Internal bug reports / feature requests from the team, plus a machine triage of each. Deliberately NOT support_tickets: that table is for a paying customer''s problem and carries an SLA clock and a tier allowance, neither of which should ever start ticking because a teammate found a layout bug.';
comment on column public.feedback.reported_type is
  'What the reporter picked in the dialog. Compare with inferred_type before believing it — measured on the first 4 real reports, the picker said "bug" 4 times and the text said "feature" twice.';
comment on column public.feedback.route_pattern is
  'page_path collapsed to its Next.js route, e.g. /quotes/Q-ADPL-2026-27-0002 -> /quotes/[id]. Stored so reports can be grouped per screen; raw paths never group.';
comment on column public.feedback.severity_score is
  '0..100, computed by lib/feedback/triage.ts. Feature requests are capped below the bug floor on purpose: a nice-to-have must never sort above a money bug just because someone ticked Critical.';
comment on column public.feedback.triage_mode is
  '"gemini" when a key was configured and the model answered, "stub" when the deterministic engine produced it. Without this an operator cannot tell a bad model from an absent one.';
comment on column public.feedback.dispatched_at is
  'When an operator handed the directive to an agent. NOT evidence that anything was fixed — this app runs on Cloud Run and cannot touch the repository.';

/* The admin queue: this tenant's open reports, worst first. */
create index if not exists feedback_queue_idx
  on public.feedback (tenant_id, severity_score desc nulls last, created_at desc);

/* "Which screen generates the most reports" — partial, since a null route is unusable
   for grouping and should not sit in the index. */
create index if not exists feedback_route_idx
  on public.feedback (tenant_id, route_pattern)
  where route_pattern is not null;

/* The worker/queue read: what still needs a triage. */
create index if not exists feedback_untriaged_idx
  on public.feedback (tenant_id, created_at)
  where triage_status = 'pending';

create table if not exists public.feedback_screenshots (
  id          uuid primary key default gen_random_uuid(),
  feedback_id uuid not null references public.feedback(id) on delete cascade,
  /* Denormalised from the parent so RLS on this table is one comparison and does not
     have to join back to feedback on every row. */
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  /* Path inside the EXISTING `documents` bucket: <tenant_id>/feedback/<feedback_id>/<file>.
     The leading tenant segment is what the bucket's policies match on — a path built any
     other way is refused by storage, not by us. */
  file_path   text not null,
  file_name   text,
  byte_size   integer check (byte_size is null or byte_size >= 0),
  created_at  timestamptz not null default now()
);

comment on table public.feedback_screenshots is
  'One row per attached screenshot. Files live in the `documents` bucket under <tenant_id>/feedback/<feedback_id>/. Replaces base64 data: URLs concatenated into a text body — the largest such body on prod was 214,531 characters for a single PNG.';
comment on column public.feedback_screenshots.file_path is
  'Must start with the tenant id. storage.objects policies on the documents bucket match (storage.foldername(name))[1] against current_tenant_id(); any other shape is rejected at upload.';

create index if not exists feedback_screenshots_parent_idx
  on public.feedback_screenshots (feedback_id, created_at);

-- ─── RLS ────────────────────────────────────────────────────────────────────
-- Tenant isolation only. There is deliberately no "you may only see your own reports"
-- rule: a bug report is not private to its reporter, and the whole point of the admin
-- queue is that somebody else reads it. WHO may open /admin/feedback is a route
-- question, answered by nav.ts + middleware; this layer answers WHICH TENANT.

alter table public.feedback enable row level security;
alter table public.feedback_screenshots enable row level security;

drop policy if exists feedback_select on public.feedback;
create policy feedback_select on public.feedback
  for select using (tenant_id = current_tenant_id());

/* Anyone signed in may file a report, and only into their own tenant. with_check pins
   the tenant so a hand-crafted insert cannot file into somebody else's books — the
   exact bug this dialog already had once, when it defaulted tenant_id to Anutech's. */
drop policy if exists feedback_insert on public.feedback;
create policy feedback_insert on public.feedback
  for insert with check (tenant_id = current_tenant_id());

/* Triage results and workflow status are written back onto the row. */
drop policy if exists feedback_update on public.feedback;
create policy feedback_update on public.feedback
  for update
  using      (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

/* No delete policy. A report is closed with status wont_fix or duplicate, never
   removed — a deleted report is a complaint that silently stops existing, and the
   reporter has no way to tell that from being ignored. */

drop policy if exists feedback_screenshots_select on public.feedback_screenshots;
create policy feedback_screenshots_select on public.feedback_screenshots
  for select using (tenant_id = current_tenant_id());

drop policy if exists feedback_screenshots_insert on public.feedback_screenshots;
create policy feedback_screenshots_insert on public.feedback_screenshots
  for insert with check (tenant_id = current_tenant_id());

/* Removing an attachment is allowed — a reporter may paste the wrong screen, and a
   wrong screenshot on a bug report actively misleads whoever picks it up. */
drop policy if exists feedback_screenshots_delete on public.feedback_screenshots;
create policy feedback_screenshots_delete on public.feedback_screenshots
  for delete using (tenant_id = current_tenant_id());

commit;

-- ─── VERIFY (run separately; not part of the transaction above) ──────────────
-- select count(*) = 2 as tables_ok
--   from information_schema.tables
--  where table_schema = 'public' and table_name in ('feedback', 'feedback_screenshots');
--
-- select count(*) = 6 as policies_ok
--   from pg_policies
--  where schemaname = 'public' and tablename in ('feedback', 'feedback_screenshots');
--
-- select count(*) = 4 as indexes_ok
--   from pg_indexes
--  where schemaname = 'public'
--    and indexname in ('feedback_queue_idx', 'feedback_route_idx',
--                      'feedback_untriaged_idx', 'feedback_screenshots_parent_idx');
