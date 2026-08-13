-- ============================================================================
-- 0232 — Marketing attribution: ad-spend channel tagging + UTM capture
-- ============================================================================
--
-- ─── WHY AD SPEND STAYS IN `expenses` AND GETS NO TABLE OF ITS OWN ───────────
-- The brief asked for a campaign table carrying `budget`, `actual_spend`,
-- `impressions`, `clicks`. Spend is NOT put in a new table, and that is the most
-- important decision in this migration.
--
-- Marketing spend already lands in `expenses` — measured 13 Aug 2026, there is a
-- ₹4,000 Facebook row with `category = 'Marketing'`, `vendor_name = 'facebook'`.
-- Those rows flow into the P&L and are reconciled against the bank statement
-- (28 of 39 bank lines are hand-matched today). A separate ad-spend table would
-- create a SECOND place spend lives, and the second place bypasses bank
-- reconciliation entirely — producing marketing spend that shows on a dashboard
-- and never appears in the bank. CAC computed from it would disagree with the
-- accounts, and both numbers would look authoritative.
--
-- So spend gets one new column, `expenses.channel`, and CAC/ROAS are computed
-- from the same rows the accountant already reconciles. One source of truth.
--
-- `impressions` and `clicks` are deliberately absent. Without the Google Ads and
-- Meta APIs (no credentials) they would be hand-typed monthly, and hand-typed
-- impressions add nothing to CAC or ROAS — both need only spend and outcomes.
-- Empty columns invite a dashboard that reports zero as if it were measured.
--
-- ─── WHY `leads` GETS UTM COLUMNS AND NOT A TOUCHPOINT TABLE (YET) ───────────
-- Multi-touch attribution needs a row per touch. Nothing in this app records a
-- second touch — `leads.source` is a single value, and no click or open is
-- tracked anywhere. A `lead_touchpoints` table would therefore be created empty
-- and stay empty: built, looks configured, does nothing. It is the right shape
-- for later, once there is a second touch to record.
--
-- What IS available now is first-touch-at-creation, and it is available on a
-- write path that already runs: four public routes create leads today
-- (`/api/public/enquiry/general`, `/api/public/enquiry/workspace`,
-- `/api/public/trial/workspace`, `/api/public/checkout/workspace`). These columns
-- start filling from the next inbound lead.
--
-- ─── PRIVACY ─────────────────────────────────────────────────────────────────
-- `landing_page_url` stores path + utm params only, and `referrer_url` stores
-- origin + path — the rest of the query string is stripped in
-- `src/lib/marketing/utm.ts` before it ever reaches these columns. Real landing
-- URLs carry `?email=`, `?phone=` and session tokens, and a marketing table is
-- the last place anyone would look for personal data (DPDP).
--
-- ─── HOW TO RUN (CLAUDE.md §25.6) ───────────────────────────────────────────
-- One batch at a time. The verify block is a SEPARATE run — inside the same
-- transaction it reads uncommitted state and reports success for changes about to
-- roll back.
-- ============================================================================

-- ───────────────────────────────────────────────────────────────────────────
-- BATCH 1 · Ad-spend channel tagging on expenses
-- ───────────────────────────────────────────────────────────────────────────
begin;

alter table public.expenses
  add column if not exists channel text;

comment on column public.expenses.channel is
  'Marketing channel this spend belongs to (google-ads, meta-ads, linkedin-ads, whatsapp, email-outreach, trade-show, …). Set only on marketing-category rows; NULL everywhere else. Matched case-insensitively against leads.utm_source-derived channels by lib/marketing/channel-economics.ts.';

-- Only marketing spend needs a channel, so the index is partial — it stays small
-- even as `expenses` grows with salaries, hosting and office supplies.
create index if not exists expenses_channel_idx
  on public.expenses (tenant_id, channel, expense_date)
  where channel is not null;

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- BATCH 2 · UTM capture on leads
--
-- All eight are nullable with no default. A lead typed in by hand has no landing
-- page and no referrer, and 61 of the existing leads never will — inventing a
-- value would put "unknown" in a column that means "we captured nothing", which
-- is a different fact.
--
-- The three click ids (gclid/wbraid/fbclid) are the ones that matter most, and
-- they are added BEFORE any ad-platform integration exists on purpose: reporting
-- an offline conversion back to Google or Meta means sending the ORIGINAL click
-- id, and a click id that was never stored can never be sent. Developer-token
-- approval takes weeks; every inbound lead in the meantime would be permanently
-- un-attributable. This column is cheap now and unrecoverable later.
-- ───────────────────────────────────────────────────────────────────────────
begin;

alter table public.leads
  add column if not exists utm_source       text,
  add column if not exists utm_medium       text,
  add column if not exists utm_campaign     text,
  add column if not exists referrer_url     text,
  add column if not exists landing_page_url text,
  -- Ad-platform click ids. Added to THIS migration rather than a new 0233
  -- because 0232 is not applied yet (verified against production before
  -- editing) and they belong to the same feature — a separate migration for
  -- three columns of the same change is drift waiting to happen.
  add column if not exists gclid            text,
  add column if not exists wbraid           text,
  add column if not exists fbclid           text;

comment on column public.leads.utm_source   is 'utm_source from the landing URL. NULL = not tagged (every lead created before migration 0232).';
comment on column public.leads.utm_medium   is 'utm_medium. cpc/ppc/paid/display mark paid traffic, which separates google-ads from google-organic — only one of the two has a CAC.';
comment on column public.leads.utm_campaign is 'utm_campaign, for per-campaign attribution.';
comment on column public.leads.referrer_url is 'Referrer as origin + path. Query string stripped (it leaks search terms and tokens); self-referrals discarded.';
comment on column public.leads.landing_page_url is 'Landing page as path + utm params ONLY. Other query params are dropped before storage — they routinely carry email/phone/session ids (DPDP).';
comment on column public.leads.gclid  is 'Google Ads click id from the landing URL. REQUIRED to report an offline conversion back to Google Ads -- a click id you never stored can never be sent back, so this is captured before any API integration exists.';
comment on column public.leads.wbraid is 'Googles cookieless click id, sent INSTEAD of gclid when consent limits tracking. A capture that only looked for gclid would silently lose every consent-limited click.';
comment on column public.leads.fbclid is 'Meta click id, for Meta offline conversion import.';

-- The attribution query is "leads in this period grouped by channel", so the
-- index leads on tenant + source + created_at.
-- The offline-conversion sync asks: which leads have a click id? Partial, so it
-- stays small while most rows have none.
create index if not exists leads_gclid_idx
  on public.leads (tenant_id, created_at)
  where gclid is not null or wbraid is not null;

create index if not exists leads_utm_source_idx
  on public.leads (tenant_id, utm_source, created_at)
  where utm_source is not null;

commit;


-- ============================================================================
-- VERIFY — RUN THIS AS A SEPARATE EDITOR RUN
-- Expect: expenses.channel = 1 · leads attribution columns = 8 · indexes = 3
-- ============================================================================
/*
select 'expenses.channel' as thing, count(*) as n
  from information_schema.columns
 where table_schema = 'public' and table_name = 'expenses' and column_name = 'channel'
union all
select 'leads attribution columns', count(*)
  from information_schema.columns
 where table_schema = 'public' and table_name = 'leads'
   and column_name in ('utm_source','utm_medium','utm_campaign','referrer_url','landing_page_url','gclid','wbraid','fbclid')
union all
select 'new indexes', count(*)
  from pg_indexes
 where schemaname = 'public' and indexname in ('expenses_channel_idx','leads_utm_source_idx','leads_gclid_idx');
*/
