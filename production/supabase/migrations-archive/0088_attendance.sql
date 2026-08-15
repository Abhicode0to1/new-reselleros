-- 0088: Attendance — office kiosk + PIN.
--
-- The office keeps one shared device (tablet/phone) logged into ResellerOS on
-- the kiosk page. Each employee taps their name and enters a 4–6 digit PIN to
-- check in / out. Because the device physically sits in the office, "present
-- at office" is guaranteed by the device's location — no GPS needed (and no
-- GPS spoofing risk). PINs are bcrypt-hashed (pgcrypto), never stored raw.
--
-- Attendance feeds payroll: days absent (no attendance + no paid leave, Sundays
-- off) are suggested as Loss of Pay in the salary run.

create extension if not exists pgcrypto with schema extensions;

alter table public.employees add column if not exists pin_hash text;

create table if not exists public.attendance (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  work_date   date not null,
  check_in    timestamptz,
  check_out   timestamptz,
  source      text not null default 'kiosk',
  created_at  timestamptz not null default now(),
  unique (tenant_id, employee_id, work_date)
);

create index if not exists attendance_tenant_date_idx on public.attendance(tenant_id, work_date);

alter table public.attendance enable row level security;
drop policy if exists "tenant isolation read"   on public.attendance;
drop policy if exists "tenant isolation write"  on public.attendance;
drop policy if exists "tenant isolation update" on public.attendance;
drop policy if exists "tenant isolation delete" on public.attendance;
create policy "tenant isolation read"   on public.attendance for select using  (tenant_id = public.current_tenant_id());
create policy "tenant isolation write"  on public.attendance for insert with check (tenant_id = public.current_tenant_id());
create policy "tenant isolation update" on public.attendance for update using  (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id());
create policy "tenant isolation delete" on public.attendance for delete using  (tenant_id = public.current_tenant_id());

-- ── Owner sets / resets an employee's PIN (hashed) ──────────────────────────
create or replace function public.set_employee_pin(
  p_employee_id uuid,
  p_pin         text
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then
    raise exception 'PIN must be 4 to 6 digits';
  end if;
  update public.employees
     set pin_hash = crypt(p_pin, gen_salt('bf')), updated_at = now()
   where id = p_employee_id and tenant_id = v_tenant;
  if not found then raise exception 'Employee not found'; end if;
end;
$$;

grant execute on function public.set_employee_pin(uuid, text) to authenticated;

-- ── Kiosk: verify PIN, toggle check-in / check-out for today (IST) ──────────
create or replace function public.mark_attendance(
  p_employee_id uuid,
  p_pin         text
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
    insert into public.attendance (tenant_id, employee_id, work_date, check_in, source)
    values (v_tenant, p_employee_id, v_date, now(), 'kiosk');
    return 'checked_in';
  elsif v_row.check_out is null then
    update public.attendance set check_out = now() where id = v_row.id;
    return 'checked_out';
  else
    return 'already_done';
  end if;
end;
$$;

grant execute on function public.mark_attendance(uuid, text) to authenticated;
