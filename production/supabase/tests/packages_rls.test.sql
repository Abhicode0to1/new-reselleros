-- Packages (20261002170000): owner/manager write, everyone in the tenant reads, nobody
-- crosses tenants. Rolled back; safe anywhere. Exit 0 = pass.
begin;

insert into public.tenants (id, name, email, state_code) values
  ('bbbbbbbb-0000-0000-0000-0000000170a0', 'PKG A', 'pkg-a@example.in', '07'),
  ('bbbbbbbb-0000-0000-0000-0000000170b0', 'PKG B', 'pkg-b@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('bbbbbbbb-0000-0000-0000-0000000170a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pkg-owner@example.in'),
  ('bbbbbbbb-0000-0000-0000-0000000170a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pkg-rep@example.in'),
  ('bbbbbbbb-0000-0000-0000-0000000170b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pkg-other@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('bbbbbbbb-0000-0000-0000-0000000170a1', 'bbbbbbbb-0000-0000-0000-0000000170a0', 'pkg-owner@example.in', 'owner'),
  ('bbbbbbbb-0000-0000-0000-0000000170a2', 'bbbbbbbb-0000-0000-0000-0000000170a0', 'pkg-rep@example.in', 'sales'),
  ('bbbbbbbb-0000-0000-0000-0000000170b1', 'bbbbbbbb-0000-0000-0000-0000000170b0', 'pkg-other@example.in', 'owner');
insert into public.items (id, tenant_id, name, vendor, msrp, wholesale, kind, item_type) values
  ('PKG-GW-A', 'bbbbbbbb-0000-0000-0000-0000000170a0', 'Workspace A', 'google', 136, 110, 'main', 'subscription'),
  ('PKG-GW-B', 'bbbbbbbb-0000-0000-0000-0000000170b0', 'Workspace B', 'google', 136, 110, 'main', 'subscription');

set local role authenticated;

do $$ declare v uuid; n int; begin
  -- 1. The owner saves a package atomically.
  perform set_config('request.jwt.claims', json_build_object('sub', 'bbbbbbbb-0000-0000-0000-0000000170a1', 'role', 'authenticated')::text, true);
  v := public.save_package(null, 'Starter Pack', 'pitch', 10, true, '[{"item_id":"PKG-GW-A","qty_mode":"per_seat"}]'::jsonb);
  select count(*) into n from public.package_items where package_id = v;
  if n <> 1 then raise exception 'FAIL 1: owner save wrote % parts', n; end if;

  -- 1b. Re-saving replaces the parts, never duplicates them.
  perform public.save_package(v, 'Starter Pack', null, 5, true, '[{"item_id":"PKG-GW-A","qty_mode":"fixed","fixed_qty":2}]'::jsonb);
  select count(*) into n from public.package_items where package_id = v and qty_mode = 'fixed' and fixed_qty = 2;
  if n <> 1 then raise exception 'FAIL 1b: re-save did not replace parts'; end if;

  -- 2. A sales rep in the same tenant can read it but not write.
  perform set_config('request.jwt.claims', json_build_object('sub', 'bbbbbbbb-0000-0000-0000-0000000170a2', 'role', 'authenticated')::text, true);
  if not exists (select 1 from public.packages where id = v) then raise exception 'FAIL 2a: rep cannot read the package'; end if;
  begin
    perform public.save_package(null, 'Rep Pack', null, 0, true, '[{"item_id":"PKG-GW-A"}]'::jsonb);
    raise exception 'FAIL 2b: rep created a package';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.save_package(v, 'Hacked', null, 30, true, '[{"item_id":"PKG-GW-A"}]'::jsonb);
    raise exception 'FAIL 2c: rep edited a package';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like '%not found or not yours%' and sqlstate <> '42501' then raise exception 'FAIL 2c: wrong refusal: %', sqlerrm; end if;
  end;

  -- 3. Another tenant sees nothing, and cannot put someone else's item in its package.
  perform set_config('request.jwt.claims', json_build_object('sub', 'bbbbbbbb-0000-0000-0000-0000000170b1', 'role', 'authenticated')::text, true);
  if exists (select 1 from public.packages where id = v) then raise exception 'FAIL 3a: tenant B sees tenant A package'; end if;
  begin
    perform public.save_package(null, 'Steal', null, 0, true, '[{"item_id":"PKG-GW-A"}]'::jsonb);
    raise exception 'FAIL 3b: tenant B used tenant A item';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like '%is not in tenant%' then raise exception 'FAIL 3b: wrong refusal: %', sqlerrm; end if;
  end;

  -- 4. An empty package is refused.
  begin
    perform public.save_package(null, 'Empty', null, 0, true, '[]'::jsonb);
    raise exception 'FAIL 4: empty package saved';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like '%at least one item%' then raise exception 'FAIL 4: wrong refusal: %', sqlerrm; end if;
  end;
end $$;

rollback;
