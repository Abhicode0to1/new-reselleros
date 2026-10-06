-- R-135: a lead's contact is made when its email/phone arrives after the save (migration
-- 20261003120000). Rolled back.
-- Proves:
--   1. a lead saved with no email/phone has no contact (no name-only matching);
--   2. adding a phone later links a contact carrying that phone;
--   3. a second lead with the same phone reuses that contact;
--   4. marking Won does NOT create a customer (customers come from accept/payment only).
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.tenants (id,name,email,state_code,doc_code) values ('11110000-0000-0000-0000-0000000001c5','LC','lc@x.in','07','LCA1');

do $$
declare c1 text; c2 text; cust int; ph text;
begin
  insert into public.leads (id,tenant_id,company,stage,source,priority)
  values ('L-LC1','11110000-0000-0000-0000-0000000001c5','demo','new','manual','medium');
  select contact_id into c1 from public.leads where id='L-LC1';
  if c1 is not null then raise exception 'FAIL 1: name-only lead got contact %', c1; end if;

  update public.leads set contact_phone='+91 98100 11122' where id='L-LC1';
  select contact_id into c1 from public.leads where id='L-LC1';
  if c1 is null then raise exception 'FAIL 2: phone added later did not link a contact'; end if;
  select phone into ph from public.contacts where id=c1;
  if ph is null or ph not like '%98100%' then raise exception 'FAIL 2: contact phone is %', ph; end if;

  insert into public.leads (id,tenant_id,company,contact_phone,stage,source,priority)
  values ('L-LC2','11110000-0000-0000-0000-0000000001c5','Other Co','9810011122','new','manual','medium');
  select contact_id into c2 from public.leads where id='L-LC2';
  if c2 is distinct from c1 then raise exception 'FAIL 3: same phone made a second contact (% vs %)', c2, c1; end if;

  update public.leads set stage='won' where id='L-LC1';
  select count(*) into cust from public.customers where tenant_id='11110000-0000-0000-0000-0000000001c5';
  if cust <> 0 then raise exception 'FAIL 4: Won created % customer(s)', cust; end if;

  raise notice 'PASS lead_always_has_contact (4/4)';
end $$;
rollback;
