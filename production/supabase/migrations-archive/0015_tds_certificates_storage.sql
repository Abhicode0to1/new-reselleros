-- ============================================================
-- TDS certificates storage bucket — Form 16A PDFs
-- Migration: 0015_tds_certificates_storage.sql
-- ============================================================
-- Single private bucket `tds-certificates`. Files namespaced by tenant_id
-- prefix: {tenant_id}/{tds_id}/{filename}. RLS only allows the matching
-- tenant to read/write their own folder.
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'tds-certificates',
  'tds-certificates',
  false,
  10485760,
  array['application/pdf','image/jpeg','image/png']
)
on conflict (id) do nothing;

drop policy if exists tds_cert_select_own_tenant on storage.objects;
create policy tds_cert_select_own_tenant
  on storage.objects for select
  using (
    bucket_id = 'tds-certificates'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );

drop policy if exists tds_cert_insert_own_tenant on storage.objects;
create policy tds_cert_insert_own_tenant
  on storage.objects for insert
  with check (
    bucket_id = 'tds-certificates'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );

drop policy if exists tds_cert_update_own_tenant on storage.objects;
create policy tds_cert_update_own_tenant
  on storage.objects for update
  using (
    bucket_id = 'tds-certificates'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );

drop policy if exists tds_cert_delete_own_tenant on storage.objects;
create policy tds_cert_delete_own_tenant
  on storage.objects for delete
  using (
    bucket_id = 'tds-certificates'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );
