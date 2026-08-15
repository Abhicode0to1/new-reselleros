-- 0062_portal_set_auto_renew.sql
-- Let a portal customer toggle their OWN subscription's auto-renew — safely.
--
-- BUG: the portal subscription page did `update subscriptions set auto_renew …`
-- directly. subscriptions has only an operator UPDATE policy
-- (tenant_id = current_tenant_id()); a customer (customer_users auth, NOT in
-- `users`) has current_tenant_id() = NULL, so the UPDATE matched 0 rows. The
-- page showed a success toast anyway → the customer believed auto-renew was
-- toggled when nothing changed (a silent trust bug).
--
-- FIX: a SECURITY DEFINER RPC scoped to current_customer_id() that updates
-- ONLY auto_renew on a subscription the caller actually owns. We intentionally
-- do NOT add a broad customer UPDATE policy on subscriptions — that would let a
-- customer edit seats / mrr / renewal_date too. The RPC is the narrow seam.

create or replace function public.set_subscription_auto_renew(p_sub_id uuid, p_value boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cust    uuid := public.current_customer_id();
  v_updated integer;
begin
  if v_cust is null then
    raise exception 'No customer context' using errcode = 'insufficient_privilege';
  end if;

  update public.subscriptions
     set auto_renew = coalesce(p_value, false)
   where id = p_sub_id
     and customer_id = v_cust;
  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    raise exception 'Subscription % not found for this customer', p_sub_id
      using errcode = 'no_data_found';
  end if;

  return coalesce(p_value, false);
end;
$$;

grant execute on function public.set_subscription_auto_renew(uuid, boolean) to authenticated, service_role;
