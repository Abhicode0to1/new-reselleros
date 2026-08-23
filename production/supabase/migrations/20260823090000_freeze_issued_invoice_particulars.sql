-- An issued tax invoice cannot be edited — CGST Section 34
-- ============================================================================
-- ✅ APPLIED 23 Aug 2026 via scripts/apply-migration.mjs, recorded with
--    `supabase migration repair --status applied 20260823090000`.
--    Live suite afterwards: 38 / 39 (the one failure is a pre-existing, unrelated
--    defect in create_project_direct_invoice).
--
-- Written 23 Aug 2026. Phase 0 of automating the money spine: the last hole found
-- before automation, and the one that scales worst.
--
-- ─── WHAT WAS MISSING ───────────────────────────────────────────────────────
-- Nothing stopped an issued invoice being edited. `pg_trigger` on public.invoices held
-- four triggers — a split-billing guard on INSERT, the activity log, updated_at, and
-- the vendor-bill mirror — and not one of them looked at an UPDATE of the amount, the
-- tax split, the customer, or the date. A plain
--
--     update invoices set amount = 50000 where id = 'INV-ADPL-2026-27-0001';
--
-- succeeded silently, and the customer's copy — already in their inbox and already in
-- their GSTR-2B — said something else.
--
-- ─── WHY AN EDIT IS NOT A FIX ───────────────────────────────────────────────
-- Under CGST Section 34 a mistake on an issued invoice is corrected with a CREDIT NOTE
-- and a fresh invoice, never by amending the original. The reason is not bureaucratic:
-- the buyer has already claimed input credit against the figures on their copy. Editing
-- the seller's row makes the two copies disagree, and the buyer's GSTR-2B stops
-- reconciling — a mismatch they have to resolve, caused by a change they cannot see.
--
-- The tax split is the sharpest case. `inter_state` decides CGST+SGST versus IGST
-- (lib/gst/place-of-supply.ts). Flipping it after issue keeps the total rupees identical
-- and pays a different government, which is why a wrong split is invisible on the
-- invoice and expensive at filing.
--
-- ─── WHY NOW, AND NOT AT LEISURE ────────────────────────────────────────────
-- 41 invoices are issued and 12 document series carry live numbers, so this is no longer
-- theoretical. It is in Phase 0 because automation multiplies it: at this volume a wrong
-- edit is a phone call, and at automated volume it is a filing season.
--
-- ─── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
-- It does not block DELETE. That is already a settled position in this schema, not an
-- oversight: `supabase/tests/invoice_delete_no_serial_reuse.test.sql` (migration 0118)
-- asserts that deleting an invoice RETIRES its serial rather than reusing it, because
-- CGST Rule 46 forbids two supplies sharing one number. Blocking deletes would break a
-- working, reasoned flow and is a separate decision.

begin;

create or replace function public.tg_invoices_freeze_issued()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
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

comment on function public.tg_invoices_freeze_issued() is
  'Refuses UPDATEs to the CGST Rule 46 particulars of an issued invoice (number, supplier, '
  'customer, date, amount, tax split, line items, due date). Lifecycle columns — status, '
  'payment, gst_irn, pdf_url, advance adjustments — stay mutable. Override for a reviewed '
  'maintenance script only: set local app.invoice_amend_reason = ''<why>''.';

drop trigger if exists trg_invoices_freeze_issued on public.invoices;

/* BEFORE UPDATE, so a refused change never reaches the row, and ordering against the
   other BEFORE trigger (trg_invoices_updated_at) does not matter — that one only stamps
   updated_at, which this permits. */
create trigger trg_invoices_freeze_issued
  before update on public.invoices
  for each row
  execute function public.tg_invoices_freeze_issued();

commit;
