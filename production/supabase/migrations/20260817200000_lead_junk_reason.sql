-- 20260817200000_lead_junk_reason
--
-- WHY a lead was binned, not just that it was.
--
-- ─── A BOOLEAN IS NOT ENOUGH, AND THE GAP HAS A VICTIM ──────────────────────
-- `leads.is_junk` records that somebody binned a lead and nothing about why. That is
-- fine until the day it is wrong — and it will be, because junk is judged in a hurry,
-- often from a phone, often on one glance at a form submission.
--
-- The two cases look identical afterwards and are not remotely the same:
--
--   "fake phone number"  → recoverable. The moment a real number arrives this is a
--                          live enquiry again.
--   "student enquiry"    → not recoverable. A real person, nothing to sell them.
--
-- Without the reason nobody can tell them apart, so nobody dares un-bin either, and
-- genuine enquiries stay dead. The reason is what makes un-binning a safe act.
--
-- It also splits a marketing question that `is_junk` fuses: "how much of this source
-- is spam" is a different problem from "how much of it never replies", and a channel
-- cut on the fused number kills one that was working. lib/leads/qualification.ts
-- carries `countsAsSpam` per reason for exactly that.
--
-- ─── NOT BACKFILLED ─────────────────────────────────────────────────────────
-- Existing junk leads keep junk_reason NULL. Assigning one would be inventing a
-- judgement nobody made, and "other" would be a lie with a timestamp on it. NULL
-- reads honestly as "binned before we recorded why".

begin;

alter table public.leads
  add column if not exists junk_reason text,
  add column if not exists junk_note   text,
  add column if not exists junked_at   timestamptz;

alter table public.leads drop constraint if exists leads_junk_reason_check;
alter table public.leads add constraint leads_junk_reason_check
  check (junk_reason is null or junk_reason in
         ('fake_phone','spam_email','not_commercial','unresponsive','other'));

comment on column public.leads.junk_reason is
  'WHY this lead was binned. is_junk alone records that someone binned it and nothing about whether a real enquiry is hiding behind it — "fake_phone" is recoverable the moment a real number arrives, "not_commercial" never will be. Without this nobody dares un-bin either. Values match JunkReasonId in lib/leads/qualification.ts.';
comment on column public.leads.junk_note is
  'Free text. Required when junk_reason = other — a reason of "other" with no note explains nothing.';
comment on column public.leads.junked_at is
  'When it was binned. Null on leads binned before reasons existed — deliberately not backfilled, because we know neither when nor why those happened.';

/* The reporting query: this tenant's junk, grouped by reason. Partial — only junk
   rows have a reason, and the index should not carry the whole table. */
create index if not exists leads_junk_reason_idx
  on public.leads (tenant_id, junk_reason) where is_junk;

commit;
