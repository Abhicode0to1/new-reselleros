-- ============================================================================
-- 0247 — an emailed bill is read, stored, and left for a human
-- ============================================================================
--
-- 0246 routed billing@ but could only record that a message arrived: the webhook
-- never read attachments. These columns hold the attachment and what Gemini made
-- of it.
--
-- ─── WHY THIS DOES NOT CREATE A vendor_bills ROW ────────────────────────────
-- /api/ai/extract-bill has always refused to write money from an extraction, and
-- says why: "AI can misread amounts, and this feeds GST input credit + P&L, so a
-- human must confirm." The email path makes that easier to forget and MORE
-- important to keep. An emailed bill is not more trustworthy than an uploaded one
-- — it is less, because nobody was looking when it arrived. Anyone who can guess
-- the ingest address could otherwise post entries into the books.
--
-- So the extraction lands in `extracted_bill` as a SUGGESTION, and `bill_id`
-- stays null until a person reviews it and creates the bill. The columns are
-- named so that is obvious to the next reader.
--
-- ─── WHY THE RAW FILE IS KEPT ───────────────────────────────────────────────
-- `attachment_path` points at the original in the private `documents` bucket.
-- Without it the extraction is unverifiable: an operator reviewing a total has
-- nothing to check it against, and a GST audit asks for the invoice, not for
-- what a model thought the invoice said.
--
-- ─── HOW TO RUN (CLAUDE.md §25.6) ──────────────────────────────────────────
-- One batch; verify separately.
-- ============================================================================

begin;

alter table public.inbound_emails
  add column if not exists attachment_path text,
  add column if not exists attachment_name text,
  add column if not exists attachment_mime text,
  add column if not exists extracted_bill  jsonb,
  add column if not exists bill_id         text references public.vendor_bills(id) on delete set null;

comment on column public.inbound_emails.attachment_path is
  'Object path in the private `documents` bucket. The original file — without it the extraction cannot be checked, and an audit asks for the invoice, not for what a model thought it said.';
comment on column public.inbound_emails.extracted_bill is
  'What Gemini read from the attachment. A SUGGESTION, never posted to the books on its own: these figures feed GST input credit and the P&L.';
comment on column public.inbound_emails.bill_id is
  'Set only when a human reviewed the extraction and created the vendor bill. NULL means nothing was posted.';

-- The review queue: billing mail that has an extraction and no bill yet.
create index if not exists idx_inbound_emails_pending_bill
  on public.inbound_emails (tenant_id, created_at desc)
  where route = 'billing' and bill_id is null;

commit;


-- ============================================================================
-- VERIFY — RUN THIS AS A SEPARATE EDITOR RUN
--
-- Expect: 5 new columns · index present · bill_id null on every row
-- ============================================================================
/*
select 'new columns (expect 5)' as check, count(*)::text as v
  from information_schema.columns
 where table_schema='public' and table_name='inbound_emails'
   and column_name in ('attachment_path','attachment_name','attachment_mime','extracted_bill','bill_id')
union all
select 'review-queue index', count(*)::text
  from pg_indexes where schemaname='public' and indexname='idx_inbound_emails_pending_bill'
union all
select 'rows with a posted bill (expect 0 for now)', count(*)::text
  from public.inbound_emails where bill_id is not null;
*/
