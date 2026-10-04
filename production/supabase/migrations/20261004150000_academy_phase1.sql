-- 4 Oct 2026 — Apprentice Academy, phase 1 (R-149): programs + modules, apprentices with
-- a mentor, tasks with a submit → review → rework / complete loop, and an apprentice login.
--
-- ─── WHO SEES WHAT — THE PART THAT MUST NOT BE GOT WRONG ────────────────────
-- Staff are public.users rows; current_tenant_id() reads that table, and almost every
-- company table's RLS is "tenant_id = current_tenant_id()". An apprentice is deliberately
-- NOT a public.users row (the customer-portal pattern, customer_users): for them
-- current_tenant_id() is null, so every existing company table — leads, customers,
-- payments, salaries, documents — returns nothing to them, by construction rather than by
-- a list of policies someone could forget to extend. Their identity is
-- academy_apprentices.user_id, read through academy_my_apprentice_id().
--   · Apprentice: own profile, own tasks, own submissions, their program's curriculum.
--     Writes only through the RPCs below (start / submit), never directly.
--   · Mentor (any staff user set as an apprentice's mentor): only those apprentices.
--   · Owner / manager: every apprentice in the company.

-- ── Tables ───────────────────────────────────────────────────────────────────
create table if not exists public.academy_programs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  description text,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.academy_modules (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  program_id  uuid not null references public.academy_programs(id) on delete cascade,
  position    int  not null default 1,
  title       text not null,
  topics      text[] not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists academy_modules_program_idx on public.academy_modules (program_id, position);

create table if not exists public.academy_apprentices (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references public.tenants(id) on delete cascade,
  code                    text not null,
  user_id                 uuid unique references auth.users(id) on delete set null,
  full_name               text not null check (length(trim(full_name)) >= 2),
  email                   text,
  phone                   text,
  date_of_birth           date,
  qualification           text,
  institute               text,
  course                  text,
  joining_date            date,
  start_date              date,
  end_date                date,
  program_id              uuid references public.academy_programs(id) on delete set null,
  mentor_user_id          uuid references public.users(id) on delete set null,
  status                  text not null default 'active' check (status in ('active', 'on_leave', 'completed', 'dropped')),
  address                 text,
  emergency_contact_name  text,
  emergency_contact_phone text,
  notes                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint academy_apprentices_dates check (end_date is null or start_date is null or end_date >= start_date),
  constraint academy_apprentices_code_unique unique (tenant_id, code)
);
create unique index if not exists academy_apprentices_email_unique
  on public.academy_apprentices (tenant_id, lower(email)) where email is not null;
create index if not exists academy_apprentices_mentor_idx on public.academy_apprentices (mentor_user_id);

create table if not exists public.academy_tasks (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  apprentice_id   uuid not null references public.academy_apprentices(id) on delete cascade,
  module_id       uuid references public.academy_modules(id) on delete set null,
  title           text not null check (length(trim(title)) >= 3),
  description     text,
  instructions    text,
  kind            text not null default 'daily' check (kind in ('daily', 'weekly', 'assignment', 'learning', 'project', 'practical')),
  difficulty      text not null default 'medium' check (difficulty in ('easy', 'medium', 'hard')),
  est_minutes     int check (est_minutes is null or est_minutes between 5 and 2400),
  due_date        date,
  priority        text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  reference_url   text,
  submission_type text not null default 'link' check (submission_type in ('link', 'github', 'text')),
  status          text not null default 'not_started' check (status in ('not_started', 'in_progress', 'submitted', 'rework', 'completed')),
  created_by      uuid references public.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz
);
create index if not exists academy_tasks_apprentice_idx on public.academy_tasks (apprentice_id, status, due_date);
create index if not exists academy_tasks_review_idx on public.academy_tasks (tenant_id, status) where status = 'submitted';

create table if not exists public.academy_submissions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  task_id       uuid not null references public.academy_tasks(id) on delete cascade,
  apprentice_id uuid not null references public.academy_apprentices(id) on delete cascade,
  attempt       int  not null default 1,
  note          text,
  link_url      text,
  github_url    text,
  submitted_at  timestamptz not null default now(),
  review_result text check (review_result in ('approved', 'rework')),
  feedback      text,
  marks         int check (marks is null or marks between 0 and 100),
  reviewed_by   uuid references public.users(id) on delete set null,
  reviewed_at   timestamptz,
  constraint academy_submissions_attempt_unique unique (task_id, attempt)
);
create index if not exists academy_submissions_task_idx on public.academy_submissions (task_id, attempt desc);

-- ── Who-am-I helpers (security definer: they read rows RLS would hide) ─────────
create or replace function public.academy_my_apprentice_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select a.id from public.academy_apprentices a where a.user_id = auth.uid() limit 1;
$$;

create or replace function public.academy_my_tenant_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select a.tenant_id from public.academy_apprentices a where a.user_id = auth.uid() limit 1;
$$;

create or replace function public.academy_can_manage()
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_user_has_role('owner', 'manager');
$$;

/** Staff side: may this signed-in staff user see this apprentice? */
create or replace function public.academy_staff_sees(p_apprentice_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.academy_apprentices a
     where a.id = p_apprentice_id
       and a.tenant_id = public.current_tenant_id()
       and (public.academy_can_manage() or a.mentor_user_id = auth.uid())
  );
$$;

-- ── Apprentice code (APP-001 …) and updated_at ───────────────────────────────
create or replace function public.tg_academy_apprentice_defaults()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and (new.code is null or trim(new.code) = '') then
    select 'APP-' || lpad((coalesce(max(nullif(regexp_replace(code, '\D', '', 'g'), '')::int), 0) + 1)::text, 3, '0')
      into new.code
      from public.academy_apprentices where tenant_id = new.tenant_id;
  end if;
  new.email := nullif(lower(trim(coalesce(new.email, ''))), '');
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists trg_academy_apprentice_defaults on public.academy_apprentices;
create trigger trg_academy_apprentice_defaults before insert or update on public.academy_apprentices
  for each row execute function public.tg_academy_apprentice_defaults();
-- code is filled by the trigger, so callers may omit it
alter table public.academy_apprentices alter column code set default '';

create or replace function public.tg_academy_touch()
returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists trg_academy_tasks_touch on public.academy_tasks;
create trigger trg_academy_tasks_touch before update on public.academy_tasks
  for each row execute function public.tg_academy_touch();

-- A task's apprentice must belong to the task's company (and a mentor-picked module to the
-- same company) — a guard against a crafted insert pointing across tenants.
create or replace function public.tg_academy_task_same_tenant()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.academy_apprentices where id = new.apprentice_id and tenant_id = new.tenant_id) then
    raise exception 'That apprentice is not in this company.' using errcode = '23514';
  end if;
  if new.module_id is not null and not exists (select 1 from public.academy_modules where id = new.module_id and tenant_id = new.tenant_id) then
    raise exception 'That module is not in this company.' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists trg_academy_task_same_tenant on public.academy_tasks;
