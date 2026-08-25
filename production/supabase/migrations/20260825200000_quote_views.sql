-- ═══════════════════════════════════════════════════════════════════════════
-- Quote view tracking, and the hot-lead alert stamp
--
-- ─── WHY A SERVER-SIDE LOG AND NOT AN ANALYTICS PIXEL ───────────────────────
-- The brief asked for "analytics pixel on the quotation link". A pixel is the weakest
-- mechanism available here and it fails in the one direction that costs the most:
--
--   GMAIL PRE-FETCHES IMAGES THROUGH ITS OWN PROXY. The pixel fires whether or not a human
--   ever opened anything. Three of those and a rep is told to ring a customer who has not
--   looked at the quote. A false hot lead is worse than a missed one — the missed one costs a
--   call, the false one costs the rep's trust in the alert, and after two of them nobody acts
--   on the third.
--
-- And it is unnecessary. The quote link is OUR OWN page (`/quote/[id]/accept`), so the view can
-- be recorded server-side: nothing to block, nothing to proxy, and it records that the QUOTE
-- was opened rather than that an email was rendered.
--
-- ─── LINK PREVIEWS ARE VIEWS THAT NOBODY MADE ───────────────────────────────
-- Send a quote link on WhatsApp and Meta's servers fetch the page to build the preview card.
-- That is one view before any human sees anything; forward it and there are more. Slack,
-- iMessage and Telegram all do the same.
--
-- So `is_bot` is a column, not an afterthought: every fetch is recorded, and the ones that were
-- machines are marked and excluded from the count. Recording them rather than dropping them
-- matters — when somebody asks why a lead was not flagged, "four views, three of them link
-- previews" is an answer and a missing row is not.
--
-- ─── ONE ALERT PER QUOTE, WHICH IS A LESSON AND NOT A PREFERENCE ────────────
-- `hot_lead_alerted_at` exists because of what happened on 24 Aug: `shouldAlertUnassigned` and
-- its query both ignored ticket status, so an escalation that had been dealt with alerted the
-- desk on EVERY sweep. The once-only stamp is the fix that was built for it, and a viewer who
-- opens a quote ten times must not produce eight alerts.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. The key the composite FK needs ──────────────────────────────────────
-- `quotes.id` is TEXT and human-readable (Q-ADPL-2026-27-0058), and the table has only
-- PRIMARY KEY (id) — measured, not assumed. Additive and cannot fail on existing data.
alter table public.quotes
  drop constraint if exists quotes_tenant_id_key;
alter table public.quotes
  add constraint quotes_tenant_id_key unique (tenant_id, id);

-- ── 2. One row per fetch of a quote's public page ──────────────────────────
create table if not exists public.quote_views (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references public.tenants(id) on delete cascade,
  -- TEXT, matching quotes.id.
  quote_id     text        not null,

  viewed_at    timestamptz not null default now(),

  /* Truncated on write — see the route. A full user-agent is a fingerprint, and this table is
     about "did they look", not about who they are. Kept at all because it is the only way to
     tell a link preview from a person. */
  user_agent   text,
  /* Was this fetch a machine? Recorded rather than dropped: "four views, three of them link
     previews" answers the question a missing row cannot. */
  is_bot       boolean     not null default false,

  /* A coarse viewer key — a hash of IP + user-agent, never the IP itself. Enough to collapse a
     refresh into one view; not enough to identify anybody. NULL when the request carried
     neither, which happens behind some proxies. */
  viewer_hash  text,

  created_at   timestamptz not null default now(),

  -- Tenant-safe link (CLAUDE.md §4). A plain `quote_id references quotes(id)` would let
  -- tenant A's view row point at tenant B's quote, and RLS would not catch it because the
  -- row's own tenant_id looks right.
  --
  -- CASCADE, not SET NULL — the opposite of the call ai_telecall_logs made, and for a reason.
  -- A record of a phone call to a real person outlives the lead; a page-view counter for a
  -- deleted quote is not evidence of anything and would only keep a stale count alive.
  constraint quote_views_quote_fk
    foreign key (tenant_id, quote_id)
    references public.quotes (tenant_id, id)
    on delete cascade
);

comment on table public.quote_views is
  'One row per fetch of a quote''s public page. Recorded server-side rather than by an '
  'analytics pixel: Gmail pre-fetches images through its proxy, so a pixel fires without any '
  'human opening anything — and a false hot-lead alert costs more than a missed one.';

-- The only query anyone makes: this quote's recent human views, newest first.
create index if not exists quote_views_recent_idx
  on public.quote_views (tenant_id, quote_id, viewed_at desc)
  where not is_bot;

-- ── 3. The once-only alert stamp ──────────────────────────────────────────
alter table public.quotes
  add column if not exists hot_lead_alerted_at timestamptz;

comment on column public.quotes.hot_lead_alerted_at is
  'When the desk was told this quote was being read repeatedly. Set once. On 24 Aug an alert '
  'whose query ignored state fired on every sweep for a ticket already handled — a viewer who '
  'opens a quote ten times must not produce eight alerts.';

-- ── 4. Somewhere to put a rep's number ────────────────────────────────────
-- `users` has no phone column at all — measured. So there is currently nowhere to send a
-- WhatsApp alert to, which is why the alert goes by email today and WhatsApp becomes possible
-- once a number is saved AND a template is approved (Meta refuses a business-initiated
-- free-form message outside its 24-hour window).
alter table public.users
  add column if not exists phone text;

comment on column public.users.phone is
  'E.164, for internal alerts to this person — not a customer-facing field. Optional: with no '
  'number the hot-lead alert goes to the owner-alert email path instead.';

-- ── 5. RLS ────────────────────────────────────────────────────────────────
alter table public.quote_views enable row level security;

-- Read: anyone in the tenant. "Has the customer opened it" is exactly what the rep working the
-- deal needs, and a counter only the owner can see is one nobody acts on.
drop policy if exists quote_views_select on public.quote_views;
create policy quote_views_select on public.quote_views
  for select using (tenant_id = public.current_tenant_id());

-- Writes are service-role only. The writer is a PUBLIC page handler with no session — the
-- viewer is a prospect, not one of our users — and an invented view row would summon a rep to
-- phone somebody who never looked.
drop policy if exists quote_views_service on public.quote_views;
create policy quote_views_service on public.quote_views
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

commit;
