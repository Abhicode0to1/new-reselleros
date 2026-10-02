-- R-111: new unowned leads are dealt round-robin to the people an owner ticked.
-- Rolled back; safe anywhere. Exit 0 = pass.
begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000111a0', 'ASSIGN A', 'as-a@example.in', '07'),
  ('aaaaaaaa-0000-0000-0000-0000000111b0', 'ASSIGN B', 'as-b@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-0000000111a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'as-owner@example.in'),
  ('aaaaaaaa-0000-0000-0000-0000000111a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'as-rep1@example.in'),
  ('aaaaaaaa-0000-0000-0000-0000000111a3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'as-rep2@example.in'),
  ('aaaaaaaa-0000-0000-0000-0000000111a4', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'as-gone@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-0000000111a1', 'aaaaaaaa-0000-0000-0000-0000000111a0', 'as-owner@example.in', 'owner'),
  ('aaaaaaaa-0000-0000-0000-0000000111a2', 'aaaaaaaa-0000-0000-0000-0000000111a0', 'as-rep1@example.in', 'sales'),
  ('aaaaaaaa-0000-0000-0000-0000000111a3', 'aaaaaaaa-0000-0000-0000-0000000111a0', 'as-rep2@example.in', 'sales'),
  ('aaaaaaaa-0000-0000-0000-0000000111a4', 'aaaaaaaa-0000-0000-0000-0000000111a0', 'as-gone@example.in', 'sales');

do $$ declare o uuid; begin
  -- 1. Nobody opted in: unchanged behaviour, owner stays null.
  insert into public.leads (id, tenant_id, company) values ('L-AS-1', 'aaaaaaaa-0000-0000-0000-0000000111a0', 'One');
  select owner_id into o from public.leads where id = 'L-AS-1';
  if o is not null then raise exception 'FAIL 1: assigned with an empty pool'; end if;

  -- pool: rep1, rep2, and an inactive person who must never get one
  update public.users set gets_new_leads = true
   where id in ('aaaaaaaa-0000-0000-0000-0000000111a2','aaaaaaaa-0000-0000-0000-0000000111a3','aaaaaaaa-0000-0000-0000-0000000111a4');
  update public.users set is_active = false where id = 'aaaaaaaa-0000-0000-0000-0000000111a4';

  -- 2. Round-robin across the two active people.
  insert into public.leads (id, tenant_id, company) values ('L-AS-2', 'aaaaaaaa-0000-0000-0000-0000000111a0', 'Two');
  insert into public.leads (id, tenant_id, company) values ('L-AS-3', 'aaaaaaaa-0000-0000-0000-0000000111a0', 'Three');
  insert into public.leads (id, tenant_id, company) values ('L-AS-4', 'aaaaaaaa-0000-0000-0000-0000000111a0', 'Four');
  if (select count(distinct owner_id) from public.leads where id in ('L-AS-2','L-AS-3')) <> 2 then
    raise exception 'FAIL 2a: two leads did not go to two people';
  end if;
  if (select owner_id from public.leads where id = 'L-AS-4') is distinct from (select owner_id from public.leads where id = 'L-AS-2') then
    raise exception 'FAIL 2b: third lead did not come back round';
  end if;
  if exists (select 1 from public.leads where owner_id = 'aaaaaaaa-0000-0000-0000-0000000111a4') then
    raise exception 'FAIL 3: an inactive person got a lead';
  end if;

  -- 4. A lead that arrives with an owner keeps it.
  insert into public.leads (id, tenant_id, company, owner_id) values ('L-AS-5', 'aaaaaaaa-0000-0000-0000-0000000111a0', 'Five', 'aaaaaaaa-0000-0000-0000-0000000111a1');
  if (select owner_id from public.leads where id = 'L-AS-5') <> 'aaaaaaaa-0000-0000-0000-0000000111a1' then
    raise exception 'FAIL 4: an explicit owner was overwritten';
  end if;

  -- 5. Another tenant's pool is never used.
  insert into public.leads (id, tenant_id, company) values ('L-AS-6', 'aaaaaaaa-0000-0000-0000-0000000111b0', 'Other');
  if (select owner_id from public.leads where id = 'L-AS-6') is not null then
    raise exception 'FAIL 5: a lead crossed tenants';
  end if;
end $$;

-- 6. A rep cannot tick themselves into (or out of) the pool.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-0000000111a2', 'role', 'authenticated')::text, true);
do $$ begin
  begin
    update public.users set gets_new_leads = false where id = 'aaaaaaaa-0000-0000-0000-0000000111a2';
    raise exception 'FAIL 6: a non-owner changed gets_new_leads';
  exception when others then
    if sqlerrm not like '%new-lead assignment%' then raise; end if;
  end;
end $$;

rollback;
