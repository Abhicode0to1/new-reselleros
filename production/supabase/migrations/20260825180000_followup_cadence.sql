-- ═══════════════════════════════════════════════════════════════════════════
-- Multi-touch follow-up cadence — a step counter, not a queue of four rows
--
-- ─── WHY NOT FOUR ROWS ──────────────────────────────────────────────────────
-- The obvious way to schedule a 4-step cadence is to insert four `ai_sales_loops` rows at
-- once. That would require dropping this index, from 20260824120000:
--
--     create unique index ai_sales_loops_one_pending_per_lead
--       on public.ai_sales_loops (tenant_id, lead_id) where status = 'pending';
--
-- and its comment says exactly what it is for: "without this, two inbound messages in a
-- minute schedule two follow-ups and the customer gets nudged twice for one silence." That
-- is a real defect and it is still real — an inbound WhatsApp message and an inbound email
-- seconds apart would each try to open a cadence.
--
-- So the cadence is a STATE MACHINE over one row instead. `step` says where in the sequence
-- this lead is; when the cron fires a step it marks the row processed and writes the NEXT
-- one. One pending row per lead throughout, index intact, and the cadence advances.
--
-- The other reason to prefer this: every step re-reads the world before it fires. Four rows
-- written on day one would carry day-one assumptions to day seven — the quote's expiry, the
-- lead's stage, whether a person has taken it over. `shouldNudge` already refuses on four of
-- those, and it can only refuse on facts that are still being looked up.
--
-- ─── THE DAY-4 CONTENT SLOT, AND WHY IT IS EMPTY ────────────────────────────
-- The brief's day-4 step was: "Case Study: Humne 50-user team ka Google Workspace migration
-- 0 downtime mein kaise complete kiya." That is a factual claim about work this company did,
-- and there is no case-study content anywhere in this app to draw it from — so an agent
-- writing it would be inventing a customer reference. Same family as pricing a free migration
-- at ₹15,000 (see lib/pricing/net-cost.ts): a confident number, or a confident story, with no
-- source.
--
-- `tenants.followup_value_drop` is therefore NULL by default and the day-4 step is SKIPPED
-- while it is empty — the cadence goes straight from day 2 to day 7. Pardeep writes one
-- paragraph about a migration he actually did, and the step starts firing. Nothing in the code
-- can write it for him, which is the point.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. Where this lead is in the sequence ──────────────────────────────────
-- 1-based, so `step = 1` is the first nudge rather than a zero nobody can read in a log.
-- Defaults to 1 so every row already in the table — all of them written by the single-nudge
-- code — is exactly what it says it is: the first step, and until now the only one.
alter table public.ai_sales_loops
  add column if not exists step smallint not null default 1;

alter table public.ai_sales_loops
  add constraint ai_sales_loops_step_range check (step >= 1 and step <= 10);

comment on column public.ai_sales_loops.step is
  'Which step of the follow-up cadence this row is. The cron marks a row processed and writes '
  'the next step, so there is never more than one pending row per lead — see the unique index '
  'ai_sales_loops_one_pending_per_lead, which this design exists to preserve.';

-- ── 2. Which channel the step wants ───────────────────────────────────────
-- What the cadence ASKED for, not necessarily what happened. WhatsApp outside Meta's
-- 24-hour customer-service window is refused unless it is an approved template, so a step
-- that wanted WhatsApp may have gone by email — and the log has to be able to say so rather
-- than leave somebody wondering why the customer never got a WhatsApp.
alter table public.ai_sales_loops
  add column if not exists channel text not null default 'email'
    check (channel in ('email', 'whatsapp'));

-- What actually carried it. NULL until the step fires.
alter table public.ai_sales_loops
  add column if not exists sent_channel text
    check (sent_channel is null or sent_channel in ('email', 'whatsapp', 'none'));

comment on column public.ai_sales_loops.sent_channel is
  'The channel that actually carried this step, which can differ from `channel`: WhatsApp '
  'outside Meta''s 24-hour window falls back to email. "none" means the step was skipped — a '
  'value-drop with no content written, for instance.';

-- ── 3. The day-4 content, which nothing but a person can write ────────────
alter table public.tenants
  add column if not exists followup_value_drop text;

comment on column public.tenants.followup_value_drop is
  'The reseller''s own words for the day-4 "value" step of the follow-up cadence — a migration '
  'they actually did, in one paragraph. NULL means the step is skipped. Deliberately not '
  'seeded: the brief asked the AI to describe a 50-user zero-downtime migration, and no such '
  'case study exists in this app, so generating one would be inventing a customer reference.';

commit;
