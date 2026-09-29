-- ============================================================================
-- email_log.provider may be 'smtp' — 29 Sep 2026.
--
-- sendEmail() gained an SMTP transport (src/lib/email/smtp-transport.ts): when
-- SMTP_* is set it is the platform sender, ahead of Resend. Every send writes an
-- email_log row with the transport that carried it, and the check constraint only
-- allowed resend / gmail / stub — so an SMTP send would have failed its OWN log
-- write, and recordEmail swallows that, leaving no trace of a message that went.
--
-- Widening only: every existing row still satisfies the new list.
-- ============================================================================
begin;

alter table public.email_log drop constraint if exists email_log_provider_check;
alter table public.email_log
  add constraint email_log_provider_check
  check (provider = any (array['resend'::text, 'gmail'::text, 'smtp'::text, 'stub'::text]));

commit;
