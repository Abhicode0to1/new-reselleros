-- A tenant may send through a plain SMTP relay.
--
-- ─── WHY ────────────────────────────────────────────────────────────────────
-- Pardeep, 11 Sep 2026: "use the smtp transport". The app could send through
-- Resend or a tenant's Gmail and nothing else, and the DMS deployment — whose
-- credentials this app takes over from — has neither. It has `SMTP_HOST` /
-- `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS`, pointed at smtp.gmail.com:587 as
-- noreply@anutech.in with an app password (verified working from this machine).
--
-- Measured before the transport existed: every send came back
-- `Resend 401: API key is invalid`, so the new domain-expiry warnings reached
-- nobody. The logic was right and the envelope had nowhere to go.
--
-- ─── WHY A MIGRATION IS NEEDED AT ALL ───────────────────────────────────────
-- `tenants.email_provider` carries
--   CHECK (email_provider = ANY (ARRAY['resend', 'gmail']))
-- so a tenant could not be SET to 'smtp' even with the transport built. Found by
-- trying it: the update failed with `tenants_email_provider_check`. The column is
-- the only way a tenant asks for a transport, so the constraint is the switch.
--
-- ─── AND WHY THE TENANT HAS TO ASK, RATHER THAN IT BEING AUTOMATIC ──────────
-- `resolveEmailProvider` already falls back to the relay when Resend is not
-- configured. That is not enough on its own, and the reason is worth recording:
-- this deployment HAS a `RESEND_API_KEY` — an invalid one. So `resendConfigured`
-- is true, Resend is chosen, and every message 401s while a working relay sits
-- unused. A key that is present and wrong is indistinguishable from a key that
-- works until the send fails.
--
-- Deliberately NOT solved by falling back at send time. Retrying a failed send on
-- a second transport risks delivering twice: Resend can accept a message and then
-- report a timeout, and "send it again somewhere else" would put two renewal
-- notices in a customer's inbox. Choosing the transport before the send is the
-- only version with one outcome.
--
-- So: set `email_provider = 'smtp'` on the tenant, and the relay carries its mail.

alter table public.tenants
  drop constraint if exists tenants_email_provider_check;

alter table public.tenants
  add constraint tenants_email_provider_check
  check (email_provider = any (array['resend'::text, 'gmail'::text, 'smtp'::text]));

-- ─── AND THE LOG HAS TO ACCEPT IT TOO ──────────────────────────────────────
-- `email_log.provider` carried the same shape of constraint —
--   CHECK (provider = ANY (ARRAY['resend', 'gmail', 'stub']))
-- — so an SMTP send was recorded nowhere. Worse than an error: `recordEmail`
-- deliberately swallows its own failures (a broken log must not break a send),
-- so the message went out, the cron counted it as sent, and the audit row was
-- dropped in silence.
--
-- Found by running the domain-expiry cron after switching the tenant to smtp:
-- it reported `sent: 2` and `email_log` gained nothing. An audit trail with a
-- hole exactly where the transport that now carries every message should be is
-- worse than no audit trail, because the gap looks like "no mail was sent".

alter table public.email_log
  drop constraint if exists email_log_provider_check;

alter table public.email_log
  add constraint email_log_provider_check
  check (provider = any (array['resend'::text, 'gmail'::text, 'smtp'::text, 'stub'::text]));

comment on column public.email_log.provider is
  'Which transport carried this message. `smtp` added 11 Sep 2026 with the relay; the constraint had to be widened or the row was rejected and — because recordEmail swallows its errors so a broken log cannot break a send — dropped silently.';

comment on column public.tenants.email_provider is
  'Which transport carries this tenant''s mail: resend (reports bounces), gmail (does not), or smtp (does not — a plain relay, added 11 Sep 2026 so the DMS SMTP credentials work unchanged). NOT NULL with a default of resend — there is no "unset", which is why every tenant has to be switched deliberately. A tenant must ASK for smtp: a present-but-invalid RESEND_API_KEY still counts as configured, so the automatic fallback in lib/email/provider.ts cannot rescue that case.';
