-- Editing an active project (R-004, 26 Sep 2026).
--
-- WHAT IT PROVES
--   1. THE CONTROL FIRST. An ordinary edit — new title, new value, re-planned
--      milestones — actually goes through and lands the right numbers. A guard that
--      refuses everything passes every "is it refused?" assertion below while making
--      the feature useless, and that failure only shows up in use (L107).
--   2. A value BELOW what is already invoiced or paid is refused.
--   3. A milestone that is already invoiced is never touched or renumbered.
--   4. Changing the value without sending a schedule is refused, rather than leaving
--      instalments that no longer add up to the total.
--   5. The customer cannot be swapped once a tax invoice exists.
--   6. A title-only edit leaves the money and the schedule alone.
--
-- The fixture owns its data (L11) and rolls back.
begin;

insert into public.tenants (id, name, email)
values ('dd000004-0000-4000-8000-000000000004', 'R004 Test Tenant', 'r004@test.invalid')
on conflict (id) do nothing;

insert into public.customers (id, tenant_id, name) values
  ('dd000004-0000-4000-8000-0000000000c1', 'dd000004-0000-4000-8000-000000000004', 'R004 First Customer'),
  ('dd000004-0000-4000-8000-0000000000c2', 'dd000004-0000-4000-8000-000000000004', 'R004 Second Customer');

-- Project A: nothing invoiced. The ordinary case.
insert into public.project_sales (id, tenant_id, customer_id, customer_name, title, taxable_amount, gst_amount, total_amount, gst_rate, status)
values ('dd000004-0000-4000-8000-0000000000a1', 'dd000004-0000-4000-8000-000000000004',
        'dd000004-0000-4000-8000-0000000000c1', 'R004 First Customer', 'ERP build', 200000, 36000, 236000, 18, 'active');

insert into public.project_milestones (id, tenant_id, project_id, label, total_amount, seq, status)
values
  ('dd000004-0000-4000-8000-00000000ee01', 'dd000004-0000-4000-8000-000000000004',
   'dd000004-0000-4000-8000-0000000000a1', 'Advance', 118000, 1, 'pending'),
  ('dd000004-0000-4000-8000-00000000ee02', 'dd000004-0000-4000-8000-000000000004',
   'dd000004-0000-4000-8000-0000000000a1', 'On delivery', 118000, 2, 'pending');

-- Project B: one milestone already invoiced and paid.
insert into public.project_sales (id, tenant_id, customer_id, customer_name, title, taxable_amount, gst_amount, total_amount, gst_rate, status)
values ('dd000004-0000-4000-8000-0000000000b1', 'dd000004-0000-4000-8000-000000000004',
        'dd000004-0000-4000-8000-0000000000c1', 'R004 First Customer', 'Website build', 100000, 18000, 118000, 18, 'active');

insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date)
values ('INV-R004-TEST-1', 'dd000004-0000-4000-8000-000000000004',
        'dd000004-0000-4000-8000-0000000000c1', 'R004 First Customer', 59000, 'paid', current_date);

insert into public.project_milestones (id, tenant_id, project_id, label, total_amount, seq, status, invoice_id)
values
  ('dd000004-0000-4000-8000-00000000ee03', 'dd000004-0000-4000-8000-000000000004',
   'dd000004-0000-4000-8000-0000000000b1', 'Advance', 59000, 1, 'paid', 'INV-R004-TEST-1'),
  ('dd000004-0000-4000-8000-00000000ee04', 'dd000004-0000-4000-8000-000000000004',
   'dd000004-0000-4000-8000-0000000000b1', 'On delivery', 59000, 2, 'pending', null);

insert into public.project_payments (tenant_id, project_id, milestone_id, amount, received_at)
values ('dd000004-0000-4000-8000-000000000004', 'dd000004-0000-4000-8000-0000000000b1',
        'dd000004-0000-4000-8000-00000000ee03', 59000, current_date);

do $$
declare
  v_total    integer;
  v_taxable  integer;
  v_gst      integer;
  v_title    text;
  v_cust     uuid;
  v_ms       integer;
  v_locked   integer;
  v_refused  boolean;
  v_msg      text;
