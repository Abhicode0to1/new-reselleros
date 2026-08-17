-- 20260817140000_inbound_mailbox_state
--
-- The four facts a mailbox needs and inbound_emails does not have.
--
-- ─── WHY A MIGRATION COMES FIRST ────────────────────────────────────────────
-- The Enquiries page is being rebuilt as a Gmail-style inbox: Inbox, Starred,
-- Snoozed, Done, and a `is:unread` search operator. Not one of those is derivable
-- from what the table stores today.
--
-- `status` is the PIPELINE state the webhook wrote — received, lead_created,
-- appended_to_lead, duplicate, skipped_non_enquiry, error. It says what the system
-- did with an email. It cannot say whether a human has read it, flagged it, put it
-- off until Tuesday, or finished with it. Those are four different facts and they
-- change independently: an email can be `lead_created` AND unread AND starred.
--
-- Building the folders on `status` alone would mean starring an email by changing
-- its pipeline state — which would then lie to every report that reads `status`.
--
-- ─── EVERY COLUMN IS NULLABLE AND DEFAULTS TO "NOT DONE" ────────────────────
-- Existing rows keep behaving exactly as they do now: nothing is read, nothing is
-- starred, nothing is snoozed, nothing is archived. A backfill that guessed — say,
-- marking old emails read because they are old — would silently empty the Inbox of
-- work nobody has actually looked at.

begin;

alter table public.inbound_emails
  /* When a human opened it. NULL = unread, which is what `is:unread` filters on.
     A timestamp rather than a boolean because "when did we first see this" answers
     response-time questions a flag cannot. */
  add column if not exists read_at      timestamptz,

  /* Flagged by a rep. Deliberately NOT a status value — an email can be starred and
     already converted to a lead at the same time. */
  add column if not exists starred      boolean not null default false,

  /* Hidden from the Inbox until this moment passes, then it comes back. NULL = not
     snoozed. Stored as an instant, not a date: "tomorrow morning" is a moment, and
     comparing it to now() needs no timezone guesswork at read time. */
  add column if not exists snoozed_until timestamptz,

  /* Done. Out of the Inbox, still searchable, never deleted — an enquiry is a record
     of a customer contacting us and CGST aside, throwing it away loses the audit
     trail the lead was built from. */
  add column if not exists archived_at  timestamptz;

comment on column public.inbound_emails.read_at is
  'When a human first opened this email. NULL = unread. Independent of `status`, which is what the webhook did with it, not what a person did.';
comment on column public.inbound_emails.starred is
  'Rep flagged it. Independent of status — an email can be starred and already converted.';
comment on column public.inbound_emails.snoozed_until is
  'Hidden from the Inbox until this instant, then it returns. NULL = not snoozed.';
comment on column public.inbound_emails.archived_at is
  'Marked done. Leaves the Inbox, stays searchable. Nothing is ever deleted — the enquiry is the audit trail behind the lead.';

/* The Inbox query: not archived, not currently snoozed, newest first. Partial so it
   stays small as the archive grows — the Inbox is the hot path, Done is not. */
create index if not exists inbound_emails_inbox_idx
  on public.inbound_emails (tenant_id, created_at desc)
  where archived_at is null;

/* Snoozed items waking up. */
create index if not exists inbound_emails_snoozed_idx
  on public.inbound_emails (snoozed_until)
  where snoozed_until is not null;

create index if not exists inbound_emails_starred_idx
  on public.inbound_emails (tenant_id, created_at desc)
  where starred;

commit;