create trigger trg_academy_task_same_tenant before insert or update of apprentice_id, module_id, tenant_id on public.academy_tasks
  for each row execute function public.tg_academy_task_same_tenant();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.academy_programs    enable row level security;
alter table public.academy_modules     enable row level security;
alter table public.academy_apprentices enable row level security;
alter table public.academy_tasks       enable row level security;
alter table public.academy_submissions enable row level security;

-- programs / modules: company staff and the company's apprentices read; owner/manager write
drop policy if exists academy_programs_read on public.academy_programs;
create policy academy_programs_read on public.academy_programs for select
  using (tenant_id = public.current_tenant_id() or tenant_id = public.academy_my_tenant_id());
drop policy if exists academy_programs_write on public.academy_programs;
create policy academy_programs_write on public.academy_programs for all
  using (tenant_id = public.current_tenant_id() and public.academy_can_manage())
  with check (tenant_id = public.current_tenant_id() and public.academy_can_manage());

drop policy if exists academy_modules_read on public.academy_modules;
create policy academy_modules_read on public.academy_modules for select
  using (tenant_id = public.current_tenant_id() or tenant_id = public.academy_my_tenant_id());
drop policy if exists academy_modules_write on public.academy_modules;
create policy academy_modules_write on public.academy_modules for all
  using (tenant_id = public.current_tenant_id() and public.academy_can_manage())
  with check (tenant_id = public.current_tenant_id() and public.academy_can_manage());

-- apprentices: owner/manager all; a mentor their own; the apprentice their own row
drop policy if exists academy_apprentices_read on public.academy_apprentices;
create policy academy_apprentices_read on public.academy_apprentices for select
  using (
    (tenant_id = public.current_tenant_id() and (public.academy_can_manage() or mentor_user_id = auth.uid()))
    or user_id = auth.uid()
  );
drop policy if exists academy_apprentices_write on public.academy_apprentices;
create policy academy_apprentices_write on public.academy_apprentices for all
  using (tenant_id = public.current_tenant_id() and public.academy_can_manage())
  with check (tenant_id = public.current_tenant_id() and public.academy_can_manage());

