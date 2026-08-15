-- 0090: Attendance selfies — deter buddy-punching.
--
-- On check-in / check-out the kiosk captures a photo from the device camera.
-- Photos live in a PRIVATE storage bucket, foldered by tenant, and the path is
-- stored on the attendance row. Only the tenant's authenticated users can read
-- them (via short-lived signed URLs). Capturing a face makes it hard for one
-- employee to punch in for another.

alter table public.attendance add column if not exists selfie_in  text;
alter table public.attendance add column if not exists selfie_out text;

insert into storage.buckets (id, name, public)
values ('attendance-selfies', 'attendance-selfies', false)
on conflict (id) do nothing;

drop policy if exists "att selfies read"   on storage.objects;
drop policy if exists "att selfies insert" on storage.objects;
drop policy if exists "att selfies update" on storage.objects;

create policy "att selfies read" on storage.objects for select to authenticated
  using (bucket_id = 'attendance-selfies' and (storage.foldername(name))[1] = public.current_tenant_id()::text);
create policy "att selfies insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'attendance-selfies' and (storage.foldername(name))[1] = public.current_tenant_id()::text);
create policy "att selfies update" on storage.objects for update to authenticated
  using (bucket_id = 'attendance-selfies' and (storage.foldername(name))[1] = public.current_tenant_id()::text)
  with check (bucket_id = 'attendance-selfies' and (storage.foldername(name))[1] = public.current_tenant_id()::text);
