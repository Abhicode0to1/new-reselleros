-- 0107: Company Document Vault — one secure place for business documents.
--
-- Store GST certificate, PAN, incorporation, agreements, licenses, HR docs etc.
-- Files live in a PRIVATE, tenant-foldered storage bucket; metadata (title,
-- category, expiry) in the documents table. Optional expiry_date powers
-- "expiring soon / expired" reminders (licenses, registrations).

create table if not exists public.documents (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  title        text not null,
  category     text not null default 'other'
    check (category in ('company_legal','gst_tax','banking','agreements','licenses','hr','other')),
  file_path    text not null,          -- storage path: {tenant_id}/{uuid}-{name}
  file_name    text,
  mime_type    text,
  size_bytes   bigint,
  expiry_date  date,                    -- nullable — set for licenses/certs that renew
  notes        text,
  uploaded_by  uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_documents_tenant   on public.documents(tenant_id);
create index if not exists idx_documents_expiry    on public.documents(expiry_date) where expiry_date is not null;

alter table public.documents enable row level security;

drop policy if exists documents_tenant on public.documents;
create policy documents_tenant on public.documents
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- ── Private storage bucket, tenant-foldered ──────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documents',
  'documents',
  false,
  20971520,   -- 20 MB
  array[
    'application/pdf','image/jpeg','image/png','image/webp',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain','application/zip'
  ]
)
on conflict (id) do nothing;

drop policy if exists documents_select_own_tenant on storage.objects;
create policy documents_select_own_tenant on storage.objects for select
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = public.current_tenant_id()::text);

drop policy if exists documents_insert_own_tenant on storage.objects;
create policy documents_insert_own_tenant on storage.objects for insert
  with check (bucket_id = 'documents' and (storage.foldername(name))[1] = public.current_tenant_id()::text);

drop policy if exists documents_update_own_tenant on storage.objects;
create policy documents_update_own_tenant on storage.objects for update
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = public.current_tenant_id()::text);

drop policy if exists documents_delete_own_tenant on storage.objects;
create policy documents_delete_own_tenant on storage.objects for delete
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = public.current_tenant_id()::text);
