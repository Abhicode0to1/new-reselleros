-- provisioning_requests: a tenant member may complete a request, not rewrite
-- what was paid for.
--
-- THE HOLE THIS COVERS
--   `provisioning_requests_update` permits any tenant member to update any row
--   in their tenant, and its WITH CHECK validates only `tenant_id` — so every
--   column was writable. `listReadyHostingRequests` picks the rows a worker may
--   provision with `.eq("payment_mode","live").is("blocker",null)`, so a member
--   could take a `test` row (a payment that settled ZERO rupees), set it to
--   'live', clear the blocker, and have real hosting provisioned for free.
--
-- WHY THE ORDER OF THE ASSERTIONS MATTERS
--   The legitimate update is asserted FIRST, and the visible-row count before
--   that. Without both, "ERROR" and "UPDATE 0" are indistinguishable from the
--   guard working — and the first two attempts at this test proved exactly
--   nothing for exactly that reason: once the fixture aborted on a NOT NULL
--   column, and once the member had no `public.users` row so
--   `current_tenant_id()` was null and RLS hid everything (AGENTS.md L10, L14).
--
-- The fixture owns its data (AGENTS.md L11): literal reserved-range ids, its
-- own tenant, its own auth user. It borrows nothing from the live tenant, so
-- it cannot be broken by what an operator did last week.
begin;

insert into auth.users (id, instance_id, aud, role, email)
values ('eeeeeeee-0000-0000-0000-00000000e001',
        '00000000-0000-0000-0000-000000000000',
        'authenticated','authenticated','member@test.invalid')
on conflict (id) do nothing;

insert into public.tenants (id, name, email)
values ('dddddddd-0000-0000-0000-00000000d001','Guard Test Tenant','guard@test.invalid')
on conflict (id) do nothing;

-- current_tenant_id() reads public.users by auth.uid(); without this row the
-- member sees nothing and every assertion below passes vacuously.
insert into public.users (id, tenant_id, email)
values ('eeeeeeee-0000-0000-0000-00000000e001',
        'dddddddd-0000-0000-0000-00000000d001','member@test.invalid')
on conflict (id) do nothing;

insert into public.quotes (id, tenant_id, customer_name)
values ('QG-IMMUT-1','dddddddd-0000-0000-0000-00000000d001','Guard Test Customer');

insert into public.provisioning_requests
  (tenant_id, quote_id, vendor, seats, amount_paid, payment_mode, status, blocker)
values
  ('dddddddd-0000-0000-0000-00000000d001','QG-IMMUT-1','google',5,0,'test','queued','test payment');

set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('sub','eeeeeeee-0000-0000-0000-00000000e001','role','authenticated')::text,
  true
);

do $$
declare
  v_visible int;
  v_updated int;
  v_err     boolean;
  v_mode    text;
begin
  -- SETUP: the row must be reachable as this member.
  select count(*) into v_visible from public.provisioning_requests where quote_id = 'QG-IMMUT-1';
  if v_visible <> 1 then
    raise exception
      'SETUP FAIL: the member sees % provisioning_requests rows, not 1 — RLS is hiding it, '
      'so a refused UPDATE below would prove nothing', v_visible;
  end if;

  -- SETUP: a legitimate update must SUCCEED, or "refused" is indistinguishable
  -- from "matched no rows".
  update public.provisioning_requests
     set status = 'activated', activated_at = now(), vendor_ref = 'GW-123', note = 'by hand'
   where quote_id = 'QG-IMMUT-1';
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception
      'SETUP FAIL: the normal complete-a-request workflow updated % rows, not 1 — this guard '
      'has broken the thing it is supposed to leave alone', v_updated;
  end if;
  update public.provisioning_requests set status = 'queued', activated_at = null, vendor_ref = null
   where quote_id = 'QG-IMMUT-1';

  -- 1. payment_mode: the column that decides whether seats are given away.
  v_err := false;
  begin
    update public.provisioning_requests set payment_mode = 'live' where quote_id = 'QG-IMMUT-1';
  exception when others then v_err := true; end;
  if not v_err then
    raise exception 'FAIL: a tenant member changed payment_mode — a test payment can be activated';
  end if;
  select payment_mode into v_mode from public.provisioning_requests where quote_id = 'QG-IMMUT-1';
  if v_mode <> 'test' then
    raise exception 'FAIL: payment_mode is now % — the refusal did not hold', v_mode;
  end if;
  raise notice 'PASS: payment_mode is not writable by a tenant member';

  -- 2. blocker: the other half of the same WHERE clause. Locking only
  --    payment_mode would leave the identical bypass one column to the left.
  v_err := false;
  begin
    update public.provisioning_requests set blocker = null where quote_id = 'QG-IMMUT-1';
  exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL: a tenant member cleared blocker'; end if;
  raise notice 'PASS: blocker is not writable by a tenant member';

  -- 3. seats / amount_paid / vendor / quote_id: the record of what was bought.
  foreach v_mode in array array['seats','amount_paid','vendor'] loop
    v_err := false;
    begin
      if v_mode = 'seats' then
        update public.provisioning_requests set seats = 500 where quote_id = 'QG-IMMUT-1';
      elsif v_mode = 'amount_paid' then
        update public.provisioning_requests set amount_paid = 999999 where quote_id = 'QG-IMMUT-1';
      else
        update public.provisioning_requests set vendor = 'microsoft' where quote_id = 'QG-IMMUT-1';
      end if;
    exception when others then v_err := true; end;
    if not v_err then raise exception 'FAIL: a tenant member changed %', v_mode; end if;
    raise notice 'PASS: % is not writable by a tenant member', v_mode;
  end loop;

  raise notice 'PASS: provisioning facts are immutable to a tenant member, and the complete-a-request workflow still works';
end $$;

select 'PASS provisioning_facts_immutable' as result;

rollback;
