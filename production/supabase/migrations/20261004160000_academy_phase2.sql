-- 4 Oct 2026 — Apprentice Academy, phase 2 (R-150): skills progress and the weekly
-- evaluation. The performance score is computed from these plus tasks and marks in
-- lib/academy/performance.ts (pure, unit-tested) — nothing about it is stored, so it can
-- never disagree with the rows it is made of.
--
-- Same who-sees-what as phase 1 (20261004150000): the apprentice reads their own rows;
-- staff who see the apprentice (owner / manager, or their mentor) read and write.

create table if not exists public.academy_skills (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null check (length(trim(name)) >= 2),
  position    int  not null default 1,
  created_at  timestamptz not null default now(),
  constraint academy_skills_name_unique unique (tenant_id, name)
);

create table if not exists public.academy_apprentice_skills (
  apprentice_id uuid not null references public.academy_apprentices(id) on delete cascade,
  skill_id      uuid not null references public.academy_skills(id) on delete cascade,
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  percent       int  not null default 0 check (percent between 0 and 100),
  mentor_note   text,
  updated_by    uuid references public.users(id) on delete set null,
  updated_at    timestamptz not null default now(),
  primary key (apprentice_id, skill_id)
);

create table if not exists public.academy_evaluations (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  apprentice_id    uuid not null references public.academy_apprentices(id) on delete cascade,
  week_start       date not null check (extract(isodow from week_start) = 1),
  technical        int  not null check (technical between 0 and 20),
  problem_solving  int  not null check (problem_solving between 0 and 20),
  ai_tool_usage    int  not null check (ai_tool_usage between 0 and 20),
  task_completion  int  not null check (task_completion between 0 and 15),
  code_quality     int  not null check (code_quality between 0 and 15),
  communication    int  not null check (communication between 0 and 10),
  total            int  generated always as (technical + problem_solving + ai_tool_usage + task_completion + code_quality + communication) stored,
  strengths        text,
  improve          text,
  next_focus       text,
  evaluated_by     uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint academy_evaluations_one_per_week unique (apprentice_id, week_start)
);
create index if not exists academy_evaluations_apprentice_idx on public.academy_evaluations (apprentice_id, week_start desc);

-- Same company on every row (a crafted insert cannot point across tenants).
create or replace function public.tg_academy_phase2_same_tenant()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.academy_apprentices where id = new.apprentice_id and tenant_id = new.tenant_id) then
    raise exception 'That apprentice is not in this company.' using errcode = '23514';
  end if;
  -- Nested, not "and": PL/pgSQL may evaluate both sides, and an evaluation row has no skill_id.
  if tg_table_name = 'academy_apprentice_skills' then
    if not exists (select 1 from public.academy_skills where id = new.skill_id and tenant_id = new.tenant_id) then
      raise exception 'That skill is not in this company.' using errcode = '23514';
    end if;
  end if;
  new.updated_at := now();
  if auth.uid() is not null then
    if tg_table_name = 'academy_apprentice_skills' then new.updated_by := auth.uid(); end if;
    if tg_table_name = 'academy_evaluations' and tg_op = 'INSERT' then new.evaluated_by := auth.uid(); end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_academy_apprentice_skills_guard on public.academy_apprentice_skills;
create trigger trg_academy_apprentice_skills_guard before insert or update on public.academy_apprentice_skills
  for each row execute function public.tg_academy_phase2_same_tenant();
drop trigger if exists trg_academy_evaluations_guard on public.academy_evaluations;
create trigger trg_academy_evaluations_guard before insert or update on public.academy_evaluations
  for each row execute function public.tg_academy_phase2_same_tenant();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.academy_skills            enable row level security;
alter table public.academy_apprentice_skills enable row level security;
alter table public.academy_evaluations       enable row level security;

drop policy if exists academy_skills_read on public.academy_skills;
create policy academy_skills_read on public.academy_skills for select
  using (tenant_id = public.current_tenant_id() or tenant_id = public.academy_my_tenant_id());
drop policy if exists academy_skills_write on public.academy_skills;
create policy academy_skills_write on public.academy_skills for all
  using (tenant_id = public.current_tenant_id() and public.academy_can_manage())
  with check (tenant_id = public.current_tenant_id() and public.academy_can_manage());

drop policy if exists academy_apprentice_skills_read on public.academy_apprentice_skills;
create policy academy_apprentice_skills_read on public.academy_apprentice_skills for select
  using (public.academy_staff_sees(apprentice_id) or apprentice_id = public.academy_my_apprentice_id());
drop policy if exists academy_apprentice_skills_write on public.academy_apprentice_skills;
create policy academy_apprentice_skills_write on public.academy_apprentice_skills for all
  using (tenant_id = public.current_tenant_id() and public.academy_staff_sees(apprentice_id))
  with check (tenant_id = public.current_tenant_id() and public.academy_staff_sees(apprentice_id));

drop policy if exists academy_evaluations_read on public.academy_evaluations;
create policy academy_evaluations_read on public.academy_evaluations for select
  using (public.academy_staff_sees(apprentice_id) or apprentice_id = public.academy_my_apprentice_id());
drop policy if exists academy_evaluations_write on public.academy_evaluations;
create policy academy_evaluations_write on public.academy_evaluations for all
  using (tenant_id = public.current_tenant_id() and public.academy_staff_sees(apprentice_id))
  with check (tenant_id = public.current_tenant_id() and public.academy_staff_sees(apprentice_id));

do $$ declare t text; begin
  foreach t in array array['academy_skills', 'academy_apprentice_skills', 'academy_evaluations'] loop
    execute format('drop policy if exists zzz_service_role_all on public.%I', t);
    execute format('create policy zzz_service_role_all on public.%I for all to service_role using (true) with check (true)', t);
  end loop;
end $$;

grant select, insert, update, delete on public.academy_skills, public.academy_apprentice_skills, public.academy_evaluations to authenticated;
grant all on public.academy_skills, public.academy_apprentice_skills, public.academy_evaluations to service_role;

-- ── Default skills (the master prompt's list), loaded once per company ──────
create or replace function public.academy_load_default_skills()
returns int language plpgsql security definer set search_path = public as $$
declare v_tenant uuid := public.current_tenant_id(); n int;
begin
  if v_tenant is null or not public.academy_can_manage() then raise exception 'Only an owner or manager can set up skills.'; end if;
  insert into public.academy_skills (tenant_id, name, position)
  select v_tenant, s.name, s.pos
    from unnest(array['HTML', 'CSS', 'JavaScript', 'Python', 'Git / GitHub', 'AI fundamentals', 'Claude Code', 'APIs', 'Automation'])
         with ordinality as s(name, pos)
  on conflict (tenant_id, name) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.academy_load_default_skills() from public, anon;
grant execute on function public.academy_load_default_skills() to authenticated, service_role;
