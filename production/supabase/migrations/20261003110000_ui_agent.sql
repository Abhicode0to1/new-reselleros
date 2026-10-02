-- ============================================================================
-- UI agent — design measurements per page, a score, and the AI's design review (3 Oct 2026).
--
-- Pardeep: "jaise ux ka ai agent banaya hai vaise hi ui ko improve karne ke liye ui ka ai
-- agent bana do" … "world class design hona chahiye".
--
-- The UX observer (20261003100000) also takes ONE design measurement per page per visit
-- while the person is active: contrast failures, text below 12 px, tap targets below 24 px
-- on phones, sideways scroll, headings, unnamed controls, images without alt, how many
-- filled "primary" buttons compete, font sizes/families in use, words above the fold,
-- longest form, layout shift, largest paint. Numbers only — no text, no PII — in
-- ux_events.metrics (kind 'ui_probe').
--
-- ux_insights gains agent ('ux' | 'ui') and design categories; ui_page_scores holds each
-- page's 0–100 score and its top issues, recomputed by the analysis.
-- ============================================================================
begin;

alter table public.ux_events drop constraint if exists ux_events_kind_check;
alter table public.ux_events add constraint ux_events_kind_check
  check (kind in ('view', 'rage_click', 'dead_click', 'error', 'form_abandon', 'stall', 'quick_exit', 'slow', 'ui_probe'));
alter table public.ux_events add column if not exists metrics jsonb
  check (metrics is null or octet_length(metrics::text) <= 2000);

alter table public.ux_insights add column if not exists agent text not null default 'ux'
  check (agent in ('ux', 'ui'));
alter table public.ux_insights drop constraint if exists ux_insights_category_check;
alter table public.ux_insights add constraint ux_insights_category_check
  check (category in ('confusing', 'broken', 'slow', 'copy', 'logic', 'flow',
                      'visual', 'accessibility', 'layout', 'consistency', 'mobile', 'performance'));

create table if not exists public.ui_page_scores (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  surface     text not null check (surface in ('app', 'site')),
  path        text not null,
  score       integer not null check (score between 0 and 100),
  samples     integer not null default 0,
  issues      jsonb not null default '[]'::jsonb,
  prev_score  integer,
  updated_at  timestamptz not null default now(),
  unique (tenant_id, surface, path)
);

alter table public.ui_page_scores enable row level security;
drop policy if exists zzz_service_role_all on public.ui_page_scores;
create policy zzz_service_role_all on public.ui_page_scores as permissive for all to service_role using (true) with check (true);
grant select, insert, update, delete on public.ui_page_scores to service_role;

comment on table public.ui_page_scores is 'UI agent: per-page design score (0–100) from real visits, with the top issues and the previous score.';

commit;
