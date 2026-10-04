-- Regression test: Apprentice Academy phase 2 (migration 20261004160000) — skills and weekly
-- evaluations: rules and who sees what. Self-asserting; ROLLS BACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/academy_phase2.test.sql
--
-- What it proves:
--   1. Default skills load once (9), a second load adds none.
--   2. An evaluation's total is the sum of its six parts; out-of-range marks, a non-Monday
--      week and a second evaluation for the same week are refused; evaluated_by is the writer.
--   3. A mentor writes skills / evaluations for their apprentice only.
--   4. An apprentice reads their own evaluation and skills, not another's, and cannot write.
--   5. Staff who are not the mentor, and another company, see nothing.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000bc001', 'ACADEMY2 CO', 'academy2@example.in', '07'),
  ('aaaaaaaa-0000-0000-0000-0000000bc002', 'OTHER2 CO',   'other2@example.in',   '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-0000000b0001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@academy2.example'),
  ('aaaaaaaa-0000-0000-0000-0000000b0002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'mentor@academy2.example'),
  ('aaaaaaaa-0000-0000-0000-0000000b0003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'staff@academy2.example'),
  ('aaaaaaaa-0000-0000-0000-0000000b0004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'appr-a@academy2.example'),
  ('aaaaaaaa-0000-0000-0000-0000000b0006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@other2.example');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-0000000b0001', 'aaaaaaaa-0000-0000-0000-0000000bc001', 'owner@academy2.example', 'owner'),
  ('aaaaaaaa-0000-0000-0000-0000000b0002', 'aaaaaaaa-0000-0000-0000-0000000bc001', 'mentor@academy2.example', 'manager'),
  ('aaaaaaaa-0000-0000-0000-0000000b0003', 'aaaaaaaa-0000-0000-0000-0000000bc001', 'staff@academy2.example', 'sales'),
  ('aaaaaaaa-0000-0000-0000-0000000b0006', 'aaaaaaaa-0000-0000-0000-0000000bc002', 'owner@other2.example', 'owner');
insert into public.academy_apprentices (id, tenant_id, user_id, full_name, mentor_user_id) values
  ('aaaaaaaa-0000-0000-0000-0000000bb00a', 'aaaaaaaa-0000-0000-0000-0000000bc001', 'aaaaaaaa-0000-0000-0000-0000000b0004', 'Apprentice A', 'aaaaaaaa-0000-0000-0000-0000000b0002'),
  ('aaaaaaaa-0000-0000-0000-0000000bb00b', 'aaaaaaaa-0000-0000-0000-0000000bc001', null, 'Apprentice B', null);

set local role authenticated;

-- 1 as owner
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-0000000b0001', 'role', 'authenticated')::text, true);
do $$ begin
  if public.academy_load_default_skills() <> 9 then raise exception 'FAIL 1a: not 9 skills'; end if;
  if public.academy_load_default_skills() <> 0 then raise exception 'FAIL 1b: skills loaded twice'; end if;
  -- owner evaluates B (mentor-less) so 5 has something to hide
  insert into public.academy_evaluations (tenant_id, apprentice_id, week_start, technical, problem_solving, ai_tool_usage, task_completion, code_quality, communication)
  values ('aaaaaaaa-0000-0000-0000-0000000bc001', 'aaaaaaaa-0000-0000-0000-0000000bb00b', '2026-09-28', 10, 10, 10, 8, 8, 5);
end $$;

-- 2 + 3 as the mentor (a manager)
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-0000000b0002', 'role', 'authenticated')::text, true);
do $$ declare v_total int; v_by uuid; v_skill uuid; begin
  insert into public.academy_evaluations (tenant_id, apprentice_id, week_start, technical, problem_solving, ai_tool_usage, task_completion, code_quality, communication, next_focus)
  values ('aaaaaaaa-0000-0000-0000-0000000bc001', 'aaaaaaaa-0000-0000-0000-0000000bb00a', '2026-09-28', 18, 15, 17, 12, 11, 8, 'APIs')
  returning total, evaluated_by into v_total, v_by;
  if v_total <> 81 then raise exception 'FAIL 2a: total % (expected 81)', v_total; end if;
  if v_by <> 'aaaaaaaa-0000-0000-0000-0000000b0002' then raise exception 'FAIL 2b: evaluated_by not the writer'; end if;

  begin
    insert into public.academy_evaluations (tenant_id, apprentice_id, week_start, technical, problem_solving, ai_tool_usage, task_completion, code_quality, communication)
    values ('aaaaaaaa-0000-0000-0000-0000000bc001', 'aaaaaaaa-0000-0000-0000-0000000bb00a', '2026-09-28', 1, 1, 1, 1, 1, 1);
    raise exception 'FAIL 2c: two evaluations in one week';
  exception when unique_violation then null;
  end;
  begin
    insert into public.academy_evaluations (tenant_id, apprentice_id, week_start, technical, problem_solving, ai_tool_usage, task_completion, code_quality, communication)
    values ('aaaaaaaa-0000-0000-0000-0000000bc001', 'aaaaaaaa-0000-0000-0000-0000000bb00a', '2026-09-30', 1, 1, 1, 1, 1, 1);
    raise exception 'FAIL 2d: a Wednesday week start accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.academy_evaluations (tenant_id, apprentice_id, week_start, technical, problem_solving, ai_tool_usage, task_completion, code_quality, communication)
    values ('aaaaaaaa-0000-0000-0000-0000000bc001', 'aaaaaaaa-0000-0000-0000-0000000bb00a', '2026-10-05', 21, 1, 1, 1, 1, 1);
    raise exception 'FAIL 2e: technical 21/20 accepted';
  exception when check_violation then null;
  end;

  select id into v_skill from public.academy_skills where name = 'APIs';
  insert into public.academy_apprentice_skills (apprentice_id, skill_id, tenant_id, percent, mentor_note)
  values ('aaaaaaaa-0000-0000-0000-0000000bb00a', v_skill, 'aaaaaaaa-0000-0000-0000-0000000bc001', 45, 'Struggles with fetch errors');
  if (select percent from public.academy_apprentice_skills where apprentice_id = 'aaaaaaaa-0000-0000-0000-0000000bb00a' and skill_id = v_skill) <> 45 then
    raise exception 'FAIL 3a: skill not saved';
  end if;
end $$;

-- 3b: a manager who is NOT B's mentor still manages (owner/manager see all) — so use sales staff for the negative case below.

-- 4 as apprentice A
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-0000000b0004', 'role', 'authenticated')::text, true);
do $$ begin
  if (select count(*) from public.academy_evaluations) <> 1 then raise exception 'FAIL 4a: apprentice sees % evaluations', (select count(*) from public.academy_evaluations); end if;
  if (select count(*) from public.academy_apprentice_skills) <> 1 then raise exception 'FAIL 4b: apprentice skills not readable'; end if;
  if (select count(*) from public.academy_skills) <> 9 then raise exception 'FAIL 4c: skill list not readable'; end if;
  begin
    insert into public.academy_evaluations (tenant_id, apprentice_id, week_start, technical, problem_solving, ai_tool_usage, task_completion, code_quality, communication)
    values ('aaaaaaaa-0000-0000-0000-0000000bc001', 'aaaaaaaa-0000-0000-0000-0000000bb00a', '2026-10-05', 20, 20, 20, 15, 15, 10);
    raise exception 'FAIL 4d: apprentice graded themselves';
  exception when insufficient_privilege then null;
  end;
  update public.academy_apprentice_skills set percent = 100;
  if exists (select 1 from public.academy_apprentice_skills where percent = 100) then raise exception 'FAIL 4e: apprentice raised their own skill'; end if;
end $$;

-- 5 as non-mentor sales staff, then another company
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-0000000b0003', 'role', 'authenticated')::text, true);
do $$ begin
  if (select count(*) from public.academy_evaluations) <> 0 then raise exception 'FAIL 5a: non-mentor staff sees evaluations'; end if;
  if (select count(*) from public.academy_apprentice_skills) <> 0 then raise exception 'FAIL 5b: non-mentor staff sees skills'; end if;
  begin
    insert into public.academy_evaluations (tenant_id, apprentice_id, week_start, technical, problem_solving, ai_tool_usage, task_completion, code_quality, communication)
    values ('aaaaaaaa-0000-0000-0000-0000000bc001', 'aaaaaaaa-0000-0000-0000-0000000bb00b', '2026-10-05', 1, 1, 1, 1, 1, 1);
    raise exception 'FAIL 5c: non-mentor staff wrote an evaluation';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-0000000b0006', 'role', 'authenticated')::text, true);
do $$ begin
  if (select count(*) from public.academy_evaluations) <> 0 or (select count(*) from public.academy_skills) <> 0 then
    raise exception 'FAIL 5d: another company sees academy data';
  end if;
end $$;

rollback;
