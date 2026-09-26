-- provisioning_requests: one request per PRODUCT in a paid quote (24 Sep 2026).
--
-- WHAT IT PROVES
--   1. A domain and a hosting account paid for in ONE quote both get a request.
--      Under the old one-per-quote index the second insert failed, so the paid
--      domain in a domain + hosting cart was queued for nobody.
--   2. A re-delivered payment event — the same (quote, vendor, domain) again — is
--      still refused with 23505. That is what the old index was for, and it must
--      survive: two rows would mean two registrations for one payment.
--   3. The same domain differing only by case is the same product.
--
-- Order matters (L14): the inserts that must SUCCEED are asserted first, so a
-- refusal below cannot be an index that rejects everything.
--
-- The fixture owns its data (L11). Runs as the connection role and rolls back.
begin;

insert into public.tenants (id, name, email)
values ('dddddddd-0000-0000-0000-00000000d0a1','Per Product Test Tenant','perproduct@test.invalid')
on conflict (id) do nothing;

insert into public.quotes (id, tenant_id, customer_name)
values ('QG-PERPROD-1','dddddddd-0000-0000-0000-00000000d0a1','Per Product Customer');

do $$
declare
  v_rows int;
  v_dup  boolean;
begin
  -- 1. Two products, one quote: both must go in.
  insert into public.provisioning_requests
    (tenant_id, quote_id, vendor, seats, domain, amount_paid, payment_mode, status)
  values
    ('dddddddd-0000-0000-0000-00000000d0a1','QG-PERPROD-1','domain', 1,'acme.in',708,'test','queued'),
    ('dddddddd-0000-0000-0000-00000000d0a1','QG-PERPROD-1','hosting',1,'acme.in',708,'test','queued');
  select count(*) into v_rows from public.provisioning_requests where quote_id = 'QG-PERPROD-1';
  if v_rows <> 2 then
    raise exception 'FAIL 1: a domain and a hosting account in one quote gave % requests, not 2', v_rows;
  end if;

  -- Two different domains in one quote: both must go in too.
  insert into public.provisioning_requests
    (tenant_id, quote_id, vendor, seats, domain, amount_paid, payment_mode, status)
  values ('dddddddd-0000-0000-0000-00000000d0a1','QG-PERPROD-1','domain',1,'acme.com',708,'test','queued');

  -- 2. The same product again (a re-delivered Razorpay event) must be refused.
  v_dup := false;
  begin
    insert into public.provisioning_requests
      (tenant_id, quote_id, vendor, seats, domain, amount_paid, payment_mode, status)
    values ('dddddddd-0000-0000-0000-00000000d0a1','QG-PERPROD-1','domain',1,'acme.in',708,'test','queued');
  exception when unique_violation then
    v_dup := true;
  end;
  if not v_dup then
    raise exception 'FAIL 2: the same (quote, vendor, domain) was accepted twice — a re-delivered event would register a domain twice';
  end if;

  -- 3. Case does not make a new product.
  v_dup := false;
  begin
    insert into public.provisioning_requests
      (tenant_id, quote_id, vendor, seats, domain, amount_paid, payment_mode, status)
    values ('dddddddd-0000-0000-0000-00000000d0a1','QG-PERPROD-1','domain',1,'ACME.IN',708,'test','queued');
  exception when unique_violation then
    v_dup := true;
  end;
  if not v_dup then
    raise exception 'FAIL 3: ACME.IN was accepted beside acme.in — case must not make a second product';
  end if;

  -- A request with no domain is one key as well (a licence before the domain is known).
  insert into public.provisioning_requests
    (tenant_id, quote_id, vendor, seats, amount_paid, payment_mode, status)
  values ('dddddddd-0000-0000-0000-00000000d0a1','QG-PERPROD-1','google',5,0,'test','queued');
  v_dup := false;
  begin
    insert into public.provisioning_requests
      (tenant_id, quote_id, vendor, seats, amount_paid, payment_mode, status)
    values ('dddddddd-0000-0000-0000-00000000d0a1','QG-PERPROD-1','google',5,0,'test','queued');
  exception when unique_violation then
    v_dup := true;
  end;
  if not v_dup then
    raise exception 'FAIL 4: two domain-less requests for the same vendor were both accepted';
  end if;
end $$;

select 'PASS provisioning_one_per_product' as result;

rollback;
