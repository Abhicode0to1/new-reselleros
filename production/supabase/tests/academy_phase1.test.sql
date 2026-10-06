-- Regression test: Apprentice Academy phase 1 (migration 20261004150000) — who sees what,
-- and the task loop. Self-asserting; runs in a transaction that ROLLS BACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/academy_phase1.test.sql
--
-- What it proves:
--   1. An apprentice sees their own profile only, and NOTHING of the company's other data
--      (a lead in the same company is invisible to them).
--   2. An apprentice cannot write a task directly, nor move its status by hand.
--   3. Start → submit (attempt 1) → mentor asks rework (feedback required) → resubmit
--      (attempt 2) → mentor approves → completed, marks kept.
--   4. A mentor sees only their apprentice; a staff user who is not the mentor sees none;
--      the owner sees both; another company sees none.
--   5. An apprentice cannot review, nor submit another apprentice's task.
--   6. The default program loads 7 modules once, and the apprentice can read it.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000ac001', 'ACADEMY CO', 'academy@example.in', '07'),
  ('aaaaaaaa-0000-0000-0000-0000000ac002', 'OTHER CO',   'other@example.in',   '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@academy.example'),
  ('aaaaaaaa-0000-0000-0000-0000000a0002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'mentor@academy.example'),
  ('aaaaaaaa-0000-0000-0000-0000000a0003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'staff@academy.example'),
  ('aaaaaaaa-0000-0000-0000-0000000a0004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'appr-a@academy.example'),
  ('aaaaaaaa-0000-0000-0000-0000000a0005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'appr-b@academy.example'),
  ('aaaaaaaa-0000-0000-0000-0000000a0006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@other.example');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-0000000a0001', 'aaaaaaaa-0000-0000-0000-0000000ac001', 'owner@academy.example', 'owner'),
  ('aaaaaaaa-0000-0000-0000-0000000a0002', 'aaaaaaaa-0000-0000-0000-0000000ac001', 'mentor@academy.example', 'sales'),
  ('aaaaaaaa-0000-0000-0000-0000000a0003', 'aaaaaaaa-0000-0000-0000-0000000ac001', 'staff@academy.example', 'sales'),
  ('aaaaaaaa-0000-0000-0000-0000000a0006', 'aaaaaaaa-0000-0000-0000-0000000ac002', 'owner@other.example', 'owner');
-- apprentices are NOT public.users rows
insert into public.academy_apprentices (id, tenant_id, user_id, full_name, email, mentor_user_id) values
  ('aaaaaaaa-0000-0000-0000-0000000ab00a', 'aaaaaaaa-0000-0000-0000-0000000ac001', 'aaaaaaaa-0000-0000-0000-0000000a0004', 'Apprentice Asha', 'appr-a@academy.example', 'aaaaaaaa-0000-0000-0000-0000000a0002'),
  ('aaaaaaaa-0000-0000-0000-0000000ab00b', 'aaaaaaaa-0000-0000-0000-0000000ac001', 'aaaaaaaa-0000-0000-0000-0000000a0005', 'Apprentice Bina', 'appr-b@academy.example', null);
insert into public.academy_tasks (id, tenant_id, apprentice_id, title, submission_type) values
  ('aaaaaaaa-0000-0000-0000-0000000a7a01', 'aaaaaaaa-0000-0000-0000-0000000ac001', 'aaaaaaaa-0000-0000-0000-0000000ab00a', 'Build a REST API call', 'github'),
  ('aaaaaaaa-0000-0000-0000-0000000a7b01', 'aaaaaaaa-0000-0000-0000-0000000ac001', 'aaaaaaaa-0000-0000-0000-0000000ab00b', 'HTML page', 'link');
insert into public.leads (id, tenant_id, company, contact_name, source, stage) values
  ('L-ACADEMY-SECRET', 'aaaaaaaa-0000-0000-0000-0000000ac001', 'Secret Customer Pvt Ltd', 'Someone', 'website', 'new');

do $$ begin
  if (select code from public.academy_apprentices where id = 'aaaaaaaa-0000-0000-0000-0000000ab00a') <> 'APP-001'
     or (select code from public.academy_apprentices where id = 'aaaaaaaa-0000-0000-0000-0000000ab00b') <> 'APP-002' then
    raise exception 'FAIL 0: apprentice codes not APP-001 / APP-002';
  end if;
end $$;

set local role authenticated;

-- ── 1, 2, 5 as apprentice A ─────────────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-0000000a0004', 'role', 'authenticated')::text, true);
do $$ declare n int; begin
  select count(*) into n from public.academy_apprentices;
  if n <> 1 then raise exception 'FAIL 1a: apprentice sees % apprentice rows', n; end if;
  select count(*) into n from public.leads;
  if n <> 0 then raise exception 'FAIL 1b: apprentice sees % company lead(s)', n; end if;
  select count(*) into n from public.academy_tasks;
  if n <> 1 then raise exception 'FAIL 1c: apprentice sees % tasks', n; end if;

  begin
    insert into public.academy_tasks (tenant_id, apprentice_id, title) values ('aaaaaaaa-0000-0000-0000-0000000ac001', 'aaaaaaaa-0000-0000-0000-0000000ab00a', 'Self-made task');
    raise exception 'FAIL 2a: apprentice inserted a task';
  exception when insufficient_privilege then null;
  end;
  update public.academy_tasks set status = 'completed' where id = 'aaaaaaaa-0000-0000-0000-0000000a7a01';
  if (select status from public.academy_tasks where id = 'aaaaaaaa-0000-0000-0000-0000000a7a01') <> 'not_started' then
    raise exception 'FAIL 2b: apprentice moved the status by hand';
  end if;

  begin
    perform public.academy_review_task('aaaaaaaa-0000-0000-0000-0000000a7a01', 'approved', 'self-approve', 100);
    raise exception 'FAIL 5a: apprentice reviewed a task';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if;
  end;
  begin
    perform public.academy_submit_task('aaaaaaaa-0000-0000-0000-0000000a7b01', 'not mine', null, null);
    raise exception 'FAIL 5b: apprentice submitted another apprentice''s task';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if;
  end;

  -- 3 (part): start, then a GitHub task refuses a plain link, then submit
  perform public.academy_start_task('aaaaaaaa-0000-0000-0000-0000000a7a01');
  begin
    perform public.academy_submit_task('aaaaaaaa-0000-0000-0000-0000000a7a01', 'done', 'https://example.com', null);
    raise exception 'FAIL 3a: github task accepted without a GitHub link';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if;
  end;
  if public.academy_submit_task('aaaaaaaa-0000-0000-0000-0000000a7a01', 'First try', null, 'https://github.com/asha/api-demo') <> 1 then
    raise exception 'FAIL 3b: first attempt number';
  end if;
end $$;

-- ── 4 + 3 as the mentor ─────────────────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-0000000a0002', 'role', 'authenticated')::text, true);
do $$ declare n int; begin
  select count(*) into n from public.academy_apprentices;
  if n <> 1 then raise exception 'FAIL 4a: mentor sees % apprentices (expected only theirs)', n; end if;
  begin
    perform public.academy_review_task('aaaaaaaa-0000-0000-0000-0000000a7a01', 'rework', '', null);
    raise exception 'FAIL 3c: rework without feedback accepted';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if;
  end;
  perform public.academy_review_task('aaaaaaaa-0000-0000-0000-0000000a7a01', 'rework', 'Handle the error case of the fetch.', 55);
  if (select status from public.academy_tasks where id = 'aaaaaaaa-0000-0000-0000-0000000a7a01') <> 'rework' then raise exception 'FAIL 3d: not rework'; end if;
end $$;

select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-0000000a0004', 'role', 'authenticated')::text, true);
do $$ begin
  if (select feedback from public.academy_submissions where task_id = 'aaaaaaaa-0000-0000-0000-0000000a7a01' and attempt = 1) <> 'Handle the error case of the fetch.' then
    raise exception 'FAIL 3e: apprentice cannot read the feedback';
  end if;
  if public.academy_submit_task('aaaaaaaa-0000-0000-0000-0000000a7a01', 'Fixed the error case', null, 'https://github.com/asha/api-demo') <> 2 then
    raise exception 'FAIL 3f: second attempt number';
  end if;
end $$;

select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-0000000a0002', 'role', 'authenticated')::text, true);
do $$ begin
  perform public.academy_review_task('aaaaaaaa-0000-0000-0000-0000000a7a01', 'approved', 'Good.', 85);
  if (select status from public.academy_tasks where id = 'aaaaaaaa-0000-0000-0000-0000000a7a01') <> 'completed' then raise exception 'FAIL 3g: not completed'; end if;
  if (select marks from public.academy_submissions where task_id = 'aaaaaaaa-0000-0000-0000-0000000a7a01' and attempt = 2) <> 85 then raise exception 'FAIL 3h: marks'; end if;
end $$;

-- ── 4 as other staff, the owner, another company ────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-0000000a0003', 'role', 'authenticated')::text, true);
do $$ begin
  if (select count(*) from public.academy_apprentices) <> 0 then raise exception 'FAIL 4b: non-mentor staff sees apprentices'; end if;
  if (select count(*) from public.academy_tasks) <> 0 then raise exception 'FAIL 4c: non-mentor staff sees tasks'; end if;
end $$;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-0000000a0001', 'role', 'authenticated')::text, true);
do $$ declare v uuid; v2 uuid; begin
  if (select count(*) from public.academy_apprentices) <> 2 then raise exception 'FAIL 4d: owner does not see both'; end if;
  -- 6
  v := public.academy_load_default_program();
  v2 := public.academy_load_default_program();
  if v <> v2 then raise exception 'FAIL 6a: default program created twice'; end if;
  if (select count(*) from public.academy_modules where program_id = v) <> 7 then raise exception 'FAIL 6b: not 7 modules'; end if;
  update public.academy_apprentices set program_id = v where id = 'aaaaaaaa-0000-0000-0000-0000000ab00a';
end $$;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-0000000a0006', 'role', 'authenticated')::text, true);
do $$ begin
  if (select count(*) from public.academy_apprentices) <> 0 then raise exception 'FAIL 4e: another company sees apprentices'; end if;
  if (select count(*) from public.academy_modules) <> 0 then raise exception 'FAIL 4f: another company sees modules'; end if;
end $$;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-0000000a0004', 'role', 'authenticated')::text, true);
do $$ begin
  if (select count(*) from public.academy_modules) <> 7 then raise exception 'FAIL 6c: apprentice cannot read the curriculum'; end if;
end $$;

rollback;
