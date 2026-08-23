-- Regression test: an issued invoice's CGST Rule 46 particulars cannot be edited.
-- Migration 20260823090000. Self-asserting; rolled back — safe on production.
--
-- Proves BOTH directions, because a guard is only half-tested by what it blocks:
--   BLOCKED  amount · invoice_date · customer_name · the tax split · line_items · due_date
--   ALLOWED  status · paid_date · paid_amount · gst_irn · pdf_url · advance adjustment
--   ALLOWED  filling a NULL particular (a backfill completes the record)
--   ALLOWED  a reviewed amendment under app.invoice_amend_reason
--
-- The ALLOWED half matters as much: freezing gst_irn would break e-invoicing (the IRN
-- arrives from the IRP only after issue), and freezing the advance columns would break
-- the Section 31(3)(d) settlement flow from migration 0209.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('f0f0f0f0-0000-4000-8000-000000000001', 'IMMUTABLE INV TEST', 'imm@example.in', '07', 'IMM1');
insert into public.customers (id, tenant_id, name, state_code)
  values ('f0f0f0f0-0000-4000-8000-0000000000c1', 'f0f0f0f0-0000-4000-8000-000000000001', 'Cust Imm', '07');

insert into public.invoices (
  id, tenant_id, customer_id, customer_name, amount, status,
  invoice_date, due_date, taxable_value, tax_amount, tax_rate, inter_state,
  paid_amount, adjusted_advances, line_items, quote_id
) values (
  'INV-IMM-2026-27-0001', 'f0f0f0f0-0000-4000-8000-000000000001',
  'f0f0f0f0-0000-4000-8000-0000000000c1', 'Cust Imm', 118000, 'pending',
  current_date, current_date + 30, 100000, 18000, 18, false,
  0, '[]'::jsonb, '[{"name":"Google Workspace","qty":10,"rate":10000}]'::jsonb, null
);

-- A second invoice with NULL particulars, standing in for one issued before the tax
-- columns existed. Used for the backfill case below.
insert into public.invoices (
  id, tenant_id, customer_id, customer_name, amount, status,
  invoice_date, paid_amount, adjusted_advances
) values (
  'INV-IMM-2026-27-0002', 'f0f0f0f0-0000-4000-8000-000000000001',
  'f0f0f0f0-0000-4000-8000-0000000000c1', 'Cust Imm', 59000, 'pending',
  current_date, 0, '[]'::jsonb
);

do $$
declare
  v_err   boolean;
  v_msg   text;
  v_n     int;
  v_val   int;

  procedure_note text := 'each block below must RAISE; a silent success is the bug';
begin
  -- ── BLOCKED: the amount ───────────────────────────────────────────────────
  v_err := false;
  begin
    update public.invoices set amount = 50000 where id = 'INV-IMM-2026-27-0001';
  exception when others then v_err := true; v_msg := sqlerrm; end;
  if not v_err then
    raise exception 'FAIL amount: an issued invoice''s amount was edited';
  end if;
  /* The message must lead somewhere, not just refuse — CLAUDE.md §24. */
  if v_msg not like '%credit note%' and v_msg not like '%CREDIT NOTE%' then
    raise exception 'FAIL amount: refusal did not name the credit-note route: %', v_msg;
  end if;
  select amount into v_val from public.invoices where id = 'INV-IMM-2026-27-0001';
  if v_val <> 118000 then raise exception 'FAIL amount: row changed to % despite the raise', v_val; end if;

  -- ── BLOCKED: the tax split, which is the expensive one ────────────────────
  v_err := false;
  begin
    update public.invoices set inter_state = true where id = 'INV-IMM-2026-27-0001';
  exception when others then v_err := true; end;
  if not v_err then
    raise exception 'FAIL inter_state: the CGST+SGST/IGST switch was flipped after issue';
  end if;

  -- ── BLOCKED: identity and date ────────────────────────────────────────────
  v_err := false;
  begin update public.invoices set invoice_date = current_date - 40 where id = 'INV-IMM-2026-27-0001';
  exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL invoice_date: back-dated after issue'; end if;

  v_err := false;
  begin update public.invoices set customer_name = 'Someone Else' where id = 'INV-IMM-2026-27-0001';
  exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL customer_name: recipient changed after issue'; end if;

  v_err := false;
  begin update public.invoices set line_items = '[]'::jsonb where id = 'INV-IMM-2026-27-0001';
  exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL line_items: what was supplied was rewritten'; end if;

  v_err := false;
  begin update public.invoices set due_date = current_date where id = 'INV-IMM-2026-27-0001';
  exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL due_date: payment terms changed after issue'; end if;

  -- ── ALLOWED: the lifecycle. Blocking any of these breaks a working flow ───
  update public.invoices
     set status = 'paid', paid_date = current_date, paid_amount = 118000
   where id = 'INV-IMM-2026-27-0001';

  /* gst_irn arrives from the IRP only AFTER issue — freezing it would make
     e-invoicing impossible, which is why it is not in the frozen list. */
  update public.invoices set gst_irn = 'IRN123456789' where id = 'INV-IMM-2026-27-0001';
  update public.invoices set pdf_url = 'https://example.in/i.pdf' where id = 'INV-IMM-2026-27-0001';

  /* Advance adjustment — CGST 31(3)(d), migration 0209. A considered carve-out. */
  update public.invoices
     set adjusted_advances = '[{"advance_id":"x","amount":5000}]'::jsonb,
         net_payable       = 113000,
         first_advance_at  = now()
   where id = 'INV-IMM-2026-27-0001';

  select paid_amount into v_val from public.invoices where id = 'INV-IMM-2026-27-0001';
  if v_val <> 118000 then raise exception 'FAIL lifecycle: paid_amount did not stick (%)', v_val; end if;

  -- ── ALLOWED: filling a NULL particular is a backfill, not an amendment ────
  update public.invoices
     set taxable_value = 50000, tax_amount = 9000, tax_rate = 18, inter_state = false
   where id = 'INV-IMM-2026-27-0002';
  select tax_amount into v_val from public.invoices where id = 'INV-IMM-2026-27-0002';
  if v_val <> 9000 then raise exception 'FAIL backfill: null particulars could not be filled'; end if;

  -- ...but once filled, they are frozen like any other.
  v_err := false;
  begin update public.invoices set tax_amount = 1 where id = 'INV-IMM-2026-27-0002';
  exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL backfill: a filled particular was then replaced'; end if;

  -- ── ALLOWED: a reviewed amendment, with a stated reason ───────────────────
  /* The escape hatch exists so a guard nobody can satisfy does not get dropped. It is
     transaction-scoped and needs a REASON, so it cannot be set by reflex. */
  perform set_config('app.invoice_amend_reason', 'test: repairing due_date on 41 legacy invoices', true);
  update public.invoices set due_date = current_date + 45 where id = 'INV-IMM-2026-27-0001';
  select 1 into v_n from public.invoices
   where id = 'INV-IMM-2026-27-0001' and due_date = current_date + 45;
  if v_n is null then raise exception 'FAIL override: the reasoned amendment did not apply'; end if;

  -- ...and the hatch closes again when the reason is cleared.
  perform set_config('app.invoice_amend_reason', '', true);
  v_err := false;
  begin update public.invoices set amount = 1 where id = 'INV-IMM-2026-27-0001';
  exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL override: guard stayed open after the reason was cleared'; end if;

  raise notice 'PASS: issued-invoice particulars frozen, lifecycle and backfill still writable';
end $$;

select 'PASS' as issued_invoice_is_immutable;

rollback;
