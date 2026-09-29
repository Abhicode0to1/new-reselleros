-- Regression test: marketing campaigns + expenses.campaign_id (migration 20260926240000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/marketing_campaigns.test.sql
--
-- What it proves:
--   1. A company creates a campaign; the code must be link-safe and unique per company;
--      end cannot be before start.
--   2. An expense can be put against the company's own campaign — not another company's,
--      even by typing its id.
--   3. Deleting a campaign leaves the expense (money that left the bank) with no campaign.
--   4. Another company sees none of the campaigns.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000c9', 'CMP TEST A', 'cmp-a@example.in', '07'),
  ('bbbbbbbb-0000-0000-0000-0000000000c9', 'CMP TEST B', 'cmp-b@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000c9a9', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'cmp-a-user@example.in'),
  ('bbbbbbbb-0000-0000-0000-00000000c9b9', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'cmp-b-user@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000c9a9', 'aaaaaaaa-0000-0000-0000-0000000000c9', 'cmp-a-user@example.in', 'owner'),
  ('bbbbbbbb-0000-0000-0000-00000000c9b9', 'bbbbbbbb-0000-0000-0000-0000000000c9', 'cmp-b-user@example.in', 'owner');
insert into public.marketing_campaigns (id, tenant_id, name, code, start_date, end_date, budget) values
  ('bbbbbbbb-0000-0000-0000-0000000c0bb9', 'bbbbbbbb-0000-0000-0000-0000000000c9', 'B Diwali', 'diwali-2026', '2026-10-01', '2026-10-31', 5000);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000c9a9', 'role', 'authenticated')::text, true);

do $$
declare v_c uuid; v_e text; v_after uuid; n int;
begin
  -- 1
  insert into public.marketing_campaigns (tenant_id, name, code, start_date, end_date, budget, target_leads)
  values ('aaaaaaaa-0000-0000-0000-0000000000c9', 'Diwali offer', 'diwali-2026', '2026-10-01', '2026-10-31', 20000, 30)
  returning id into v_c;       -- same code as B's campaign: fine, unique per company
  begin
    insert into public.marketing_campaigns (tenant_id, name, code, start_date, end_date)
    values ('aaaaaaaa-0000-0000-0000-0000000000c9', 'Again', 'diwali-2026', '2026-10-01', '2026-10-31');
    raise exception 'FAIL 1a: duplicate code in one company';
  exception when unique_violation then null;
  end;
  begin
    insert into public.marketing_campaigns (tenant_id, name, code, start_date, end_date)
    values ('aaaaaaaa-0000-0000-0000-0000000000c9', 'Bad', 'Diwali 2026', '2026-10-01', '2026-10-31');
    raise exception 'FAIL 1b: unsafe code accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.marketing_campaigns (tenant_id, name, code, start_date, end_date)
    values ('aaaaaaaa-0000-0000-0000-0000000000c9', 'Back', 'back-2026', '2026-10-31', '2026-10-01');
    raise exception 'FAIL 1c: end before start accepted';
  exception when check_violation then null;
  end;

  -- 2
  v_e := 'EXP-CMPTEST-1';
  insert into public.expenses (id, tenant_id, category, amount, expense_date, campaign_id)
  values (v_e, 'aaaaaaaa-0000-0000-0000-0000000000c9', 'Advertising', 5900, '2026-10-05', v_c);
  begin
    update public.expenses set campaign_id = 'bbbbbbbb-0000-0000-0000-0000000c0bb9' where id = v_e;
    raise exception 'FAIL 2: expense pointed at another company''s campaign';
  exception when others then
    if sqlerrm not like 'Campaign not found%' then raise; end if;
  end;

  -- 3
  delete from public.marketing_campaigns where id = v_c;
  select campaign_id into v_after from public.expenses where id = v_e;
  select count(*) into n from public.expenses where id = v_e;
  if n <> 1 or v_after is not null then raise exception 'FAIL 3: expense % / campaign %', n, v_after; end if;

  -- 4
  select count(*) into n from public.marketing_campaigns;
  if n <> 0 then raise exception 'FAIL 4: A sees % campaigns (B''s must be hidden)', n; end if;
end $$;

select 'marketing_campaigns: all assertions passed' as result;
rollback;
