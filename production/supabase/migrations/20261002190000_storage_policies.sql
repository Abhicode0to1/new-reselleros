-- ============================================================================
-- Storage policies on production — 2 Oct 2026.
--
-- Pardeep: "Logo update failed: new row violates row-level security policy".
-- Measured on production (Cloud SQL, self-hosted storage): storage.objects has RLS on and
-- ZERO policies, and no role has BYPASSRLS (Cloud SQL does not grant it — the reason every
-- public table carries a zzz_service_role_all policy). So EVERY upload failed: logos, bill
-- and receipt attachments, the documents vault, TDS certificates, attendance selfies,
-- employee documents. The policies below are the ones the archive migrations created on
-- the old hosted project (0015, 0090, 0107, 0112, employee-docs), which never reached the
-- new database at the 6 Sep cut-over, plus the service-role policy server routes need.
--
-- storage.objects is owned by supabase_storage_admin, so this runs as that role
-- (production: imported as postgres, a member of it; local: as supabase_admin). That role
-- needs USAGE on public and EXECUTE on current_tenant_id() to write the tenant condition —
-- granted first, nothing broader. Names match the archive policies, so local and
-- production end up with the same set. Idempotent.
-- Every tenant policy is folder-scoped: the first path segment is the tenant id.
-- ============================================================================
begin;

grant usage on schema public to supabase_storage_admin;
grant execute on function public.current_tenant_id() to supabase_storage_admin;

set local role supabase_storage_admin;

drop policy if exists "att selfies read" on storage.objects;
create policy "att selfies read" on storage.objects for select to authenticated using (bucket_id = 'attendance-selfies' and ((storage.foldername(name))[1] = ((select public.current_tenant_id()))::text));
drop policy if exists "att selfies insert" on storage.objects;
create policy "att selfies insert" on storage.objects for insert to authenticated with check (bucket_id = 'attendance-selfies' and ((storage.foldername(name))[1] = ((select public.current_tenant_id()))::text));
drop policy if exists "att selfies update" on storage.objects;
create policy "att selfies update" on storage.objects for update to authenticated using (bucket_id = 'attendance-selfies' and ((storage.foldername(name))[1] = ((select public.current_tenant_id()))::text)) with check (bucket_id = 'attendance-selfies' and ((storage.foldername(name))[1] = ((select public.current_tenant_id()))::text));
drop policy if exists "documents_select_own_tenant" on storage.objects;
create policy "documents_select_own_tenant" on storage.objects for select to public using (bucket_id = 'documents' and ((storage.foldername(name))[1] = ((select public.current_tenant_id()))::text));
drop policy if exists "documents_insert_own_tenant" on storage.objects;
create policy "documents_insert_own_tenant" on storage.objects for insert to public with check (bucket_id = 'documents' and ((storage.foldername(name))[1] = ((select public.current_tenant_id()))::text));
drop policy if exists "documents_update_own_tenant" on storage.objects;
create policy "documents_update_own_tenant" on storage.objects for update to public using (bucket_id = 'documents' and ((storage.foldername(name))[1] = ((select public.current_tenant_id()))::text)) with check (bucket_id = 'documents' and ((storage.foldername(name))[1] = ((select public.current_tenant_id()))::text));
drop policy if exists "documents_delete_own_tenant" on storage.objects;
create policy "documents_delete_own_tenant" on storage.objects for delete to public using (bucket_id = 'documents' and ((storage.foldername(name))[1] = ((select public.current_tenant_id()))::text));
drop policy if exists "employee-docs tenant read" on storage.objects;
create policy "employee-docs tenant read" on storage.objects for select to authenticated using (bucket_id = 'employee-docs' and ((storage.foldername(name))[1] = ((select public.current_tenant_id()))::text));
drop policy if exists "employee-docs tenant insert" on storage.objects;
create policy "employee-docs tenant insert" on storage.objects for insert to authenticated with check (bucket_id = 'employee-docs' and ((storage.foldername(name))[1] = ((select public.current_tenant_id()))::text));
drop policy if exists "employee-docs tenant delete" on storage.objects;
create policy "employee-docs tenant delete" on storage.objects for delete to authenticated using (bucket_id = 'employee-docs' and ((storage.foldername(name))[1] = ((select public.current_tenant_id()))::text));
drop policy if exists "logos_insert_own_tenant" on storage.objects;
create policy "logos_insert_own_tenant" on storage.objects for insert to public with check (bucket_id = 'logos' and ((storage.foldername(name))[1] = ((select public.current_tenant_id()))::text));
drop policy if exists "logos_update_own_tenant" on storage.objects;
create policy "logos_update_own_tenant" on storage.objects for update to public using (bucket_id = 'logos' and ((storage.foldername(name))[1] = ((select public.current_tenant_id()))::text)) with check (bucket_id = 'logos' and ((storage.foldername(name))[1] = ((select public.current_tenant_id()))::text));
drop policy if exists "logos_delete_own_tenant" on storage.objects;
create policy "logos_delete_own_tenant" on storage.objects for delete to public using (bucket_id = 'logos' and ((storage.foldername(name))[1] = ((select public.current_tenant_id()))::text));
drop policy if exists "tds_cert_select_own_tenant" on storage.objects;
create policy "tds_cert_select_own_tenant" on storage.objects for select to public using (bucket_id = 'tds-certificates' and ((storage.foldername(name))[1] = ((select public.current_tenant_id()))::text));
drop policy if exists "tds_cert_insert_own_tenant" on storage.objects;
create policy "tds_cert_insert_own_tenant" on storage.objects for insert to public with check (bucket_id = 'tds-certificates' and ((storage.foldername(name))[1] = ((select public.current_tenant_id()))::text));
drop policy if exists "tds_cert_update_own_tenant" on storage.objects;
create policy "tds_cert_update_own_tenant" on storage.objects for update to public using (bucket_id = 'tds-certificates' and ((storage.foldername(name))[1] = ((select public.current_tenant_id()))::text)) with check (bucket_id = 'tds-certificates' and ((storage.foldername(name))[1] = ((select public.current_tenant_id()))::text));
drop policy if exists "tds_cert_delete_own_tenant" on storage.objects;
create policy "tds_cert_delete_own_tenant" on storage.objects for delete to public using (bucket_id = 'tds-certificates' and ((storage.foldername(name))[1] = ((select public.current_tenant_id()))::text));

/* Server routes write with the service key (logo, bill / receipt attachments, inbound
   mail). Without BYPASSRLS that role needs a policy, like every public table has. */
drop policy if exists zzz_service_role_all on storage.objects;
create policy zzz_service_role_all on storage.objects as permissive for all to service_role using (true) with check (true);

reset role;
commit;
