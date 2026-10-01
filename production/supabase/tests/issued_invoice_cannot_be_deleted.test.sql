-- Regression test: an ISSUED invoice cannot be deleted, and deleting a DRAFT one never
-- removes a payment. Migration 20260930171000 (R-014). Rolled back — safe on production.
--
-- Proves all four directions, because a guard is only half-tested by what it blocks:
--
--   BLOCKED  a raw DELETE on a pending / paid / overdue / void invoice (the trigger —
--            the floor, whatever route the delete came from)
--   BLOCKED  delete_subscription_invoice and delete_project_invoice on an issued one,
--            with a message that names the way out
--   BLOCKED  deleting a DRAFT project invoice that has payments against its milestones
--   ALLOWED  deleting a genuine draft, and a reviewed delete under the escape hatch
--
-- The ALLOWED half is the one that catches an over-tightened guard (L28): if a draft
-- cannot be deleted, the operator has no way to discard a mistake before it is issued,
-- and the first thing anybody will do is weaken the whole rule.
--
-- Fixture owns all its data (L11): its own tenant, customer, project and milestones,
-- with literal ids in a reserved-looking range. It borrows nothing from the live books.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('d0d0d0d0-0000-4000-8000-000000000001', 'DELETE GUARD TEST', 'del@example.in', '07', 'DELT');
insert into public.customers (id, tenant_id, name, state_code)
  values ('d0d0d0d0-0000-4000-8000-0000000000c1', 'd0d0d0d0-0000-4000-8000-000000000001', 'Cust Del', '07');

-- One invoice per status, so the guard is exercised on every non-draft value the enum
-- has rather than on the one somebody happened to think of.
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, paid_amount, adjusted_advances)
values
  ('INV-DELT-27-0001', 'd0d0d0d0-0000-4000-8000-000000000001', 'd0d0d0d0-0000-4000-8000-0000000000c1', 'Cust Del', 118000, 'pending', current_date, 0, '[]'::jsonb),
  ('INV-DELT-27-0002', 'd0d0d0d0-0000-4000-8000-000000000001', 'd0d0d0d0-0000-4000-8000-0000000000c1', 'Cust Del', 118000, 'paid',    current_date, 118000, '[]'::jsonb),
  ('INV-DELT-27-0003', 'd0d0d0d0-0000-4000-8000-000000000001', 'd0d0d0d0-0000-4000-8000-0000000000c1', 'Cust Del', 118000, 'overdue', current_date, 0, '[]'::jsonb),
  ('INV-DELT-27-0004', 'd0d0d0d0-0000-4000-8000-000000000001', 'd0d0d0d0-0000-4000-8000-0000000000c1', 'Cust Del', 118000, 'void',    current_date, 0, '[]'::jsonb),
  -- The drafts. One plain, one attached to a project with a payment against it.
  ('INV-DELT-27-0005', 'd0d0d0d0-0000-4000-8000-000000000001', 'd0d0d0d0-0000-4000-8000-0000000000c1', 'Cust Del', 118000, 'draft',   current_date, 0, '[]'::jsonb),
  ('INV-DELT-27-0006', 'd0d0d0d0-0000-4000-8000-000000000001', 'd0d0d0d0-0000-4000-8000-0000000000c1', 'Cust Del', 118000, 'draft',   current_date, 0, '[]'::jsonb),
  ('INV-DELT-27-0007', 'd0d0d0d0-0000-4000-8000-000000000001', 'd0d0d0d0-0000-4000-8000-0000000000c1', 'Cust Del', 118000, 'draft',   current_date, 0, '[]'::jsonb);

insert into public.project_sales (id, tenant_id, customer_id, customer_name, title, taxable_amount, gst_amount, total_amount, status)
  values ('d0d0d0d0-0000-4000-8000-00000000000a', 'd0d0d0d0-0000-4000-8000-000000000001',
          'd0d0d0d0-0000-4000-8000-0000000000c1', 'Cust Del', 'Delete guard project', 200000, 36000, 236000, 'active');

