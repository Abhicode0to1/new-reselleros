-- 0089: Attendance security — office-network (IP) allowlist + audit.
--
-- Marking is gated server-side (an API route reads the REAL client IP from the
-- Cloud Run x-forwarded-for header — the client cannot forge it) against a
-- per-tenant allowlist of the office's public IP(s). If the allowlist is empty
-- the gate is OFF (opt-in). Every mark also logs the IP it came from.
--
-- Honest limits (documented for the operator): a dynamic office IP may need
-- re-locking; a VPN can spoof the source; and IP does not stop buddy-punching
-- (that needs a photo/biometric). Good enough to stop off-site marking.

create table if not exists public.attendance_settings (
  tenant_id   uuid primary key references public.tenants(id) on delete cascade,
  allowed_ips text[] not null default '{}',
  updated_at  timestamptz not null default now()
);

alter table public.attendance_settings enable row level security;
drop policy if exists "tenant isolation read"   on public.attendance_settings;
drop policy if exists "tenant isolation write"  on public.attendance_settings;
drop policy if exists "tenant isolation update" on public.attendance_settings;
create policy "tenant isolation read"   on public.attendance_settings for select using  (tenant_id = public.current_tenant_id());
create policy "tenant isolation write"  on public.attendance_settings for insert with check (tenant_id = public.current_tenant_id());
create policy "tenant isolation update" on public.attendance_settings for update using  (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id());

alter table public.attendance add column if not exists marked_ip text;

-- Extend mark_attendance to record the (server-supplied) source IP.
drop function if exists public.mark_attendance(uuid, text);
create or replace function public.mark_attendance(
  p_employee_id uuid,
  p_pin         text,
  p_ip          text default null
) returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_hash   text;
  v_active boolean;
  v_date   date := (now() at time zone 'Asia/Kolkata')::date;
  v_row    public.attendance;
begin
  select pin_hash, is_active into v_hash, v_active from public.employees
    where id = p_employee_id and tenant_id = v_tenant;
  if not found then raise exception 'Employee not found'; end if;
  if not coalesce(v_active, false) then raise exception 'Employee is inactive'; end if;
  if v_hash is null then raise exception 'No PIN set — ask the owner to set your PIN'; end if;
  if p_pin is null or crypt(p_pin, v_hash) <> v_hash then raise exception 'Wrong PIN'; end if;

  select * into v_row from public.attendance
    where tenant_id = v_tenant and employee_id = p_employee_id and work_date = v_date;

  if not found then
    insert into public.attendance (tenant_id, employee_id, work_date, check_in, source, marked_ip)
    values (v_tenant, p_employee_id, v_date, now(), 'kiosk', p_ip);
    return 'checked_in';
  elsif v_row.check_out is null then
    update public.attendance set check_out = now(), marked_ip = coalesce(p_ip, marked_ip) where id = v_row.id;
    return 'checked_out';
  else
    return 'already_done';
  end if;
end;
$$;

grant execute on function public.mark_attendance(uuid, text, text) to authenticated;
