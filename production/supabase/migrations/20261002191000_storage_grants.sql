-- ============================================================================
-- Storage privileges on production — 2 Oct 2026 (follow-up to 20261002190000).
--
-- The logo upload still failed after the policies went in. Probed on production:
-- anon / authenticated / service_role had NO usage on schema storage and no rights on its
-- tables (local and hosted Supabase grant them). storage-api reports Postgres 42501 —
-- "permission denied" — as "new row violates row-level security policy", which is why the
-- message never changed. These are the standard Supabase storage grants; row access stays
-- with RLS (the tenant-folder policies of 20261002190000).
--
-- Also storage.buckets: RLS is on with no policy, and Cloud SQL gives no role BYPASSRLS,
-- so the service role could not see a bucket at all. Service role gets full access (as on
-- every table); signed-in users may READ bucket rows (id, public flag, limits — no files).
--
-- Runs as supabase_storage_admin, the owner (prod: imported as postgres; local:
-- supabase_admin). Idempotent; tables that a storage version does not have are skipped.
-- ============================================================================
begin;
set local role supabase_storage_admin;

grant usage on schema storage to anon, authenticated, service_role;

/* And the buckets themselves: production had NONE (and no objects) — storage was never
   set up after the 6 Sep cut-over, so no file had ever been stored there. Same six as the
   local / old hosted project, same public flag, size limit and file types. */
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('attendance-selfies', 'attendance-selfies', false, null, null),
  ('documents', 'documents', false, 20971520, array['application/pdf','image/jpeg','image/png','image/webp','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/plain','application/zip']),
  ('employee-docs', 'employee-docs', false, null, null),
  ('expense-receipts', 'expense-receipts', false, null, null),
  ('logos', 'logos', true, 5242880, array['image/png','image/jpeg','image/webp']),
  ('tds-certificates', 'tds-certificates', false, 10485760, array['application/pdf','image/jpeg','image/png'])
on conflict (id) do nothing;

do $$
declare t text;
begin
  foreach t in array array['objects', 'buckets'] loop
    if to_regclass('storage.' || t) is not null then
      execute format('grant all on storage.%I to anon, authenticated, service_role', t);
    end if;
  end loop;
  foreach t in array array['s3_multipart_uploads', 's3_multipart_uploads_parts', 'prefixes'] loop
    if to_regclass('storage.' || t) is not null then
      execute format('grant all on storage.%I to service_role', t);
      execute format('grant select on storage.%I to anon, authenticated', t);
    end if;
  end loop;
end $$;

grant usage, select on all sequences in schema storage to anon, authenticated, service_role;
grant execute on all functions in schema storage to anon, authenticated, service_role;

drop policy if exists zzz_service_role_all on storage.buckets;
create policy zzz_service_role_all on storage.buckets as permissive for all to service_role using (true) with check (true);
drop policy if exists "buckets read signed in" on storage.buckets;
create policy "buckets read signed in" on storage.buckets for select to authenticated using (true);

reset role;
commit;
