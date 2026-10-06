-- ============================================================================
-- Deleting a lead / deal is for an owner or manager — 2 Oct 2026.
--
-- Pardeep: "kya deal delete hone ka koi system nahi hai" → "Delete sirf owner/manager".
-- Until now any member of the tenant could permanently delete any lead they could see
-- (leads_delete only checked the tenant). A rep marks a deal Lost instead, with a reason,
-- which keeps the history and the win/loss numbers honest.
--
-- RESTRICTIVE and only `to authenticated`: it narrows the existing permissive tenant policy
-- for signed-in users, and leaves server paths alone — merge_leads() (security definer,
-- used by reps to fold a duplicate) and service-role jobs are not affected.
--
-- A deal with a quote still cannot be deleted by anyone: quotes.lead_id has no ON DELETE
-- action, so the quote (and the books behind it) keeps the row. That is deliberate.
-- ============================================================================
begin;

drop policy if exists leads_delete_owner_manager on public.leads;
create policy leads_delete_owner_manager on public.leads
  as restrictive for delete to authenticated
  using (public.current_user_has_role('owner', 'manager'));

commit;
