-- ============================================================
-- ResellerOS — flag renewal quotes
-- Migration: 0011_quotes_is_renewal.sql
-- ============================================================
-- Purpose
--   Renewal quotes (auto-created at T-15 by the cron, or operator-
--   generated early via /api/subscriptions/[id]/generate-renewal-quote)
--   are semantically different from new-customer quotes:
--
--     - They're for existing customers, not prospects
--     - Payment rolls a subscription forward, doesn't create one
--     - Sales attribution should treat them as RETENTION, not new MRR
--     - Operator scanning a quote list needs to tell them apart at a glance
--
--   Pre-this-migration the distinction was implicit (matched by notes
--   pattern, or backwards via subscriptions.renewal_quote_id). Now it's
--   an explicit column the UI can render as a badge.
-- ============================================================

begin;

alter table public.quotes
  add column if not exists is_renewal boolean not null default false;

comment on column public.quotes.is_renewal is
  'True when this quote was issued for the renewal of an existing subscription. Auto-set by lib/renewals/create-renewal-quote.ts. Drives the "Renewal" badge in /quotes list + detail + PDF.';

-- Backfill: any quote linked from a subscription.renewal_quote_id is one.
-- Plus any quote whose auto-generated note marks it as a renewal quote.
update public.quotes q
   set is_renewal = true
 where is_renewal = false
   and (
     exists (
       select 1 from public.subscriptions s
        where s.renewal_quote_id = q.id
     )
     or coalesce(q.notes, '') ilike 'Auto-generated renewal quote%'
     or coalesce(q.notes, '') ilike 'Renewal quote%'
   );

-- Index for queries like "show me all renewals this FY"
create index if not exists quotes_is_renewal_idx
  on public.quotes (tenant_id, is_renewal)
  where is_renewal = true;

commit;
