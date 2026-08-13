begin;

alter table public.access_credentials enable row level security;

create policy "access_credentials_select" on public.access_credentials
  for select to authenticated using (tenant_id = public.current_tenant_id());
create policy "access_credentials_insert" on public.access_credentials
  for insert to authenticated with check (tenant_id = public.current_tenant_id());
create policy "access_credentials_update" on public.access_credentials
  for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());
create policy "access_credentials_delete" on public.access_credentials
  for delete to authenticated using (tenant_id = public.current_tenant_id());

commit;
