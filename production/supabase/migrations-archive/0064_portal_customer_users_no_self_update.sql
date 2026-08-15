-- 0064_portal_customer_users_no_self_update.sql
-- Close a cross-customer privilege-escalation hole in the portal (security audit).
--
-- HOLE: customer_users_update_self_or_tenant allowed UPDATE where
-- `auth_user_id = auth.uid()` with NO `WITH CHECK`. `authenticated` has the
-- UPDATE table grant, so a logged-in portal customer could PATCH their own
-- customer_users row and change `customer_id` to a VICTIM's id. current_customer_id()
-- = (select customer_id from customer_users where auth_user_id = auth.uid()), so
-- every portal read (invoices / subscriptions / quotes / support, all scoped to
-- current_customer_id()) would then return the victim customer's data.
--
-- The only legit customer-side write to customer_users is the best-effort
-- last_login_at stamp in getPortalSession(). So:
--   1. Drop the customer self-update path — operators keep tenant-scoped update;
--      customers can no longer UPDATE customer_users directly at all.
--   2. Provide a narrow SECURITY DEFINER RPC that stamps ONLY last_login_at on the
--      caller's own row. getPortalSession() calls this instead of a raw UPDATE.

drop policy if exists customer_users_update_self_or_tenant on public.customer_users;

create policy customer_users_update_operator on public.customer_users
  for update to public
  using      ((tenant_id = current_tenant_id()) or (auth.role() = 'service_role'))
  with check ((tenant_id = current_tenant_id()) or (auth.role() = 'service_role'));

create or replace function public.portal_touch_login()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.customer_users
     set last_login_at = now()
   where auth_user_id = auth.uid();
end;
$$;

grant execute on function public.portal_touch_login() to authenticated;
