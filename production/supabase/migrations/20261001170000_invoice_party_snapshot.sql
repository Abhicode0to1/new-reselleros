-- ============================================================================
-- R-043 (1 Oct 2026) — freeze the customer's GSTIN, address and place of supply on the
-- invoice the moment it is issued.
--
-- THE HOLE: an invoice row kept only customer_name. Its GSTIN, address and state were read
-- LIVE from customers every time — by the invoice dialog / PDF and by the GSTR-1 builder
-- (accounting/gst/page.tsx). So editing a customer (new GSTIN after a move, a corrected
-- state) silently rewrote invoices already sent and returns already filed: the reprinted
-- PDF no longer matched the copy the buyer holds, and B2B/B2CL/CDNR moved between tables.
-- The tax heads were already frozen (taxable_value / tax_amount / inter_state, 0116);
-- the parties were not.
--
-- CGST Rule 46 also wants the place of supply as STATE NAME AND CODE on an inter-state
-- invoice; the PDF printed only "Inter-state (IGST)".
--
-- WHAT THIS DOES
--   1. Six columns on invoices: customer_gstin, billing_address, customer_country,
--      pos_state_code, seller_gstin, seller_state_code.
--   2. A BEFORE INSERT trigger fills each one that the creating path left NULL — so
--      generate_invoice, raise_subscription_billing, raise_project_milestone_invoice and
--      any future path are covered without copying their bodies here to go stale.
--      Place of supply = the customer's state_code (the same value generate_invoice
--      decides IGST vs CGST+SGST from), the GSTIN's first two digits if the state is
--      missing, and '96' (GST portal: Other Countries) for a recipient outside India.
--   3. tg_invoices_freeze_issued: the six join the ONCE-SET tier — null may be filled,
--      a value may not be replaced. Body below is the LIVE definition (pg_get_functiondef)
--      with only those six lines added.
--   4. Backfill of existing invoices from the CURRENT customer / company. That is the best
--      fact available today, not proof of what stood on the issue date — said here rather
--      than claimed. From now on the value is the one at issue.
-- ============================================================================

alter table public.invoices
  add column if not exists customer_gstin    text,
  add column if not exists billing_address   text,
  add column if not exists customer_country  text,
  add column if not exists pos_state_code    text,
  add column if not exists seller_gstin      text,
  add column if not exists seller_state_code text;

comment on column public.invoices.customer_gstin    is 'Buyer GSTIN as on the day of issue (R-043). NULL = unregistered buyer.';
comment on column public.invoices.billing_address   is 'Buyer address as printed on the invoice at issue (R-043).';
comment on column public.invoices.customer_country  is 'Buyer country at issue — outside India = export (R-043).';
comment on column public.invoices.pos_state_code    is 'Place of supply, 2-digit GST state code; 96 = outside India (R-043, CGST Rule 46).';
comment on column public.invoices.seller_gstin      is 'Supplier (own) GSTIN at issue (R-043).';
comment on column public.invoices.seller_state_code is 'Supplier (own) state code at issue (R-043).';

