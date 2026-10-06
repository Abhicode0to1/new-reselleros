-- service_role can insert a lead (expression indexes call lead_norm_*). Rolled back; exit 0 = pass.
begin;
-- Mirror Cloud SQL: service_role has no default function grants there.
revoke execute on function public.lead_norm_phone(text), public.lead_norm_company(text), public.lead_norm_email(text), public.lead_norm_gstin(text) from service_role;
-- the migration under test (20261004120000):
grant execute on function public.lead_norm_phone(text) to service_role;
grant execute on function public.lead_norm_company(text) to service_role;
grant execute on function public.lead_norm_email(text) to service_role;
grant execute on function public.lead_norm_gstin(text) to service_role;
grant execute on function public.lead_looks_like_junk(text, text, text, text) to service_role;
insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-000000004120', 'SRLEAD', 'srlead@example.in', '07');
set local role service_role;
insert into public.leads (id, tenant_id, company, contact_name, contact_phone, source, stage)
values ('L-SRTEST-4120', 'aaaaaaaa-0000-0000-0000-000000004120', 'Test Co 4120', 'A Person', '+91 98100 00000', 'website', 'new');
update public.leads set contact_email = 'a@example.test' where id = 'L-SRTEST-4120';
reset role;
do $$ begin
  if not exists (select 1 from public.leads where id = 'L-SRTEST-4120') then
    raise exception 'FAIL: service_role lead insert did not land';
  end if;
end $$;
rollback;
