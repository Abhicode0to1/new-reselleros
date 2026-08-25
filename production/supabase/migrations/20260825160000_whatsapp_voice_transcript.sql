-- ═══════════════════════════════════════════════════════════════════════════
-- WhatsApp voice notes — somewhere to keep what the machine heard
--
-- Indian B2B customers talk rather than type. The webhook has always STORED an audio message
-- (`media_id`, `media_mime`, `type = 'audio'`) and has never had anything to say about it: the
-- sales agent ran on `type === 'text'` only, so a voice note asking for fifteen seats sat in
-- the Inbox unanswered. lib/voice/stt.ts transcribes it now, and the words need a home.
--
-- ─── WHY NOT text_body ──────────────────────────────────────────────────────
-- Because `text_body` means "what the customer typed", and a transcript is a MACHINE'S
-- READING OF WHAT SOMEBODY SAID. Putting one in the other makes every Inbox row, every export
-- and every future query unable to tell them apart — and the first time it matters will be an
-- argument about a number, where "they wrote 15" and "we heard 15" are very different claims.
--
-- That distinction is not decorative. `decideAutoSend` refuses to send a quote whose seat
-- count was heard rather than written (lib/quotes/auto-send-quote.ts), because "15 log" heard
-- as "50 log" is 3.3× the quantity AND moves the deal across a band of the volume rate card.
-- A schema that blurred the two would leave that guard with nothing to read.
--
-- ─── NOTHING CHANGES FOR ANY EXISTING ROW ───────────────────────────────────
-- Two nullable columns. Every message already stored keeps a NULL transcript, which is the
-- truth: nobody transcribed them. And `SARVAM_API_KEY` is not set on this deployment
-- (checked 25 Aug 2026), so until it is, every voice note still takes the "leave it for a
-- person" path and these columns stay empty.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

alter table public.whatsapp_messages
  add column if not exists transcript text;

alter table public.whatsapp_messages
  add column if not exists transcript_lang text;

comment on column public.whatsapp_messages.transcript is
  'What a speech-to-text model heard in this voice note. NOT the customer''s own words — '
  'text_body is for what they typed. Anything priced off this figure is held for a human '
  'to confirm; see lib/quotes/auto-send-quote.ts.';

comment on column public.whatsapp_messages.transcript_lang is
  'BCP-47 the provider detected, e.g. "hi-IN". Null when it did not say. Recorded because a '
  'transcript nobody can tell the language of is one nobody can re-check.';

-- The Inbox query that finds voice notes still waiting on a person: audio, inbound, and
-- nothing heard. Partial, because transcribed and text messages are the overwhelming majority
-- and this list must not walk them.
create index if not exists whatsapp_messages_untranscribed_idx
  on public.whatsapp_messages (tenant_id, created_at desc)
  where type = 'audio' and direction = 'inbound' and transcript is null;

commit;
