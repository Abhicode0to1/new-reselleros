-- Month-end close checklist — the ticks that can't be computed (27 Sep 2026).
--
-- Most of the checklist is read straight from the books (bank lines reconciled,
-- salaries run, challans booked, GST paid, books locked). A few steps happen outside
-- the app — "GSTR-1 filed on the portal", "24Q filed" — and those are recorded here:
-- one row per company, month and step, with who ticked it and when. Unticking deletes
-- the row, so the table only ever says what is currently true.

create table if not exists public.month_close_checks (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  period     text not null check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  key        text not null check (char_length(key) <= 40),
  note       text check (note is null or char_length(note) <= 500),
  done_by    uuid references public.users(id) on delete set null,
  done_at    timestamptz not null default now(),
  unique (tenant_id, period, key)
);

alter table public.month_close_checks enable row level security;

drop policy if exists "tenant isolation read" on public.month_close_checks;
create policy "tenant isolation read" on public.month_close_checks
  for select to authenticated using (tenant_id = public.current_tenant_id());
drop policy if exists "tenant isolation write" on public.month_close_checks;
create policy "tenant isolation write" on public.month_close_checks
  for insert to authenticated with check (tenant_id = public.current_tenant_id());
drop policy if exists "tenant isolation delete" on public.month_close_checks;
create policy "tenant isolation delete" on public.month_close_checks
  for delete to authenticated using (tenant_id = public.current_tenant_id());
drop policy if exists zzz_service_role_all on public.month_close_checks;
create policy zzz_service_role_all on public.month_close_checks
  as permissive for all to service_role using (true) with check (true);

create index if not exists month_close_checks_period_idx on public.month_close_checks (tenant_id, period);
