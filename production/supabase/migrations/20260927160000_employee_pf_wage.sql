-- PF wages = Basic + DA, not gross (27 Sep 2026).
--
-- EPF contribution is on basic wages + dearness allowance (+ retaining allowance),
-- capped at the wage ceiling — not on HRA, conveyance or special allowance. Payroll
-- computed it on the whole gross, so anyone with a gross above the ceiling but a
-- Basic below it had too much PF cut, and the ECR did not match the payslip.
--
-- The employee master now carries Basic and DA per month. Both optional for old
-- rows: with no Basic the app keeps computing on gross (and says so on the form),
-- so nothing changes silently for an employee nobody has set up yet.

alter table public.employees
  add column if not exists basic_monthly integer,
  add column if not exists da_monthly integer not null default 0;
alter table public.employees drop constraint if exists employees_basic_da_nonneg;
alter table public.employees add constraint employees_basic_da_nonneg
  check ((basic_monthly is null or basic_monthly >= 0) and da_monthly >= 0);
