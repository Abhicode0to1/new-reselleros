begin;

alter table public.email_log enable row level security;

-- Read-only to the tenant. There is no insert/update/delete policy on purpose:
-- rows are written by the server with the service-role key, and a log the
-- subject of the log can edit is not evidence of anything.
drop policy if exists "email_log_select" on public.email_log;
create policy "email_log_select" on public.email_log
  for select using (tenant_id = public.current_tenant_id());

commit;
