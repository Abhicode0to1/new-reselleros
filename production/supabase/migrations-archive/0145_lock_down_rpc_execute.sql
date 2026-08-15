-- 0145: SECURITY — lock down EXECUTE on all SECURITY DEFINER functions.
--
-- P0 fix. Supabase grants EXECUTE to PUBLIC (incl. the public `anon` key) by
-- default on every function. Our SECURITY DEFINER money/admin RPCs
-- (record_payment, generate_invoice, delete_payment, pay_salary,
-- next_document_number, …) were therefore callable UNAUTHENTICATED with just the
-- public anon key — and several skip their tenant check when current_tenant_id()
-- is NULL (the anon path), enabling cross-tenant writes / invoice-series burning.
--
-- Fix = deny-by-default: revoke EXECUTE from PUBLIC + anon on every SECURITY
-- DEFINER function, grant only to `authenticated` (app users) and `service_role`
-- (webhooks/crons/public API routes use the admin/service-role client). Keep
-- `anon` ONLY on the handful genuinely called from an unauthenticated context
-- with the anon client — verified by grepping every (public)/api-public/portal/
-- kiosk route: exactly these four.
--
-- Internal function→function calls are unaffected (they run as the definer).
-- Trigger firing does not check EXECUTE, so trigger functions are safe too.

do $$
declare
  r record;
  v_anon_ok text[] := array[
    'mark_attendance',        -- kiosk, self-auth via bcrypt PIN (anon client)
    'portal_customer_exists', -- portal login, called BEFORE the session exists
    'portal_list_products',   -- portal shop (anon client)
    'portal_request_quote'    -- portal shop (anon client)
  ];
begin
  for r in
    select p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prosecdef = true
  loop
    execute format('revoke execute on function public.%I(%s) from public, anon', r.proname, r.args);
    execute format('grant  execute on function public.%I(%s) to authenticated',  r.proname, r.args);
    execute format('grant  execute on function public.%I(%s) to service_role',   r.proname, r.args);
    if r.proname = any(v_anon_ok) then
      execute format('grant execute on function public.%I(%s) to anon', r.proname, r.args);
    end if;
  end loop;
end $$;

-- Prevent recurrence: new functions no longer auto-grant EXECUTE to PUBLIC.
-- (Our migrations already grant explicitly to authenticated where needed.)
alter default privileges in schema public revoke execute on functions from public;
