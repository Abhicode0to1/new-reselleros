-- ============================================================================
-- R-158 (5 Oct 2026): a bug report can be filed by the in-app AI Help chat.
--
-- Pardeep: while testing, talk to an AI chatbot inside the app; when a bug turns up, the AI
-- writes a proper report and files it in "Report a bug" under the person's own name — and
-- the report says, in short, that the AI drafted it after a chat.
--
-- filed_via        'form' (the Report Bug dialog, every row until today) or 'ai-chat'.
--                  NOT NULL DEFAULT 'form', so existing rows and the existing insert are
--                  untouched; the CHECK keeps the admin badge to two known values.
-- ai_chat_summary  For 'ai-chat' rows: two or three lines of what was discussed, so the
--                  person fixing it knows how the report came about. Bounded (1000).
--
-- The reporter stays the person (reported_by / reporter_name are the signed-in user):
-- the AI is the scribe, not the reporter. RLS on feedback is unchanged — the insert is the
-- same tenant-scoped insert the dialog already makes.
-- ============================================================================

begin;

alter table public.feedback
  add column if not exists filed_via text not null default 'form';

alter table public.feedback
  drop constraint if exists feedback_filed_via_check;
alter table public.feedback
  add constraint feedback_filed_via_check check (filed_via in ('form', 'ai-chat'));

alter table public.feedback
  add column if not exists ai_chat_summary text;

alter table public.feedback
  drop constraint if exists feedback_ai_chat_summary_len;
alter table public.feedback
  add constraint feedback_ai_chat_summary_len check (ai_chat_summary is null or char_length(ai_chat_summary) <= 1000);

comment on column public.feedback.filed_via is
  'How the report was filed: form (Report Bug dialog) or ai-chat (drafted by the in-app AI Help after a chat, filed under the user''s name).';
comment on column public.feedback.ai_chat_summary is
  'ai-chat rows only: a short summary of the chat the report came out of.';

commit;
