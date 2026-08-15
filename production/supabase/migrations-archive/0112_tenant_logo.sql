-- 0112: company logo — a public, tenant-foldered image shown across the app
-- (sidebar, customer-facing enquiry / quote pages, and later PDFs).
--
-- The logo must render on NO-AUTH customer pages, so the bucket is PUBLIC
-- (read via the public URL, no signed link). Writes are tenant-scoped.

alter table public.tenants add column if not exists logo_url text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('logos', 'logos', true, 5242880,
        array['image/png','image/jpeg','image/webp','image/svg+xml'])
on conflict (id) do nothing;

-- Writes limited to the tenant's own folder; reads are public (bucket public).
drop policy if exists logos_insert_own_tenant on storage.objects;
create policy logos_insert_own_tenant on storage.objects for insert
  with check (bucket_id = 'logos' and (storage.foldername(name))[1] = public.current_tenant_id()::text);

drop policy if exists logos_update_own_tenant on storage.objects;
create policy logos_update_own_tenant on storage.objects for update
  using (bucket_id = 'logos' and (storage.foldername(name))[1] = public.current_tenant_id()::text);

drop policy if exists logos_delete_own_tenant on storage.objects;
create policy logos_delete_own_tenant on storage.objects for delete
  using (bucket_id = 'logos' and (storage.foldername(name))[1] = public.current_tenant_id()::text);
