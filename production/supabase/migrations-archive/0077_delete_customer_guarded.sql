-- 0077_delete_customer_guarded.sql
-- ============================================================
-- delete_customer(p_customer_id) — safe, guarded customer delete.
--
-- WHY AN RPC: subscriptions.customer_id is ON DELETE CASCADE (0001_init.sql),
-- so a raw `delete from customers` would silently wipe the customer's
-- subscriptions (recurring revenue + renewal tracking). This function refuses
-- to delete any customer that still has money history — subscriptions,
-- payments, or invoices. Only an "empty" customer (a mistake / duplicate / test
-- record) can be removed. Tenant-scoped; SECURITY DEFINER so the check can't be
-- bypassed from the client.
-- ============================================================

create or replace function public.delete_customer(p_customer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant      uuid;
  v_caller      uuid;
  v_is_service  boolean;
  v_subs        integer;
  v_pays        integer;
  v_invs        integer;
  v_name        text;
begin
  v_is_service := auth.role() = 'service_role';

  select tenant_id, name into v_tenant, v_name
    from public.customers where id = p_customer_id;
  if not found then
    raise exception 'customer % not found', p_customer_id;
  end if;

  if not v_is_service then
    v_caller := public.current_tenant_id();
    if v_caller is null or v_caller <> v_tenant then
      raise exception 'customer % does not belong to your tenant', p_customer_id;
    end if;
  end if;

  select count(*) into v_subs from public.subscriptions where customer_id = p_customer_id;
  select count(*) into v_pays from public.payments      where customer_id = p_customer_id;
  select count(*) into v_invs from public.invoices      where customer_id = p_customer_id;

  if v_subs > 0 or v_pays > 0 or v_invs > 0 then
    raise exception
      'Cannot delete customer "%": has % subscription(s), % payment(s), % invoice(s). Only customers with no money history can be deleted.',
      v_name, v_subs, v_pays, v_invs;
  end if;

  -- Empty customer — safe to remove. Any linked tasks / domains / portal logins
  -- cascade; stray quotes (no money) detach via ON DELETE SET NULL.
  delete from public.customers where id = p_customer_id and tenant_id = v_tenant;

  return jsonb_build_object('deleted', true, 'customer_id', p_customer_id);
end;
$function$;
