-- Invite ab sirf email-address nahi — ek raaz (token) bhi hai.
--
-- 1 Sep 2026 ke audit ka #1 khatra: /api/auth/signup email/password branch
-- par invite ko SIRF email se pehchanta tha aur email_confirm: true ke saath
-- account bana deta tha — mailbox ka koi saboot nahi. Jo koi invited address
-- jaanta/andaza lagata (billing@company.com), wo apna password rakh kar us
-- tenant me ghus sakta tha — owner role tak. Google-OAuth raasta surakshit
-- tha (Google mailbox saabit karta hai); password raasta nahi.
--
-- Ab: har invite ke saath gen_random_uuid() ka token, jo sirf invite-email
-- me jata hai. Password-signup se join TABHI jab token match ho. Google
-- raasta pehle jaisa (use token ki zaroorat nahi — mailbox ka saboot wahi hai).

alter table public.team_invites
  add column if not exists token uuid not null default gen_random_uuid();

create unique index if not exists team_invites_token_key
  on public.team_invites(token);

comment on column public.team_invites.token is
  'Invite-email me jane wala raaz — password-signup se join iske bina nahi hota (audit 1 Sep 2026). Google sign-in ko iski zaroorat nahi.';
