-- 4 Oct 2026 — interns / trainees on a stipend (Pardeep: "normal trainee/intern ka system
-- banao pehle, apprentice baad me jab registration kara lenge").
--
-- An intern or trainee here is NOT an apprentice under the Apprentices Act, 1961, so the
-- Act's PF / ESI exclusion does not apply: a trainee paid a stipend can still be an
-- "employee" for EPF / ESI. So nothing here forces PF / ESI off — the existing per-person
-- toggles stay the owner's call (with his CA). What changes:
--   · employees.engagement_type 'employee' | 'intern', with training dates and the area /
--     institute, so interns are listed and counted apart from staff;
--   · they are paid through the same pay_salary RPC, and the expense it books is re-filed
--     from 'Salaries' to 'Stipend — Interns & Trainees' by a trigger. pay_salary itself (an
--     18-argument money function) is NOT rewritten — the trigger changes one column of the
--     row it just wrote, in the same transaction.
-- Apprentices (Apprentices Act / portal registration) come later as a third type.

alter table public.employees
  add column if not exists engagement_type    text not null default 'employee',
  add column if not exists training_start     date,
  add column if not exists training_end       date,
  add column if not exists training_area      text,
  add column if not exists training_institute text;

alter table public.employees drop constraint if exists employees_engagement_type_check;
alter table public.employees add constraint employees_engagement_type_check
  check (engagement_type in ('employee', 'intern'));

alter table public.employees drop constraint if exists employees_training_dates;
alter table public.employees add constraint employees_training_dates
  check (training_end is null or training_start is null or training_end >= training_start);

comment on column public.employees.engagement_type is
  'employee | intern (intern / trainee on a stipend; booked as "Stipend — Interns & Trainees"). Not an Apprentices-Act apprentice: PF/ESI follow the per-person flags.';

create or replace function public.tg_salary_payment_intern_refile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.expense_id is not null
     and exists (select 1 from public.employees where id = new.employee_id and engagement_type = 'intern') then
    update public.expenses
       set category    = 'Stipend — Interns & Trainees',
           description = regexp_replace(coalesce(description, ''), '^Salary ', 'Stipend ')
     where id = new.expense_id and tenant_id = new.tenant_id and category = 'Salaries';
  end if;
  return new;
end $$;

drop trigger if exists trg_salary_payment_intern_refile on public.salary_payments;
create trigger trg_salary_payment_intern_refile
  after insert on public.salary_payments
  for each row execute function public.tg_salary_payment_intern_refile();

revoke all on function public.tg_salary_payment_intern_refile() from public;
