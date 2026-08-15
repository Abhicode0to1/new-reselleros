-- 0174_delete_customer_full_document_guard.sql
-- ============================================================================
-- delete_customer — extend the guard to FULL Zoho-Books parity.
--
-- 0077 blocked delete only when a customer had subscriptions, payments, or
-- invoices. But quotes and projects are also real *documents* linked to the
-- customer (quotes.customer_id / project_sales.customer_id, both ON DELETE SET
-- NULL), so deleting the customer silently orphaned them (link → null). Zoho refuses to
-- delete a customer that has ANY transaction/document; you must remove those
-- first or mark the customer inactive (we offer "Archive").
--
-- New rule: a customer can be hard-deleted ONLY when it is truly empty — no
-- subscriptions, payments, invoices, quotes, or projects. Otherwise raise a
-- clear, itemised error (the UI turns this into "delete those first, or archive").
--
-- Rolled-back test (0174): empty customer → deletes; customer with only a quote
-- → blocked; customer with only a project → blocked.
-- ============================================================================

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
  v_quotes      integer;
  v_projs       integer;
  v_name        text;
  v_parts       text[] := array[]::text[];
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

  select count(*) into v_subs   from public.subscriptions where customer_id = p_customer_id;
  select count(*) into v_pays   from public.payments      where customer_id = p_customer_id;
  select count(*) into v_invs   from public.invoices      where customer_id = p_customer_id;
  select count(*) into v_quotes from public.quotes        where customer_id = p_customer_id;
  select count(*) into v_projs  from public.project_sales where customer_id = p_customer_id;

  if v_subs   > 0 then v_parts := v_parts || format('%s subscription(s)', v_subs); end if;
  if v_pays   > 0 then v_parts := v_parts || format('%s payment(s)',      v_pays);  end if;
  if v_invs   > 0 then v_parts := v_parts || format('%s invoice(s)',      v_invs);  end if;
  if v_quotes > 0 then v_parts := v_parts || format('%s quote(s)',        v_quotes);end if;
  if v_projs  > 0 then v_parts := v_parts || format('%s project(s)',      v_projs); end if;

  if array_length(v_parts, 1) is not null then
    raise exception
      'Cannot delete customer "%": has %. Delete those first, or archive the customer instead.',
      v_name, array_to_string(v_parts, ', ');
  end if;

  -- Truly empty customer — safe to remove. Any linked tasks / domains / portal
  -- logins cascade.
  delete from public.customers where id = p_customer_id and tenant_id = v_tenant;

  return jsonb_build_object('deleted', true, 'customer_id', p_customer_id);
end;
$function$;