-- Milestone 1 → the DRAFT invoice that carries a payment (must be refused).
-- Milestone 2 → a clean DRAFT invoice with no payment (must delete).
insert into public.project_milestones (id, tenant_id, project_id, seq, label, total_amount, status, invoice_id)
values
  ('d0d0d0d0-0000-4000-8000-00000000000b', 'd0d0d0d0-0000-4000-8000-000000000001', 'd0d0d0d0-0000-4000-8000-00000000000a', 1, 'Advance', 118000, 'invoiced', 'INV-DELT-27-0006'),
  ('d0d0d0d0-0000-4000-8000-00000000000c', 'd0d0d0d0-0000-4000-8000-000000000001', 'd0d0d0d0-0000-4000-8000-00000000000a', 2, 'Balance', 118000, 'invoiced', 'INV-DELT-27-0007');

-- A real receipt: money in the bank against milestone 1.
insert into public.project_payments (id, tenant_id, project_id, milestone_id, amount, method, received_at)
  values ('d0d0d0d0-0000-4000-8000-00000000000d', 'd0d0d0d0-0000-4000-8000-000000000001',
          'd0d0d0d0-0000-4000-8000-00000000000a', 'd0d0d0d0-0000-4000-8000-00000000000b',
          118000, 'bank_transfer', current_date);

/* `sync_project_invoice_paid` fires on that insert and moves INV-DELT-27-0006 to 'paid',
   so in ordinary use the STATUS guard would already refuse this one. Forced back to
   'draft' here on purpose: the payments guard is the second lock, and a second lock that
   is only ever reached through the first is a lock nobody has tested. If the status rule
   is ever loosened, this block is what still stands between a button press and a deleted
   bank receipt. (The freeze trigger permits a status change — status is lifecycle, not a
   Rule 46 particular.) */
update public.invoices set status = 'draft' where id = 'INV-DELT-27-0006';

do $$
declare
  v_err boolean;
  v_msg text;
  v_n   int;
  v_id  text;