-- tasks: staff who see the apprentice read + write; the apprentice reads their own
drop policy if exists academy_tasks_read on public.academy_tasks;
create policy academy_tasks_read on public.academy_tasks for select
  using (public.academy_staff_sees(apprentice_id) or apprentice_id = public.academy_my_apprentice_id());
drop policy if exists academy_tasks_staff_write on public.academy_tasks;
create policy academy_tasks_staff_write on public.academy_tasks for all
  using (tenant_id = public.current_tenant_id() and public.academy_staff_sees(apprentice_id))
  with check (tenant_id = public.current_tenant_id() and public.academy_staff_sees(apprentice_id));

-- submissions: read only; written by the RPCs
drop policy if exists academy_submissions_read on public.academy_submissions;
create policy academy_submissions_read on public.academy_submissions for select
  using (public.academy_staff_sees(apprentice_id) or apprentice_id = public.academy_my_apprentice_id());

-- Cloud SQL has no BYPASSRLS: the server's service_role needs its own policy (prod-storage note).
do $$ declare t text; begin
  foreach t in array array['academy_programs', 'academy_modules', 'academy_apprentices', 'academy_tasks', 'academy_submissions'] loop
    execute format('drop policy if exists zzz_service_role_all on public.%I', t);
    execute format('create policy zzz_service_role_all on public.%I for all to service_role using (true) with check (true)', t);
  end loop;
end $$;

grant select, insert, update, delete on public.academy_programs, public.academy_modules, public.academy_apprentices,
  public.academy_tasks to authenticated;
grant select on public.academy_submissions to authenticated;
grant all on public.academy_programs, public.academy_modules, public.academy_apprentices,
  public.academy_tasks, public.academy_submissions to service_role;