-- ── 1. The snapshot, in one function the trigger and the backfill share ──────
create or replace function public.invoice_party_snapshot(p_tenant uuid, p_customer uuid)
returns table (customer_gstin text, billing_address text, customer_country text,
               pos_state_code text, seller_gstin text, seller_state_code text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c record;
  t record;
  v_country text;
  v_export  boolean;
  v_pos     text;
begin
  select cu.gstin, cu.address, cu.city, cu.state, cu.pin_code, cu.country, cu.state_code
    into c from public.customers cu where cu.id = p_customer and cu.tenant_id = p_tenant;
  select te.gstin, te.state_code into t from public.tenants te where te.id = p_tenant;

  v_country := nullif(btrim(coalesce(c.country, '')), '');
  v_export  := v_country is not null and lower(v_country) not in ('in', 'ind', 'india', 'bharat');
  v_pos := case
    when v_export then '96'
    when nullif(btrim(coalesce(c.state_code, '')), '') is not null then lpad(btrim(c.state_code), 2, '0')
    when coalesce(c.gstin, '') ~ '^[0-9]{2}' then substring(c.gstin from 1 for 2)
    else null
  end;

  return query select
    nullif(upper(btrim(coalesce(c.gstin, ''))), ''),
    nullif(concat_ws(', ',
      nullif(btrim(coalesce(c.address, '')), ''),
      nullif(btrim(coalesce(c.city, '')), ''),
      nullif(btrim(concat_ws(' ', nullif(btrim(coalesce(c.state, '')), ''), nullif(btrim(coalesce(c.pin_code, '')), ''))), ''),
      case when v_export then v_country end), ''),
    v_country,
    v_pos,
    nullif(upper(btrim(coalesce(t.gstin, ''))), ''),
    nullif(btrim(coalesce(t.state_code, '')), '');
end $$;
revoke all on function public.invoice_party_snapshot(uuid, uuid) from public;

create or replace function public.tg_invoice_snapshot_parties()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare s record;
begin
  if new.customer_id is null then return new; end if;
  select * into s from public.invoice_party_snapshot(new.tenant_id, new.customer_id);
  new.customer_gstin    := coalesce(new.customer_gstin,    s.customer_gstin);
  new.billing_address   := coalesce(new.billing_address,   s.billing_address);
  new.customer_country  := coalesce(new.customer_country,  s.customer_country);
  new.pos_state_code    := coalesce(new.pos_state_code,    s.pos_state_code);
  new.seller_gstin      := coalesce(new.seller_gstin,      s.seller_gstin);
  new.seller_state_code := coalesce(new.seller_state_code, s.seller_state_code);
  return new;
end $$;

drop trigger if exists trg_invoice_snapshot_parties on public.invoices;
create trigger trg_invoice_snapshot_parties
  before insert on public.invoices
  for each row execute function public.tg_invoice_snapshot_parties();

-- ── 2. Freeze ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_invoices_freeze_issued()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  /* An escape hatch that has to be spelled out. A guard with no legitimate override is
     a guard somebody eventually drops; one that needs a stated REASON cannot be set by
     reflex, is transaction-scoped (`set local`), and leaves the reason in the log beside
     the change. No application code path sets this — it is for a reviewed maintenance
     script, the same shape as the files under supabase/maintenance.

     (Do not write that path with a glob. Postgres block comments NEST, so a stray
     slash-star inside one opens a second comment and the entire function body becomes
     unterminated. This file failed to parse for exactly that reason on the first
     attempt, and the error points at the comment rather than at the glob.) */
  v_reason  text := nullif(btrim(coalesce(current_setting('app.invoice_amend_reason', true), '')), '');
  v_changed text[] := '{}';

  /* Two tiers, because "changed" is not one question.

     STRICT — the identity of the document. There is no story in which these move on an
     issued invoice, including from null.

     ONCE-SET — a particular that may legitimately be FILLED IN later. taxable_value,
     tax_amount, tax_rate and inter_state arrived in a later migration, so invoices
     issued before it hold nulls, and a backfill completes the record rather than
     amending it. Null -> value is allowed; value -> a different value is not. */
begin
  -- ── STRICT ──────────────────────────────────────────────────────────────
  if new.id            is distinct from old.id            then v_changed := v_changed || 'id (the invoice number)'::text; end if;
  if new.tenant_id     is distinct from old.tenant_id     then v_changed := v_changed || 'tenant_id (the supplier)'::text; end if;
  if new.invoice_date  is distinct from old.invoice_date  then v_changed := v_changed || 'invoice_date'::text; end if;
  if new.amount        is distinct from old.amount        then v_changed := v_changed || 'amount'::text; end if;
  if new.customer_name is distinct from old.customer_name then v_changed := v_changed || 'customer_name'::text; end if;

  -- ── ONCE-SET: null may be filled, a value may not be replaced ───────────
  if old.customer_id   is not null and new.customer_id   is distinct from old.customer_id   then v_changed := v_changed || 'customer_id'::text; end if;
  if old.taxable_value is not null and new.taxable_value is distinct from old.taxable_value then v_changed := v_changed || 'taxable_value'::text; end if;
  if old.tax_amount    is not null and new.tax_amount    is distinct from old.tax_amount    then v_changed := v_changed || 'tax_amount'::text; end if;
  if old.tax_rate      is not null and new.tax_rate      is distinct from old.tax_rate      then v_changed := v_changed || 'tax_rate'::text; end if;
  if old.inter_state   is not null and new.inter_state   is distinct from old.inter_state   then v_changed := v_changed || 'inter_state (this is the CGST+SGST vs IGST switch)'::text; end if;
  if old.line_items    is not null and new.line_items    is distinct from old.line_items    then v_changed := v_changed || 'line_items'::text; end if;
  if old.quote_id      is not null and new.quote_id      is distinct from old.quote_id      then v_changed := v_changed || 'quote_id'::text; end if;
  if old.due_date      is not null and new.due_date      is distinct from old.due_date      then v_changed := v_changed || 'due_date'::text; end if;
  -- R-043: the parties as they stood on the day of issue (CGST Rule 46).
  if old.customer_gstin    is not null and new.customer_gstin    is distinct from old.customer_gstin    then v_changed := v_changed || 'customer_gstin'::text; end if;
  if old.billing_address   is not null and new.billing_address   is distinct from old.billing_address   then v_changed := v_changed || 'billing_address'::text; end if;
  if old.customer_country  is not null and new.customer_country  is distinct from old.customer_country  then v_changed := v_changed || 'customer_country'::text; end if;
  if old.pos_state_code    is not null and new.pos_state_code    is distinct from old.pos_state_code    then v_changed := v_changed || 'pos_state_code (place of supply)'::text; end if;
  if old.seller_gstin      is not null and new.seller_gstin      is distinct from old.seller_gstin      then v_changed := v_changed || 'seller_gstin'::text; end if;
  if old.seller_state_code is not null and new.seller_state_code is distinct from old.seller_state_code then v_changed := v_changed || 'seller_state_code'::text; end if;

  /* Everything not listed above is deliberately mutable, because it is the invoice's
     LIFECYCLE rather than the document: status, paid_date, paid_amount, overdue_days,
     razorpay_id, pdf_url, updated_at — and gst_irn, which by definition arrives from the
     IRP only AFTER the invoice is issued, so freezing it would break e-invoicing.

     adjusted_advances / net_payable / first_advance_at are mutable too, and that is a
     considered carve-out rather than an omission: adjusting a customer advance against
     an invoice is a real post-issue settlement under CGST Section 31(3)(d), and the
     feature that does it (migration 0209) would break if this froze them. */

  if array_length(v_changed, 1) is null then
    return new;
  end if;

  if v_reason is not null then
    raise notice '[invoices] % amended under app.invoice_amend_reason=%: %',
      old.id, v_reason, array_to_string(v_changed, ', ');
    return new;
  end if;

  /* Reason, then the next step, then where to do it — CLAUDE.md §24. A bare "not
     allowed" on a money guard sends the operator to the database. */
  raise exception
    'Invoice % has been issued, so its % cannot be changed. Under CGST Section 34 a mistake on an issued invoice is corrected with a CREDIT NOTE plus a fresh invoice, not an edit — the buyer has already claimed input credit against the copy they hold. Open the invoice and use "Issue credit note".',
    old.id, array_to_string(v_changed, ', ');
end;
$function$;

-- ── 3. Backfill (null → value is allowed by the ONCE-SET tier) ───────────────
update public.invoices i
   set customer_gstin    = coalesce(i.customer_gstin,    s.customer_gstin),
       billing_address   = coalesce(i.billing_address,   s.billing_address),
       customer_country  = coalesce(i.customer_country,  s.customer_country),
       /* Only where today's state AGREES with the tax head frozen on the invoice. Where it
          does not (the customer moved, or was billed before R-041 with no state on file)
          a backfilled code would contradict the printed IGST / CGST+SGST — so it stays
          NULL, "not known", rather than a confident wrong fact. Local seed data had 2. */
       pos_state_code    = coalesce(i.pos_state_code, case
                             when s.pos_state_code = '96' then s.pos_state_code
                             when i.inter_state is null or s.seller_state_code is null then null
                             when i.inter_state = (s.pos_state_code <> s.seller_state_code) then s.pos_state_code
                           end),
       seller_gstin      = coalesce(i.seller_gstin,      s.seller_gstin),
       seller_state_code = coalesce(i.seller_state_code, s.seller_state_code)
  from public.invoices src
  cross join lateral public.invoice_party_snapshot(src.tenant_id, src.customer_id) s
 where src.id = i.id
   and i.customer_id is not null;
