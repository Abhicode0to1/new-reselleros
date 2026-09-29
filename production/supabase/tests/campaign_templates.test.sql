-- Regression test: campaign templates — seeded system set + per-company management
-- (migration 20260926200000 and the ctmpl_* policies it relies on).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/campaign_templates.test.sql
--
-- What it proves:
--   1. The system templates exist and every company can read them.
--   2. No company can edit or delete a system template (they copy it instead).
--   3. A company can create, edit and delete its own template.
--   4. Another company cannot see or touch it.
--   5. No system template uses a variable /api/campaigns/send does not fill.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000e9', 'TPL TEST A', 'tpl-a@example.in', '07'),
  ('bbbbbbbb-0000-0000-0000-0000000000e9', 'TPL TEST B', 'tpl-b@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000e0a9', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tpl-a-user@example.in'),
  ('bbbbbbbb-0000-0000-0000-00000000e0b9', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tpl-b-user@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000e0a9', 'aaaaaaaa-0000-0000-0000-0000000000e9', 'tpl-a-user@example.in', 'owner'),
  ('bbbbbbbb-0000-0000-0000-00000000e0b9', 'bbbbbbbb-0000-0000-0000-0000000000e9', 'tpl-b-user@example.in', 'owner');

-- 5. Only known variables in the seeded set
do $$
declare bad text;
begin
  select string_agg(distinct m[1], ', ') into bad
    from public.campaign_templates t,
         regexp_matches(t.subject || ' ' || t.body_html || ' ' || coalesce(t.body_text, ''), '\{\{(\w+)\}\}', 'g') as m
   where t.is_system
     and m[1] not in ('name', 'company', 'sender', 'offer_code', 'discount', 'expires');
  if bad is not null then raise exception 'FAIL 5: unknown variables in system templates: %', bad; end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000e0a9', 'role', 'authenticated')::text, true);

-- 1 + 2. Readable, not editable
do $$
declare n int;
begin
  select count(*) into n from public.campaign_templates where is_system;
  if n < 9 then raise exception 'FAIL 1: only % system templates visible', n; end if;

  update public.campaign_templates set subject = 'hacked' where id = 'sys-winback';
  delete from public.campaign_templates where id = 'sys-gws-intro';
  select count(*) into n from public.campaign_templates where id in ('sys-winback', 'sys-gws-intro') and subject <> 'hacked';
  if n <> 2 then raise exception 'FAIL 2: a company changed or deleted a system template'; end if;
end $$;

-- 3. Own template: create, edit
do $$
declare s text;
begin
  insert into public.campaign_templates (id, tenant_id, name, category, subject, body_html, is_system)
  values ('TPL-TEST-A', 'aaaaaaaa-0000-0000-0000-0000000000e9', 'Mine', 'custom', 'Hello {{name}}', '<p>Hi</p>', false);
  update public.campaign_templates set subject = 'Edited' where id = 'TPL-TEST-A';
  select subject into s from public.campaign_templates where id = 'TPL-TEST-A';
  if s <> 'Edited' then raise exception 'FAIL 3: own template not editable (%)', s; end if;

  begin
    insert into public.campaign_templates (id, tenant_id, name, category, subject, body_html, is_system)
    values ('TPL-FAKE-SYS', null, 'Fake', 'custom', 'x', '<p>x</p>', true);
    raise exception 'FAIL 3b: a company created a system template';
  exception when insufficient_privilege then null;
  end;
end $$;

-- 4. Company B cannot see or touch it
select set_config('request.jwt.claims', json_build_object('sub', 'bbbbbbbb-0000-0000-0000-00000000e0b9', 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  select count(*) into n from public.campaign_templates where id = 'TPL-TEST-A';
  if n <> 0 then raise exception 'FAIL 4: B sees A''s template'; end if;
  delete from public.campaign_templates where id = 'TPL-TEST-A';
end $$;

select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000e0a9', 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  select count(*) into n from public.campaign_templates where id = 'TPL-TEST-A';
  if n <> 1 then raise exception 'FAIL 4b: B deleted A''s template'; end if;
  delete from public.campaign_templates where id = 'TPL-TEST-A';
  select count(*) into n from public.campaign_templates where id = 'TPL-TEST-A';
  if n <> 0 then raise exception 'FAIL 3c: A could not delete its own template'; end if;
end $$;

select 'campaign_templates: all assertions passed' as result;
rollback;
