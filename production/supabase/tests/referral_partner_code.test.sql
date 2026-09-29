-- Regression test: referral partner share codes (migration 20260926210000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/referral_partner_code.test.sql
--
-- What it proves:
--   1. A new partner gets a code from its name, link-safe (a-z, 0-9, hyphen).
--   2. A second partner with the same name in the same company gets a suffixed code.
--   3. Another company can use the same code (unique per company only).
--   4. A code typed by hand is cleaned to the same shape and must stay unique.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000f1', 'REF TEST A', 'ref-a@example.in', '07'),
  ('bbbbbbbb-0000-0000-0000-0000000000f1', 'REF TEST B', 'ref-b@example.in', '07');

do $$
declare c1 text; c2 text; c3 text; c4 text;
begin
  insert into public.referral_partners (tenant_id, name) values ('aaaaaaaa-0000-0000-0000-0000000000f1', 'Ramesh Kumar & Sons!') returning code into c1;
  if c1 is distinct from 'ramesh-kumar-sons' then raise exception 'FAIL 1: %', c1; end if;

  insert into public.referral_partners (tenant_id, name) values ('aaaaaaaa-0000-0000-0000-0000000000f1', 'Ramesh Kumar & Sons') returning code into c2;
  if c2 is distinct from 'ramesh-kumar-sons-2' then raise exception 'FAIL 2: %', c2; end if;

  insert into public.referral_partners (tenant_id, name) values ('bbbbbbbb-0000-0000-0000-0000000000f1', 'Ramesh Kumar & Sons') returning code into c3;
  if c3 is distinct from 'ramesh-kumar-sons' then raise exception 'FAIL 3: %', c3; end if;

  insert into public.referral_partners (tenant_id, name, code) values ('aaaaaaaa-0000-0000-0000-0000000000f1', 'Suresh', ' Suresh CA ') returning code into c4;
  if c4 is distinct from 'suresh-ca' then raise exception 'FAIL 4a: %', c4; end if;
  begin
    insert into public.referral_partners (tenant_id, name, code) values ('aaaaaaaa-0000-0000-0000-0000000000f1', 'Other', 'suresh-ca');
    raise exception 'FAIL 4b: duplicate hand-typed code accepted';
  exception when unique_violation then null;
  end;
end $$;

select 'referral_partner_code: all assertions passed' as result;
rollback;
