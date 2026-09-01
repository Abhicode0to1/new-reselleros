-- Teammate ki `users` row DELETE karna ab sirf OWNER kar sakta hai — aur
-- users table par audit trigger lagta hai.
--
-- 1 Sep 2026 ke audit ka #4 khatra: `users_tenant_delete` ki policy
-- `tenant_id = current_tenant_id()` bhar thi — matlab KOI BHI tenant-member
-- (sales/support/delivery) kisi ki bhi row — OWNER samet — delete kar sakta
-- tha. Aur users par koi activity-trigger nahi tha, to naraz staff owner ko
-- hata deta aur database me koi jawab nahi hota "kisne kiya".
--
-- Do badlav:
--   1. DELETE owner-only, aur apni row kabhi nahi (aakhri-owner ka tala).
--   2. `log_row_change()` ka trigger users par — role-change/DELETE ab
--      activity_log me dikhte hain (browser-raaste par; service-role ka
--      auth.uid() null hota hai, wo chhed alag darj hai — audit item C).

-- Helper: kya bulane wala apne tenant ka OWNER hai?
-- SECURITY DEFINER isliye ki policy khud users ko padhti hai — bina iske
-- RLS ke andar RLS ka chakkar banta.
create or replace function public.current_user_is_owner()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.role = 'owner' and u.is_active
  );
$$;

revoke all on function public.current_user_is_owner() from public;
grant execute on function public.current_user_is_owner() to authenticated;

drop policy if exists users_tenant_delete on public.users;
create policy users_tenant_delete on public.users
  for delete to authenticated
  using (
    tenant_id = public.current_tenant_id()
    and public.current_user_is_owner()
    and id <> auth.uid()
  );

-- Audit: wahi trigger jo 12 doosri tables par pehle se hai.
drop trigger if exists users_activity on public.users;
create trigger users_activity
  after insert or update or delete on public.users
  for each row execute function public.log_row_change();