-- ── RPCs ────────────────────────────────────────────────────────────────────
/** Apprentice: start a task (not started / rework → in progress). */
create or replace function public.academy_start_task(p_task_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_me uuid := public.academy_my_apprentice_id(); v_task public.academy_tasks;
begin
  if v_me is null then raise exception 'Only an apprentice can start their task.'; end if;
  select * into v_task from public.academy_tasks where id = p_task_id and apprentice_id = v_me for update;
  if not found then raise exception 'Task not found.'; end if;
  if v_task.status not in ('not_started', 'rework') then return; end if;
  update public.academy_tasks set status = 'in_progress' where id = p_task_id;
end $$;

/** Apprentice: submit work — a note, a link and/or a GitHub URL. */
create or replace function public.academy_submit_task(p_task_id uuid, p_note text, p_link text, p_github text)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := public.academy_my_apprentice_id();
  v_task public.academy_tasks;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_link text := nullif(trim(coalesce(p_link, '')), '');
  v_gh   text := nullif(trim(coalesce(p_github, '')), '');
  v_attempt int;
begin
  if v_me is null then raise exception 'Only an apprentice can submit their task.'; end if;
  select * into v_task from public.academy_tasks where id = p_task_id and apprentice_id = v_me for update;
  if not found then raise exception 'Task not found.'; end if;
  if v_task.status not in ('not_started', 'in_progress', 'rework') then
    raise exception 'This task is already submitted or completed.';
  end if;
  if v_note is null and v_link is null and v_gh is null then raise exception 'Add your work: a note, a link or a GitHub link.'; end if;
  if v_link is not null and v_link !~* '^https?://' then raise exception 'The link must start with http:// or https://'; end if;
  if v_gh is not null and v_gh !~* '^https://(www\.)?github\.com/' then raise exception 'The GitHub link must start with https://github.com/'; end if;
  if v_task.submission_type = 'github' and v_gh is null then raise exception 'This task needs a GitHub link.'; end if;
  if length(coalesce(v_note, '')) > 5000 then raise exception 'The note is too long (5,000 characters max).'; end if;

  select coalesce(max(attempt), 0) + 1 into v_attempt from public.academy_submissions where task_id = p_task_id;
  insert into public.academy_submissions (tenant_id, task_id, apprentice_id, attempt, note, link_url, github_url)
  values (v_task.tenant_id, p_task_id, v_me, v_attempt, v_note, v_link, v_gh);
  update public.academy_tasks set status = 'submitted' where id = p_task_id;
  return v_attempt;
end $$;

/** Mentor / owner / manager: approve (task completed) or ask for rework, with feedback. */
create or replace function public.academy_review_task(p_task_id uuid, p_result text, p_feedback text, p_marks int)
returns void language plpgsql security definer set search_path = public as $$
declare v_task public.academy_tasks; v_sub uuid; v_fb text := nullif(trim(coalesce(p_feedback, '')), '');
begin
  if p_result not in ('approved', 'rework') then raise exception 'Choose approve or rework.'; end if;
  select * into v_task from public.academy_tasks where id = p_task_id for update;
  if not found or not public.academy_staff_sees(v_task.apprentice_id) then raise exception 'Task not found.'; end if;
  if v_task.status <> 'submitted' then raise exception 'Only a submitted task can be reviewed.'; end if;
  if p_result = 'rework' and v_fb is null then raise exception 'Say what to fix — rework needs feedback.'; end if;
  if p_marks is not null and (p_marks < 0 or p_marks > 100) then raise exception 'Marks are out of 100.'; end if;

  select id into v_sub from public.academy_submissions where task_id = p_task_id order by attempt desc limit 1;
  update public.academy_submissions
     set review_result = p_result, feedback = v_fb, marks = p_marks, reviewed_by = auth.uid(), reviewed_at = now()
   where id = v_sub;
  update public.academy_tasks
     set status = case when p_result = 'approved' then 'completed' else 'rework' end,
         completed_at = case when p_result = 'approved' then now() else null end
   where id = p_task_id;
end $$;

/** Owner / manager: create the default "AI-Assisted Software Development" program once. */
create or replace function public.academy_load_default_program()
returns uuid language plpgsql security definer set search_path = public as $$
declare v_tenant uuid := public.current_tenant_id(); v_id uuid;
begin
  if v_tenant is null or not public.academy_can_manage() then raise exception 'Only an owner or manager can set up the curriculum.'; end if;
  select id into v_id from public.academy_programs where tenant_id = v_tenant and is_default;
  if v_id is not null then return v_id; end if;

  insert into public.academy_programs (tenant_id, name, description, is_default)
  values (v_tenant, 'AI-Assisted Software Development Apprenticeship Program',
          'Learn → practice → submit → review → improve → evaluate → progress: from computer basics to real company projects with Claude Code.', true)
  returning id into v_id;

  insert into public.academy_modules (tenant_id, program_id, position, title, topics) values
    (v_tenant, v_id, 1, 'Computer & development fundamentals', array['Computer fundamentals', 'Internet basics', 'Files and folders', 'VS Code', 'Terminal / command line', 'Git', 'GitHub', 'Basic development workflow']),
    (v_tenant, v_id, 2, 'Programming fundamentals', array['HTML', 'CSS', 'JavaScript', 'Python basics', 'Variables', 'Functions', 'Conditions', 'Loops', 'APIs', 'JSON', 'Debugging']),
    (v_tenant, v_id, 3, 'AI fundamentals', array['What is generative AI', 'What are LLMs', 'How AI coding assistants work', 'Prompt engineering', 'Context windows', 'AI limitations', 'Hallucinations', 'AI-assisted development', 'Responsible AI use']),
    (v_tenant, v_id, 4, 'Claude Code', array['Introduction', 'Installation and setup', 'Project setup', 'Connecting repositories', 'Understanding existing code', 'Giving coding instructions', 'Creating features', 'Debugging', 'Refactoring', 'Testing', 'Git / GitHub workflow', 'Code review', 'Safe AI coding practices', 'Working with large projects']),
    (v_tenant, v_id, 5, 'AI-assisted web development', array['Website development', 'Frontend', 'Backend', 'Database', 'APIs', 'Authentication', 'Forms', 'CRUD', 'Deployment', 'Debugging with AI']),
    (v_tenant, v_id, 6, 'AI automation', array['Business automation', 'AI workflows', 'API automation', 'Data processing', 'Email automation', 'Google Workspace automation', 'AI agents', 'Workflow automation']),
    (v_tenant, v_id, 7, 'Real company projects', array['Supervised practical projects: objective, requirements, GitHub repository, tasks, review, final result']);
  return v_id;
end $$;

revoke all on function public.academy_my_apprentice_id(), public.academy_my_tenant_id(), public.academy_can_manage(),
  public.academy_staff_sees(uuid), public.academy_start_task(uuid), public.academy_submit_task(uuid, text, text, text),
  public.academy_review_task(uuid, text, text, int), public.academy_load_default_program() from public, anon;
grant execute on function public.academy_my_apprentice_id(), public.academy_my_tenant_id(), public.academy_can_manage(),
  public.academy_staff_sees(uuid), public.academy_start_task(uuid), public.academy_submit_task(uuid, text, text, text),
  public.academy_review_task(uuid, text, text, int), public.academy_load_default_program() to authenticated, service_role;
