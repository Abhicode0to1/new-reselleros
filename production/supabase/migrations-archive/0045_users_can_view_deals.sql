-- 0045_users_can_view_deals.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Optional Deals access for sales role
--
-- After splitting /leads and /deals into separate pages, owners want a way
-- to grant SOME sales reps access to the Deal Pipeline (Kanban) without
-- promoting them to manager (which unlocks the entire app).
--
-- can_view_deals = true  → sidebar shows "Deals" entry, /deals route allowed
-- can_view_deals = false → only "Leads" (default for sales role)
--
-- Owner + manager roles ignore this flag — they always see Deals.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.users
  add column if not exists can_view_deals boolean not null default false;

comment on column public.users.can_view_deals is
  'Sales-role extension: when true, this user also sees the /deals page. Ignored for owner/manager (who always see Deals).';