begin
  -- 1. THE CONTROL. An ordinary edit must work.
  perform public.update_project_details(
    p_project_id   => 'dd000004-0000-4000-8000-0000000000a1',
    p_title        => 'ERP build (phase 2 added)',
    p_total_amount => 354000,
    p_milestones   => '[{"label":"Advance","total_amount":118000},
                        {"label":"On delivery","total_amount":118000},
                        {"label":"Phase 2","total_amount":118000}]'::jsonb);

  select title, total_amount, taxable_amount, gst_amount
    into v_title, v_total, v_taxable, v_gst
    from public.project_sales where id = 'dd000004-0000-4000-8000-0000000000a1';
  if v_title <> 'ERP build (phase 2 added)' then
    raise exception 'FAIL 1: the title did not change (got %)', v_title;
  end if;
  if v_total <> 354000 then
    raise exception 'FAIL 1b: total is %, expected 354000', v_total;
  end if;
  -- 354000 inclusive of 18% -> 300000 taxable + 54000 GST.
  if v_taxable <> 300000 or v_gst <> 54000 then
    raise exception 'FAIL 1c: GST split is %/% , expected 300000/54000', v_taxable, v_gst;
  end if;
  select count(*), coalesce(sum(total_amount), 0) into v_ms, v_locked
    from public.project_milestones where project_id = 'dd000004-0000-4000-8000-0000000000a1';
  if v_ms <> 3 or v_locked <> 354000 then
    raise exception 'FAIL 1d: schedule is % milestones totalling %, expected 3 totalling 354000', v_ms, v_locked;
  end if;

  -- 2. Below what is already invoiced or paid: refused.
  v_refused := false;
  begin
    perform public.update_project_details(
      p_project_id   => 'dd000004-0000-4000-8000-0000000000b1',
      p_total_amount => 20000,
      p_milestones   => '[{"label":"Rest","total_amount":20000}]'::jsonb);
  exception when others then
    v_refused := true; v_msg := SQLERRM;
  end;
  if not v_refused then
    raise exception 'FAIL 2: a total below the 59000 already invoiced and paid was accepted';
  end if;
  if position('credit-note' in v_msg) = 0 then
    -- Section 24: a block must say what to do next.
    raise exception 'FAIL 2b: the refusal does not say what to do instead: %', v_msg;
  end if;

  -- 3. The invoiced milestone survives a legal edit, untouched.
  perform public.update_project_details(
    p_project_id   => 'dd000004-0000-4000-8000-0000000000b1',
    p_total_amount => 177000,
    p_milestones   => '[{"label":"On delivery","total_amount":59000},
                        {"label":"Extra scope","total_amount":59000}]'::jsonb);

  select count(*) into v_ms from public.project_milestones
    where id = 'dd000004-0000-4000-8000-00000000ee03' and invoice_id = 'INV-R004-TEST-1'
      and total_amount = 59000 and seq = 1;
  if v_ms <> 1 then
    raise exception 'FAIL 3: the invoiced milestone was changed or removed';
  end if;
  select coalesce(sum(total_amount), 0) into v_locked
    from public.project_milestones where project_id = 'dd000004-0000-4000-8000-0000000000b1';
  if v_locked <> 177000 then
    raise exception 'FAIL 3b: the schedule totals % , not the new 177000', v_locked;
  end if;

  -- 4. Value moved with no schedule: refused rather than left inconsistent.
  v_refused := false;
  begin
    perform public.update_project_details(
      p_project_id   => 'dd000004-0000-4000-8000-0000000000a1',
      p_total_amount => 400000);
  exception when others then
    v_refused := true;
  end;
  if not v_refused then
    raise exception 'FAIL 4: the total changed with no milestones sent, so the instalments no longer add up';
  end if;

  -- 5. The customer cannot move once a tax invoice exists.
  v_refused := false;
  begin
    perform public.update_project_details(
      p_project_id   => 'dd000004-0000-4000-8000-0000000000b1',
      p_customer_id  => 'dd000004-0000-4000-8000-0000000000c2');
  exception when others then
    v_refused := true; v_msg := SQLERRM;
  end;
  if not v_refused then
    raise exception 'FAIL 5: the customer was swapped under an issued invoice';
  end if;
  if position('credit note' in v_msg) = 0 then
    raise exception 'FAIL 5b: the refusal does not point at a credit note: %', v_msg;
  end if;
  select customer_id into v_cust from public.project_sales
    where id = 'dd000004-0000-4000-8000-0000000000b1';
  if v_cust <> 'dd000004-0000-4000-8000-0000000000c1' then
    raise exception 'FAIL 5c: the customer moved anyway';
  end if;

  -- 5b. With nothing invoiced, the customer CAN move. The other half of the rule.
  perform public.update_project_details(
    p_project_id    => 'dd000004-0000-4000-8000-0000000000a1',
    p_customer_id   => 'dd000004-0000-4000-8000-0000000000c2',
    p_customer_name => 'R004 Second Customer');
  select customer_id into v_cust from public.project_sales
    where id = 'dd000004-0000-4000-8000-0000000000a1';
  if v_cust <> 'dd000004-0000-4000-8000-0000000000c2' then
    raise exception 'FAIL 5d: an un-invoiced project refused a customer change, which makes the feature useless';
  end if;

  -- 6. A title-only edit leaves the money and the schedule alone.
  perform public.update_project_details(
    p_project_id => 'dd000004-0000-4000-8000-0000000000a1',
    p_title      => 'ERP build (renamed)');
  select total_amount into v_total from public.project_sales
    where id = 'dd000004-0000-4000-8000-0000000000a1';
  select count(*) into v_ms from public.project_milestones
    where project_id = 'dd000004-0000-4000-8000-0000000000a1';
  if v_total <> 354000 or v_ms <> 3 then
    raise exception 'FAIL 6: a title-only edit changed the money (%) or the schedule (% milestones)', v_total, v_ms;
  end if;

  raise notice 'PASS: ordinary edits go through; invoiced milestones, issued invoices and the billed customer are all held in place';
end $$;

rollback;
