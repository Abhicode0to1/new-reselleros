-- ============================================================================
-- 0235 — Per-tenant email provider: Resend or the tenant's own Gmail
-- ============================================================================
--
-- ─── WHY A TENANT WOULD CHOOSE GMAIL ─────────────────────────────────────────
-- Every reseller here already pays for Google Workspace. Sending through their
-- own Gmail means SPF and DKIM are aligned automatically — Google IS the sender
-- for that domain — so none of the DNS work that `?check=sending` reports is
-- needed. On anutech.in that matters more than usual: DMARC is already p=reject,
-- so switching the From to their domain via a provider whose SPF/DKIM are not yet
-- published would get the mail REJECTED outright, not filed as spam.
--
-- It also arrives from a real mailbox, so a customer's reply lands somewhere a
-- person actually reads.
--
-- ─── WHY IT IS NOT THE DEFAULT ───────────────────────────────────────────────
-- Gmail reports no bounces and keeps no suppression list. A dead recipient
-- address fails silently, the API still returns success, and the bounce arrives
-- later as an email to the sender. For renewal reminders that is the precise
-- failure this project keeps hitting: the app records "sent" and the customer
-- heard nothing. So `email_provider` defaults to 'resend', and the resolver warns
-- when a bounce-sensitive message is routed through Gmail rather than silently
-- overriding the tenant's choice.
--
-- ─── WHY THE SENDER IS A USER, NOT THE TENANT ────────────────────────────────
-- Gmail sends AS somebody. Tokens live per user in `user_google_tokens`, and a
-- cron has no session, so the tenant has to name which connected account speaks
-- for it. That also makes the fragility explicit and visible: if that person
-- leaves and their Google account is deleted, sending stops — which is exactly
-- the sort of thing that should be a row someone can see, not a surprise.
--
-- ─── WHY `scopes` IS RECORDED ────────────────────────────────────────────────
-- A token granted before gmail.send existed authenticates perfectly and cannot
-- send. Without recording what was actually granted, the only way to find out is
-- a 403 at send time — on a renewal reminder, at night, inside a cron. Recording
-- the granted scopes turns that into a check the settings screen can make before
-- anyone relies on it.
--
-- ─── HOW TO RUN (CLAUDE.md §25.6) ───────────────────────────────────────────
-- One batch at a time; the verify block is a SEPARATE run.
-- ============================================================================

begin;

-- What Google actually granted, space-separated exactly as Google returns it.
-- NULL means "connected before this column existed" — unknown, not empty, and the
-- resolver treats unknown as "cannot send" rather than assuming.
alter table public.user_google_tokens
  add column if not exists scopes text;

comment on column public.user_google_tokens.scopes is
  'Scopes Google actually granted, space-separated. NULL = connected before this column existed, which is treated as "cannot send" rather than assumed. A token granted before gmail.send existed authenticates fine and fails only at send time with a 403.';

alter table public.tenants
  add column if not exists email_provider text not null default 'resend'
    check (email_provider in ('resend', 'gmail')),
  add column if not exists gmail_sender_user_id uuid references public.users(id) on delete set null;

comment on column public.tenants.email_provider is
  'Which transport outbound mail uses. Defaults to resend because Gmail reports no bounces — a dead address fails silently and the app would record "sent".';
comment on column public.tenants.gmail_sender_user_id is
  'Whose connected Google account sends for this tenant. Required when email_provider = gmail, because Gmail sends AS somebody and a cron has no session. ON DELETE SET NULL so removing a user disables sending loudly rather than leaving a dangling reference.';

-- The send path asks "which account sends for this tenant" on every message.
create index if not exists tenants_gmail_sender_idx
  on public.tenants (gmail_sender_user_id)
  where gmail_sender_user_id is not null;

commit;


-- ============================================================================
-- VERIFY — RUN THIS AS A SEPARATE EDITOR RUN
-- Expect: columns = 3 · index = 1 · tenants still on resend = all of them
-- ============================================================================
/*
select 'new columns' as thing, count(*) as n
  from information_schema.columns
 where table_schema = 'public'
   and ((table_name = 'user_google_tokens' and column_name = 'scopes')
     or (table_name = 'tenants' and column_name in ('email_provider','gmail_sender_user_id')))
union all
select 'index', count(*) from pg_indexes
 where schemaname = 'public' and indexname = 'tenants_gmail_sender_idx'
union all
-- Nothing should have silently switched provider.
select 'tenants on resend', count(*) from public.tenants where email_provider = 'resend'
union all
select 'tenants on gmail (expect 0)', count(*) from public.tenants where email_provider = 'gmail';
*/
