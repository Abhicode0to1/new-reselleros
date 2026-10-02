-- 20261002180000: only an owner/manager deletes a lead; a rep's delete removes nothing.
-- Rolled back; safe anywhere. Exit 0 = pass.
begin;

insert into public.tenants (id, name, email, state_code) values
  ('cccccccc-0000-0000-0000-0000000180a0', 'DEL A', 'del-a@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('cccccccc-0000-0000-0000-0000000180a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'del-owner@example.in'),
  ('cccccccc-0000-0000-0000-0000000180a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'del-rep@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('cccccccc-0000-0000-0000-0000000180a1', 'cccccccc-0000-0000-0000-0000000180a0', 'del-owner@example.in', 'owner'),
  ('cccccccc-0000-0000-0000-0000000180a2', 'cccccccc-0000-0000-0000-0000000180a0', 'del-rep@example.in', 'sales');
insert into public.leads (id, tenant_id, company, owner_id) values
  ('L-DEL-1', 'cccccccc-0000-0000-0000-0000000180a0', 'Rep Owned', 'cccccccc-0000-0000-0000-0000000180a2'),
  ('L-DEL-2', 'cccccccc-0000-0000-0000-0000000180a0', 'Owner Deletes', 'cccccccc-0000-0000-0000-0000000180a2');

set local role authenticated;

do $$ declare n int; begin
  -- 1. The rep cannot delete even their own lead.
  perform set_config('request.jwt.claims', json_build_object('sub', 'cccccccc-0000-0000-0000-0000000180a2', 'role', 'authenticated')::text, true);
  delete from public.leads where id = 'L-DEL-1';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 1: a sales rep deleted a lead'; end if;
  if not exists (select 1 from public.leads where id = 'L-DEL-1') then raise exception 'FAIL 1b: lead is gone'; end if;

  -- 2. The owner can.
  perform set_config('request.jwt.claims', json_build_object('sub', 'cccccccc-0000-0000-0000-0000000180a1', 'role', 'authenticated')::text, true);
  delete from public.leads where id = 'L-DEL-2';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 2: owner could not delete (% rows)', n; end if;
end $$;

rollback;
