-- 0053: at most ONE invoice per quote (audit bug #7)
--
-- Problem: invoice generation is client-side (lib/queries/invoices.ts) with only a
-- read-then-insert guard and a NON-unique index on quote_id. A double-click, bulk
-- loop, or retry can pass the read guard twice and create TWO Tax Invoices for one
-- supply — broken ITC / GSTR-1, duplicate INV serials. Proven: two inserts for the
-- same quote_id both succeed today.
--
-- Fix (DB backstop): a partial UNIQUE INDEX so a second invoice for the same quote
-- is rejected at the database, regardless of client-side races. Verified zero
-- existing duplicates before adding.
--
-- NOTE: this is the backstop only. The fuller fix (bugs #8 snapshot race, #9
-- partial-failure orphan) is an atomic SECURITY DEFINER generate_invoice(p_quote_id)
-- RPC with SELECT ... FOR UPDATE — tracked separately. The client should also catch
-- the unique_violation and surface "invoice already exists" instead of a raw error.

create unique index if not exists invoices_quote_unique
  on public.invoices (quote_id)
  where quote_id is not null;
