-- ============================================================================
-- leads.created_by — WHO ADDED THIS LEAD, which is not the same as whose it is
-- ============================================================================
--
-- `leads` already has `owner_id`: whose lead it is NOW. It answers "who should chase this",
-- and the create form defaults it to the person adding the lead
-- (quick-add-lead-form.tsx: `owner_id: me?.userId`). So on the day a lead is created the two
-- facts coincide — and they separate the moment it is reassigned, at which point WHO ADDED IT
-- is gone and there is nothing in the schema that ever knew.
--
-- Measured on the live table before writing this (25 Aug 2026):
--
--   leads .................................. 29
--   with owner_id .......................... 14
--   source = 'manual' ...................... 12   (all 12 have an owner)
--   source = 'email-inbound' ............... 15   (NONE has an owner)
--   source = 'tele-calling' / 'whatsapp' .... 1 / 1
--
-- ─── NULL IS AN ANSWER HERE, NOT A GAP ──────────────────────────────────────
-- Fifteen of twenty-nine leads were created by the inbound email webhook. No person added
-- them, so `created_by` is correctly NULL and `source` says what did. The UI reads the pair:
-- a name when a colleague added it, "arrived by email" when nothing did. A blank would be the
-- one wrong answer.
--
-- ─── NOT BACKFILLED, DELIBERATELY ───────────────────────────────────────────
-- Two backfills look available and both are wrong:
--
--   1. FROM THE FIRST lead_activities ROW. Of the 24 leads with any activity, the first one is
--      `email_in` on 15 and only 9 carry a `created_by` at all. So this would credit
--      customer-created leads to whichever colleague happened to touch them first.
--
--   2. FROM owner_id ON THE 12 MANUAL LEADS. At creation the owner WAS the creator — but
--      nothing records whether any of those twelve has been reassigned since, and `owner_id`
--      has no audit trail. A confidently wrong creator name is worse than an honest blank:
--      nobody checks a name that looks plausible.
--
-- So existing rows stay NULL and the column starts telling the truth from the next lead on.
--
-- ─── SHAPE MATCHES ITS SIBLING, ON PURPOSE ──────────────────────────────────
-- `leads_owner_id_fkey` is a SIMPLE fk to `users(id)` with ON DELETE SET NULL. This column sits
-- beside it and does the same, rather than introducing a composite `(tenant_id, created_by)` on
-- one column while its neighbour stays simple — two conventions in one table is how the next
-- person gets it wrong. Tenant isolation on `users` comes from RLS, and every write path
-- resolves the user from the session rather than from a request body.
--
-- SET NULL rather than CASCADE for the same reason it is right on owner_id: a colleague leaving
-- must not delete the leads they added.
-- ============================================================================

alter table public.leads
  add column if not exists created_by uuid references public.users(id) on delete set null;

comment on column public.leads.created_by is
  'The user who added this lead. NULL means no person did — an inbound webhook or the AI agent '
  'created it, and `source` says which. Distinct from owner_id, which is whose it is NOW: the '
  'two coincide at creation and separate on the first reassignment. Existing rows are NULL by '
  'design (see the migration header) rather than inferred.';

-- Partial: only rows that HAVE a creator are worth indexing, and 15 of the first 29 do not.
-- The query this serves is "what did this person add", which never asks for NULL.
create index if not exists leads_created_by_idx
  on public.leads (tenant_id, created_by)
  where created_by is not null;
