-- 0067_portal_ensure_customer_link.sql
-- Portal sign-in moved from magic-LINK to 6-digit OTP CODE (verifyOtp).
--
-- Why: Gmail / Google Workspace mail scanners pre-fetch links in email for
-- security ("safe browsing"). A Supabase magic link's token is SINGLE-USE, so
-- the scanner's GET to /verify burns it before the customer clicks — the real
-- click then hits "One-time token not found / link invalid or expired"
-- (observed in prod: GET /verify 303 then 403 from Google IP 172.253.192.242).
-- Most Indian SME customers are on Gmail/Workspace, so this broke login broadly.
--
-- The OTP-code flow has NO clickable link, so there is nothing for a scanner to
-- consume. verifyOtp() runs client-side and sets the session — but linking the
-- auth user to their customer row needs service-role (the new user has no
-- customer_users row yet, so RLS blocks reading customers). The old magic-link
-- callback route did that with the admin client; this RPC replaces it for the
-- code flow: SECURITY DEFINER, but it ONLY ever links auth.uid() to a customer
-- matching THAT user's own email — no cross-user surface. Idempotent.
--
-- Returns: 'linked' | 'already' | 'no_customer' | 'no_auth'

create or replace function public.portal_ensure_customer_link()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid          uuid := auth.uid();
  v_email        text;
  v_customer_id  uuid;
  v_tenant_id    uuid;
begin
  if v_uid is null then
    return 'no_auth';
  end if;

  select email into v_email from auth.users where id = v_uid;
  if v_email is null or length(trim(v_email)) = 0 then
    return 'no_auth';
  end if;

  -- Already linked? (unique on auth_user_id) — idempotent, refresh last_login.
  if exists (select 1 from public.customer_users where auth_user_id = v_uid) then
    update public.customer_users set last_login_at = now() where auth_user_id = v_uid;
    return 'already';
  end if;

  -- Match a customer by email (case-insensitive), same as the login pre-check.
  select id, tenant_id into v_customer_id, v_tenant_id
    from public.customers
   where lower(contact_email) = lower(trim(v_email))
   limit 1;

  if v_customer_id is null then
    return 'no_customer';
  end if;

  insert into public.customer_users
    (tenant_id, customer_id, auth_user_id, email, role, last_login_at)
  values
    (v_tenant_id, v_customer_id, v_uid, v_email, 'admin', now());

  return 'linked';
end;
$$;

grant execute on function public.portal_ensure_customer_link() to authenticated;