begin
  -- ── SETUP GUARD (L14): prove the rows are reachable before asserting on refusals ──
  select count(*) into v_n from public.invoices where tenant_id = 'd0d0d0d0-0000-4000-8000-000000000001';
  if v_n <> 7 then
    raise exception 'SETUP FAIL: expected 7 fixture invoices, saw % — the asserts below would prove nothing', v_n;
  end if;

  -- ── BLOCKED: a raw DELETE on every non-draft status ───────────────────────
  foreach v_id in array array['INV-DELT-27-0001','INV-DELT-27-0002','INV-DELT-27-0003','INV-DELT-27-0004'] loop
    v_err := false;
    begin
      delete from public.invoices where id = v_id;
    exception when others then v_err := true; v_msg := sqlerrm; end;
    if not v_err then
      raise exception 'FAIL 1: issued invoice % was deleted by a plain DELETE', v_id;
    end if;
    /* §24 — the refusal has to lead somewhere. "Not allowed" on a money guard sends the
       operator to the database, or to somebody who will weaken the guard for them. */
    if v_msg not ilike '%credit note%' then
      raise exception 'FAIL 1: refusal for % did not name the credit-note route: %', v_id, v_msg;
    end if;
    select count(*) into v_n from public.invoices where id = v_id;
    if v_n <> 1 then raise exception 'FAIL 1: % vanished despite the raise', v_id; end if;
  end loop;

  -- `void` specifically: retiring an invoice while KEEPING its number is the whole point
  -- of voiding, so a deletable void would undo the thing it exists to do.
  select count(*) into v_n from public.invoices where id = 'INV-DELT-27-0004';
  if v_n <> 1 then raise exception 'FAIL 2: a VOID invoice was deletable'; end if;

  -- ── BLOCKED: through delete_subscription_invoice ──────────────────────────
  v_err := false;
  begin
    perform public.delete_subscription_invoice('INV-DELT-27-0001');
  exception when others then v_err := true; v_msg := sqlerrm; end;
  if not v_err then raise exception 'FAIL 3: delete_subscription_invoice removed an issued invoice'; end if;
  if v_msg not ilike '%credit note%' then
    raise exception 'FAIL 3: refusal did not name the credit-note route: %', v_msg;
  end if;

  -- ── BLOCKED: through delete_project_invoice ──────────────────────────────
  update public.project_milestones set invoice_id = 'INV-DELT-27-0002'
   where id = 'd0d0d0d0-0000-4000-8000-00000000000c';
  v_err := false;
  begin
    perform public.delete_project_invoice('INV-DELT-27-0002');
  exception when others then v_err := true; v_msg := sqlerrm; end;
  if not v_err then raise exception 'FAIL 4: delete_project_invoice removed a PAID invoice'; end if;
  if v_msg not ilike '%credit note%' then
    raise exception 'FAIL 4: refusal did not name the credit-note route: %', v_msg;
  end if;
  update public.project_milestones set invoice_id = 'INV-DELT-27-0007'
   where id = 'd0d0d0d0-0000-4000-8000-00000000000c';

  -- ── BLOCKED: a DRAFT project invoice whose milestones carry real receipts ─
  /* This is the destroying-evidence half of R-014. It used to run
     `delete from public.project_payments` — money that actually arrived, carrying a
     bank_txn_id back to a real statement line — and set the milestone to 'pending' as
     though the customer had never paid. */
  v_err := false;
  begin
    perform public.delete_project_invoice('INV-DELT-27-0006');
  exception when others then v_err := true; v_msg := sqlerrm; end;
  if not v_err then
    raise exception 'FAIL 5: a draft project invoice with payments against it was deleted';
  end if;
  if v_msg not ilike '%payment%' then
    raise exception 'FAIL 5: refusal did not say the payments were the reason: %', v_msg;
  end if;

  -- …and the receipt is still there. This is the assertion that matters most in the file.
  select count(*) into v_n from public.project_payments
   where id = 'd0d0d0d0-0000-4000-8000-00000000000d';
  if v_n <> 1 then raise exception 'FAIL 6: the bank receipt was deleted with the invoice'; end if;

  -- ── ALLOWED: a genuine draft, through the RPC ────────────────────────────
  /* Without this, an over-tightened guard leaves no way to discard a mistake before it is
     issued — and a guard that blocks the ordinary case gets switched off within a week
     (L103). */
  perform public.delete_project_invoice('INV-DELT-27-0007');
  select count(*) into v_n from public.invoices where id = 'INV-DELT-27-0007';
  if v_n <> 0 then raise exception 'FAIL 7: a clean DRAFT project invoice could not be deleted'; end if;
  select status into v_msg from public.project_milestones where id = 'd0d0d0d0-0000-4000-8000-00000000000c';
  if v_msg <> 'pending' then
    raise exception 'FAIL 7: milestone did not return to pending after its draft invoice went (got %)', v_msg;
  end if;

  -- ── ALLOWED: a plain draft, by raw DELETE ────────────────────────────────
  delete from public.invoices where id = 'INV-DELT-27-0005';
  select count(*) into v_n from public.invoices where id = 'INV-DELT-27-0005';
  if v_n <> 0 then raise exception 'FAIL 8: a plain DRAFT invoice could not be deleted'; end if;

  -- ── ALLOWED: a reviewed delete under the stated-reason escape hatch ──────
  /* Transaction-scoped, needs a reason in words, reached by no application code path —
     the same shape the UPDATE trigger already uses. A guard with no legitimate override
     is a guard somebody eventually deletes outright (L28). */
  perform set_config('app.invoice_amend_reason', 'R-014 test: duplicate raised in error', true);
  delete from public.invoices where id = 'INV-DELT-27-0003';
  perform set_config('app.invoice_amend_reason', '', true);
  select count(*) into v_n from public.invoices where id = 'INV-DELT-27-0003';
  if v_n <> 0 then raise exception 'FAIL 9: the stated-reason escape hatch did not open the delete'; end if;

  -- …and it closed again afterwards.
  v_err := false;
  begin
    delete from public.invoices where id = 'INV-DELT-27-0001';
  exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 10: the escape hatch stayed open after being cleared'; end if;

  raise notice 'PASS: issued invoices refuse deletion, drafts delete, receipts survive';
end $$;

rollback;
