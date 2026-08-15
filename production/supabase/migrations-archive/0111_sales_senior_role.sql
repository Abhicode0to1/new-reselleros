-- 0111: add a "Sales Senior" role.
--
-- Like a sales rep, but always handles the Deal Pipeline (never gated by
-- can_view_deals) — a senior seller who owns deals end-to-end. Visibility is
-- otherwise the same as 'sales' (see filterNavForRole in src/lib/nav.ts, which
-- maps sales_senior → sales for item visibility and skips the deals gate).
alter type public.user_role add value if not exists 'sales_senior';
