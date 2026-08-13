begin;

alter table public.vault_passwords  enable row level security;
alter table public.vault_access_log enable row level security;

-- current_tenant_id(), NOT auth.jwt() — see correction 2 in the header.
create policy "vault_passwords_select" on public.vault_passwords
  for select to authenticated using (tenant_id = public.current_tenant_id());
create policy "vault_passwords_insert" on public.vault_passwords
  for insert to authenticated with check (tenant_id = public.current_tenant_id());
create policy "vault_passwords_update" on public.vault_passwords
  for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());
create policy "vault_passwords_delete" on public.vault_passwords
  for delete to authenticated using (tenant_id = public.current_tenant_id());

-- Column-level grants: the browser can list the vault but cannot read a
-- ciphertext column at all. `select *` from a client ERRORS, which is the point.
revoke select on public.vault_passwords from authenticated;
grant select (
  id, tenant_id, customer_id, title, category, url,
  password_fingerprint, last_rotated_at, created_by, created_at, updated_at
) on public.vault_passwords to authenticated;

-- Writes still need the ciphertext columns, and those go through a server route
-- holding the master key; insert/update privileges stay whole.
grant insert, update, delete on public.vault_passwords to authenticated;

-- ── Access log: readable by the workspace, appendable, NEVER editable. ────
create policy "vault_access_log_select" on public.vault_access_log
  for select to authenticated using (tenant_id = public.current_tenant_id());
create policy "vault_access_log_insert" on public.vault_access_log
  for insert to authenticated with check (tenant_id = public.current_tenant_id());
-- No update policy and no delete policy exist, deliberately. Belt and braces:
revoke update, delete on public.vault_access_log from authenticated;
revoke update, delete on public.vault_access_log from anon;

commit;
