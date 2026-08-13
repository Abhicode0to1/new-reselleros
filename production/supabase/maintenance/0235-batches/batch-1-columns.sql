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
