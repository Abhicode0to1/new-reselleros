-- R-031 (5 Oct 2026): provisioning_requests.years, and the guard that now also locks
-- domain / plan / years against a tenant member.
--
-- Self-asserting, rolled back. Errors are matched on the guard's own wording ("cannot be
-- edited here"), not on "0 rows changed", which would also pass if RLS hid the row.
begin;

insert into auth.users (id, instance_id, aud, role, email)
values ('eeeeeeee-0000-0000-0000-00000000e031',
        '00000000-0000-0000-0000-000000000000',
        'authenticated','authenticated','years-member@test.invalid')
on conflict (id) do nothing;

insert into public.tenants (id, name, email)
values ('dddddddd-0000-0000-0000-00000000d031','Years Test Tenant','years@test.invalid')
on conflict (id) do nothing;

insert into public.users (id, tenant_id, email)
values ('eeeeeeee-0000-0000-0000-00000000e031',
        'dddddddd-0000-0000-0000-00000000d031','years-member@test.invalid')
on conflict (id) do nothing;

insert into public.quotes (id, tenant_id, customer_name)
values ('QG-YEARS-1','dddddddd-0000-0000-0000-00000000d031','Years Test Customer'),
       ('QG-YEARS-2','dddddddd-0000-0000-0000-00000000d031','Years Test Customer');

-- 1. As the webhook writes them (service side): no years → 1; years 3 → 3; out of range → refused.
insert into public.provisioning_requests
  (tenant_id, quote_id, vendor, seats, domain, amount_paid, payment_mode, status)
values
  ('dddddddd-0000-0000-0000-00000000d031','QG-YEARS-1','domain',1,'one-year.in',900,'live','queued');
insert into public.provisioning_requests
  (tenant_id, quote_id, vendor, seats, domain, amount_paid, payment_mode, status, years)
values
  ('dddddddd-0000-0000-0000-00000000d031','QG-YEARS-2','domain',1,'three-year.in',2700,'live','queued',3);

do $$
declare v_y int; v_err text;
begin
  select years into v_y from public.provisioning_requests where quote_id = 'QG-YEARS-1';
  if v_y is distinct from 1 then raise exception 'FAIL: a row written without years has years = %, not 1', v_y; end if;
  select years into v_y from public.provisioning_requests where quote_id = 'QG-YEARS-2';
  if v_y is distinct from 3 then raise exception 'FAIL: a 3-year row reads years = %', v_y; end if;
  raise notice 'PASS: years defaults to 1 and keeps 3';

  foreach v_y in array array[0, 11] loop
    v_err := null;
    begin
      insert into public.provisioning_requests
        (tenant_id, quote_id, vendor, seats, domain, amount_paid, payment_mode, status, years)
      values ('dddddddd-0000-0000-0000-00000000d031','QG-YEARS-1','domain',1,'bad-' || v_y || '.in',1,'live','queued',v_y);
    exception when check_violation then v_err := sqlerrm; end;
    if v_err is null or v_err not like '%provisioning_requests_years_range%' then
      raise exception 'FAIL: years = % was accepted (or refused for another reason: %)', v_y, v_err;
    end if;
  end loop;
  raise notice 'PASS: years outside 1–10 is refused by provisioning_requests_years_range';
end $$;

-- 2. As a tenant member.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('sub','eeeeeeee-0000-0000-0000-00000000e031','role','authenticated')::text,
  true
);

do $$
declare v_visible int; v_col text; v_err text; v_status text;
begin
  select count(*) into v_visible from public.provisioning_requests where quote_id = 'QG-YEARS-2';
  if v_visible <> 1 then
    raise exception 'SETUP FAIL: the member sees % rows, not 1 — a refusal below would prove nothing', v_visible;
  end if;

  foreach v_col in array array['years','domain','plan'] loop
    v_err := null;
    begin
      if v_col = 'years' then
        update public.provisioning_requests set years = 10 where quote_id = 'QG-YEARS-2';
      elsif v_col = 'domain' then
        update public.provisioning_requests set domain = 'someone-elses.com' where quote_id = 'QG-YEARS-2';
      else
        update public.provisioning_requests set plan = 'domain-renewal' where quote_id = 'QG-YEARS-2';
      end if;
    exception when check_violation then v_err := sqlerrm; end;
    if v_err is null or v_err not like '%cannot be edited here%' then
      raise exception 'FAIL: a tenant member changed % (error: %)', v_col, coalesce(v_err, 'none');
    end if;
    raise notice 'PASS: % is not writable by a tenant member', v_col;
  end loop;

  -- The complete-a-request workflow still works.
  update public.provisioning_requests set status = 'activated', vendor_ref = 'RC-1', note = 'done by hand'
   where quote_id = 'QG-YEARS-2';
  select status into v_status from public.provisioning_requests where quote_id = 'QG-YEARS-2';
  if v_status is distinct from 'activated' then
    raise exception 'FAIL: the member could not tick the row off (status = %)', v_status;
  end if;
  raise notice 'PASS: status / vendor_ref / note stay writable';
end $$;

select 'PASS provisioning_requests_years' as result;

rollback;
