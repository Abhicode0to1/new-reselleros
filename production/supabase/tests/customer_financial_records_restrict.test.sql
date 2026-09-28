-- A customer cannot disappear from under its financial records (R-007, 26 Sep 2026).
--
-- WHAT IT PROVES
--   1. An EMPTY customer still deletes. Asserted FIRST and on purpose (L107): a wall
--      that refuses everything passes every "is it refused?" test, and the damage —
--      nobody can ever delete a mistyped customer — only shows up in use.
--   2. A customer with an invoice is refused by the DATABASE, not merely by the RPC.
--      That is the whole point of R-007: `delete_customer` was one door, and a plain
--      `delete from public.customers` walked straight past it. Measured on this
--      database on 25 Sep 2026, four customers deleted that way detached five quotes.
--   3. A subscription BLOCKS the delete instead of being destroyed by it. This is the
--      change with teeth — the old CASCADE erased recurring revenue and its renewals
--      without a word.
--   4. `delete_customer` counts credit notes, debit notes and TDS entries. It never
--      did, so a customer holding only those passed the friendly check and would then
--      hit the new keys — two guards disagreeing is how one of them gets deleted as a
--      nuisance.
--
-- The fixture owns its data (L11): its own tenant, its own customers, literal ids.
-- Runs as the connection role and rolls back.
begin;

insert into public.tenants (id, name, email)
values ('dd000007-0000-4000-8000-000000000007', 'R007 Test Tenant', 'r007@test.invalid')
on conflict (id) do nothing;

insert into public.customers (id, tenant_id, name) values
  ('dd000007-0000-4000-8000-0000000000e1', 'dd000007-0000-4000-8000-000000000007', 'R007 Empty Customer'),
  ('dd000007-0000-4000-8000-0000000000a1', 'dd000007-0000-4000-8000-000000000007', 'R007 Invoiced Customer'),
  ('dd000007-0000-4000-8000-0000000000b1', 'dd000007-0000-4000-8000-000000000007', 'R007 Subscribed Customer'),
  ('dd000007-0000-4000-8000-0000000000c1', 'dd000007-0000-4000-8000-000000000007', 'R007 Credit Note Customer');

insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date)
values ('INV-R007-TEST-1', 'dd000007-0000-4000-8000-000000000007',
        'dd000007-0000-4000-8000-0000000000a1', 'R007 Invoiced Customer', 11800, 'pending', current_date);

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status)
values ('dd000007-0000-4000-8000-00000000005b', 'dd000007-0000-4000-8000-000000000007',
        'dd000007-0000-4000-8000-0000000000b1', 'R007 Subscribed Customer',
        'Google Workspace Business Starter', 'google', 2, 528, 'active');

insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date)
values ('INV-R007-TEST-2', 'dd000007-0000-4000-8000-000000000007',
        'dd000007-0000-4000-8000-0000000000c1', 'R007 Credit Note Customer', 5900, 'pending', current_date);

insert into public.credit_notes (id, tenant_id, invoice_id, customer_id, amount, taxable_value, tax_amount, tax_rate)
values ('CN-R007-TEST-1', 'dd000007-0000-4000-8000-000000000007', 'INV-R007-TEST-2',
        'dd000007-0000-4000-8000-0000000000c1', 1180, 1000, 180, 18);

do $$
declare
  v_left    integer;
  v_refused boolean;
  v_msg     text;
begin
  -- ── 1. THE CONTROL. An empty customer must still be deletable. ───────────
  delete from public.customers where id = 'dd000007-0000-4000-8000-0000000000e1';
  select count(*) into v_left from public.customers
    where id = 'dd000007-0000-4000-8000-0000000000e1';
  if v_left <> 0 then
    raise exception 'FAIL 1: an empty customer could not be deleted — the wall refuses everything, which is not the ask';
  end if;

  -- ── 2. The database itself refuses a customer that has an invoice ────────
  v_refused := false;
  begin
    delete from public.customers where id = 'dd000007-0000-4000-8000-0000000000a1';
  exception when foreign_key_violation then
    v_refused := true;
  end;
  if not v_refused then
    raise exception 'FAIL 2: a customer with an invoice was deleted by a plain DELETE — the invoice is now orphaned';
  end if;

  -- ── 3. A subscription blocks, and is NOT destroyed ───────────────────────
  v_refused := false;
  begin
    delete from public.customers where id = 'dd000007-0000-4000-8000-0000000000b1';
  exception when foreign_key_violation then
    v_refused := true;
  end;
  if not v_refused then
    raise exception 'FAIL 3: a customer with a subscription was deleted — the old CASCADE is still in place';
  end if;
  select count(*) into v_left from public.subscriptions
    where id = 'dd000007-0000-4000-8000-00000000005b';
  if v_left <> 1 then
    raise exception 'FAIL 3b: the subscription is gone (% rows) — recurring revenue was erased by a customer delete', v_left;
  end if;

  -- ── 4. delete_customer counts a credit note ──────────────────────────────
  --     It is called as service_role so the tenant check is skipped; what is under
  --     test is the COUNT, not the RLS scoping, which its own guard covers.
  v_refused := false;
  begin
    perform set_config('request.jwt.claims',
      json_build_object('role','service_role')::text, true);
    perform public.delete_customer('dd000007-0000-4000-8000-0000000000c1');
  exception when others then
    v_refused := true;
    v_msg := SQLERRM;
  end;
  if not v_refused then
    raise exception 'FAIL 4: delete_customer allowed a customer holding a credit note';
  end if;
  if position('credit note' in v_msg) = 0 then
    raise exception 'FAIL 4b: delete_customer refused, but for the wrong reason: %', v_msg;
  end if;
  if position('Archive' in v_msg) = 0 then
    -- §7: a block must say what to do next, not only that it happened.
    raise exception 'FAIL 4c: the refusal does not tell the operator what to do instead: %', v_msg;
  end if;

  raise notice 'PASS: empty customers still delete; invoices, subscriptions and credit notes all hold the customer in place';
end $$;

rollback;
