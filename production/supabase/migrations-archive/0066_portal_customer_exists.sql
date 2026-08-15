-- 0066_portal_customer_exists.sql
-- Public existence check so the portal login page can tell a non-customer
-- IMMEDIATELY (on submit) instead of after they request + open + click a magic
-- link only to hit "no_customer". Also avoids a wasted email + an orphan
-- auth.users row (signInWithOtp has shouldCreateUser:true).
--
-- Returns true if ANY customer has this contact_email (case-insensitive),
-- matching the callback's tenant-agnostic lookup. Callable by anon (login page
-- is unauthenticated). This reveals customer-email existence — acceptable here
-- because the post-click flow already surfaces it; the win is doing it up front.

create or replace function public.portal_customer_exists(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.customers
     where p_email is not null
       and length(trim(p_email)) > 0
       and lower(contact_email) = lower(trim(p_email))
  );
$$;

grant execute on function public.portal_customer_exists(text) to anon, authenticated, service_role;
