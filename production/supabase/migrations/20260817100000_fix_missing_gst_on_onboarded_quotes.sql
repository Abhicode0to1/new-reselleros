-- 20260817100000_fix_missing_gst_on_onboarded_quotes
--
-- WHAT THIS FIXES
--   Quotes created by the Subscription Onboarding dialog carried an EX-GST figure in
--   `amount` while stamping tax_rate 18 on the same row. `amount` is the canonical
--   rupee value — it drives outstanding_amount, it is what /api/public/quote/[id]/pay
--   charges, and record_payment treats it as the expected total.
--
--   So the customer owed subtotal + GST, was billed subtotal, and the quote closed as
--   fully paid. The GST was never collected. Q-2026-9778 shows it plainly: its detail
--   page prints "GST (18%) ₹4,320" directly above "TOTAL ₹24,000".
--
--   The dialog was fixed in the same change as this migration. This repairs the rows
--   it already wrote.
--
-- WHY IT IS SAFE TO REWRITE THESE AMOUNTS
--   ONLY rows with no GST document and no money against them are touched:
--     · no invoice issued (invoice_id null AND no invoices rows)
--     · nothing received (payment_amount 0/null, payment_status not received/invoiced)
--     · no payments rows
--
--   That matters because once a tax invoice exists, the amount is fixed by a document
--   in a GST series. Raising it then is a DEBIT NOTE under CGST §34, not an UPDATE —
--   silently editing the quote would leave the invoice and the quote disagreeing about
--   the same supply, which is the kind of thing that surfaces during an audit.
--
--   Verified before running: Q-2026-9778 had 0 invoices, 0 payments, ₹0 received.
--
-- WHY subtotal IS LEFT ALONE
--   subtotal is correct — it is the taxable value. Only `amount` was wrong. Changing
--   both would double-count the GST on the next run.
--
-- HOW TO VERIFY (SEPARATE run from the DDL — AGENTS.md §5):
--
--   select id, subtotal, tax_rate, amount,
--          amount = subtotal + round(subtotal * tax_rate / 100.0) as amount_is_gross
--     from public.quotes;
--   -- expect amount_is_gross = true on every row
--
--   select q.id, q.amount, s.outstanding_amount
--     from public.quotes q join public.subscriptions s on s.quote_id = q.id;
--   -- expect the two to agree

begin;

-- 1. The quotes.
update public.quotes q
   set amount = q.subtotal + round(q.subtotal * coalesce(q.tax_rate, 18) / 100.0)
 where q.subtotal > 0
   and coalesce(q.tax_rate, 0) > 0
   and q.amount is distinct from (q.subtotal + round(q.subtotal * coalesce(q.tax_rate, 18) / 100.0))
   -- nothing invoiced
   and q.invoice_id is null
   and not exists (select 1 from public.invoices i where i.quote_id = q.id)
   -- nothing collected
   and coalesce(q.payment_amount, 0) = 0
   and q.payment_status not in ('received', 'invoiced')
   and not exists (select 1 from public.payments p where p.quote_id = q.id);

-- 2. The subscription's outstanding balance, which must agree with the quote it came
--    from — otherwise the two disagree about the same debt.
update public.subscriptions s
   set outstanding_amount = q.amount
  from public.quotes q
 where q.id = s.quote_id
   and s.outstanding_amount > 0
   and s.outstanding_amount is distinct from q.amount
   and q.invoice_id is null
   and coalesce(q.payment_amount, 0) = 0;

commit;
