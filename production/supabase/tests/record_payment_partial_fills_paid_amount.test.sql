-- Regression test: a PARTIAL payment against an invoice fills invoices.paid_amount.
-- Migration 20260929150000 (R-015 part 3). Rolled back — safe on production.
--
-- The exact case from the card: a Rs 1,00,000 invoice, Rs 40,000 received.
--
--   before  paid_amount 0, and Aging counted the whole Rs 1,00,000 as outstanding while
--           the same Rs 40,000 was also in the cash figure — both sides of the books
--           wrong at once, from one write that only ever ran on full settlement.
--   after   paid_amount 40000, so `net_payable - paid_amount` is Rs 60,000.
--
-- It also pins what must NOT change, which is the half that catches an over-eager fix:
-- the invoice must stay UNPAID on a part payment. Marking it paid would stop the dunning
-- ladder chasing the remaining Rs 60,000 — a worse outcome than the bug.
--
-- Fixture owns its data (L11): its own tenant, customer, quote and invoice.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('a5a5a5a5-0000-4000-8000-000000000001', 'PARTIAL PAY TEST', 'pp@example.in', '07', 'PART');
insert into public.customers (id, tenant_id, name, state_code)
  values ('a5a5a5a5-0000-4000-8000-0000000000c1', 'a5a5a5a5-0000-4000-8000-000000000001', 'Cust Partial', '07');

/* Order matters: quotes.invoice_id has a FK to invoices, and the invoice carries the
   quote id, so neither can be inserted with its link already set. Quote first without
   the link, then the invoice, then join them. */
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate,
                           status, payment_status, line_items)
  values ('Q-PARTIAL-TEST', 'a5a5a5a5-0000-4000-8000-000000000001', 'a5a5a5a5-0000-4000-8000-0000000000c1',
          'Cust Partial', 100000, 100000, 0, 'accepted', 'awaiting', '[]'::jsonb);

insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, net_payable, status,
                             invoice_date, paid_amount, adjusted_advances, quote_id)
  values ('INV-PART-27-0001', 'a5a5a5a5-0000-4000-8000-000000000001', 'a5a5a5a5-0000-4000-8000-0000000000c1',
          'Cust Partial', 100000, 100000, 'pending', current_date, 0, '[]'::jsonb, 'Q-PARTIAL-TEST');

update public.quotes set invoice_id = 'INV-PART-27-0001' where id = 'Q-PARTIAL-TEST';

do $$
declare
  v_paid   int;
  v_status text;
  v_date   date;
begin
  /* ── SETUP GUARD (L14): the row must start where this test claims it starts ──
     `is distinct from` and not `<>`: a missing row leaves these NULL, `NULL <> 0` is
     NULL rather than true, and the guard waves the run through to fail forty lines
     later for a reason that has nothing to do with the thing under test. That is
     exactly what happened on the first run of this file. */
  select paid_amount, status::text into v_paid, v_status
    from public.invoices where id = 'INV-PART-27-0001';
  if v_paid is distinct from 0 or v_status is distinct from 'pending' then
    raise exception 'SETUP FAIL: fixture starts at paid=% status=% — the asserts below prove nothing', v_paid, v_status;
  end if;

  -- ── Rs 40,000 of Rs 1,00,000 ──────────────────────────────────────────────
  perform public.record_payment('Q-PARTIAL-TEST', 40000, 'bank_transfer', 'REF-PART-1', null);

  select paid_amount, status::text, paid_date into v_paid, v_status, v_date
    from public.invoices where id = 'INV-PART-27-0001';

  if v_paid <> 40000 then
    raise exception 'FAIL 1: paid_amount is % after a Rs 40,000 payment — Aging still reads the full Rs 1,00,000', v_paid;
  end if;

  /* The other half, and the one that catches an over-eager fix. A part-paid invoice must
     stay unpaid or the dunning ladder stops chasing the remaining Rs 60,000 — worse than
     the bug being fixed. */
  if v_status = 'paid' then
    raise exception 'FAIL 2: a 40%% payment marked the invoice PAID — dunning would stop chasing the balance';
  end if;
  if v_date is not null then
    raise exception 'FAIL 3: paid_date was stamped (%) on an invoice that is not settled', v_date;
  end if;

  -- What Aging will compute. Stated here so the number in the card is the number asserted.
  if (100000 - v_paid) <> 60000 then
    raise exception 'FAIL 4: outstanding computes to %, expected 60000', 100000 - v_paid;
  end if;

  -- ── The balance ──────────────────────────────────────────────────────────
  perform public.record_payment('Q-PARTIAL-TEST', 60000, 'bank_transfer', 'REF-PART-2', null);

  select paid_amount, status::text, paid_date into v_paid, v_status, v_date
    from public.invoices where id = 'INV-PART-27-0001';

  if v_paid <> 100000 then raise exception 'FAIL 5: paid_amount is % after full settlement', v_paid; end if;
  if v_status <> 'paid' then raise exception 'FAIL 5: invoice is % after full settlement', v_status; end if;

  /* IST, not the server clock: this database is UTC, so `current_date` between 00:00 and
     05:30 IST is yesterday, and an invoice settled at 01:00 IST was dated the day before
     the money arrived. */
  if v_date is distinct from public.ist_today() then
    raise exception 'FAIL 6: paid_date is % but IST today is %', v_date, public.ist_today();
  end if;

  raise notice 'PASS: 40k of 100k -> paid_amount 40000, still pending; balance -> paid on %', v_date;
end $$;

rollback;
