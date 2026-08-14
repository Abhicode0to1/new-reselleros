-- ============================================================================
-- 0246 — route inbound email by WHO IT WAS SENT TO
-- ============================================================================
--
-- ─── WHAT WAS MISSING ───────────────────────────────────────────────────────
-- The inbound pipeline (webhooks/inbound-email) is solid: secret-guarded,
-- idempotent on message_id, Gemini extraction with a stub fallback, lead dedup.
-- It has one blind spot — it never recorded, or looked at, the address the mail
-- was sent TO. So every message became a Lead. `support@` could not open a
-- ticket and `billing@` could not reach a bill, because by the time the handler
-- ran the recipient was already gone.
--
-- Three columns, and the pipeline can branch:
--
--   to_email   the recipient the routing decision is made from
--   route      what was decided — kept even when nothing was created, because
--              "we ignored this on purpose" and "we never saw it" look identical
--              in a table that only stores successes
--   ticket_id  the support twin of the existing lead_id
--
-- ─── WHY `route` IS NOT DERIVED ON READ ─────────────────────────────────────
-- The mapping from address to route lives in code and will change — a new alias,
-- a renamed inbox. Recomputing an old row's route from today's rules would
-- rewrite history and make an incident impossible to reconstruct. What was
-- decided at the time is a fact; store it.
--
-- to_email is nullable and route defaults to 'unknown' so the rows already in
-- this table stay valid — they predate the recipient being captured, and
-- pretending to know where they were addressed would be inventing data.
--
-- ─── HOW TO RUN (CLAUDE.md §25.6) ──────────────────────────────────────────
-- One batch; verify separately.
-- ============================================================================

begin;

alter table public.inbound_emails
  add column if not exists to_email  text,
  add column if not exists route     text not null default 'unknown',
  add column if not exists ticket_id text references public.support_tickets(id) on delete set null;

-- Named, because a stray value here means mail is being silently misfiled.
alter table public.inbound_emails drop constraint if exists inbound_emails_route_check;
alter table public.inbound_emails
  add constraint inbound_emails_route_check
  check (route in ('sales', 'support', 'billing', 'ignored', 'unknown'));

comment on column public.inbound_emails.to_email is
  'The address the message was sent to. Routing keys on this; it is why support@ and billing@ can behave differently from sales@.';
comment on column public.inbound_emails.route is
  'What the router decided AT THE TIME. Never recomputed on read — the address→route mapping changes, and rewriting an old row''s route would make an incident impossible to reconstruct.';
comment on column public.inbound_emails.ticket_id is
  'Support ticket opened from this message. The twin of lead_id for the support route.';

create index if not exists idx_inbound_emails_route
  on public.inbound_emails (tenant_id, route, created_at desc);

commit;


-- ============================================================================
-- VERIFY — RUN THIS AS A SEPARATE EDITOR RUN
--
-- Expect: 3 new columns · the check constraint present · existing rows 'unknown'
-- ============================================================================
/*
select 'new columns (expect 3)' as check, count(*)::text as v
  from information_schema.columns
 where table_schema='public' and table_name='inbound_emails'
   and column_name in ('to_email','route','ticket_id')
union all
select 'route check constraint', count(*)::text
  from pg_constraint where conname = 'inbound_emails_route_check'
union all
select 'rows by route', coalesce(string_agg(route || '=' || n, ', '), '(no rows)')
  from (select route, count(*)::text n from public.inbound_emails group by route) s;
*/
