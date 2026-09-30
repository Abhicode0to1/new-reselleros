-- 20260929130000_invoices_no_delete_once_issued.sql
--
-- R-014 (Pardeep, 29 Sep 2026) — an ISSUED GST invoice can be hard-deleted, and it takes
-- the customer's bank receipts with it.
--
-- Three separate holes, measured on the local database:
--
--   1. `delete_project_invoice` and `delete_subscription_invoice` both end in a bare
--      `delete from public.invoices` with no look at `status`. An invoice that has been
--      issued — number spent, document sent, GSTR-1 filed — disappears on a button press.
--   2. `tg_invoices_freeze_issued` is `BEFORE UPDATE` only. It is thorough about what may
--      not be AMENDED on an issued invoice and says nothing at all about deleting the
--      whole row, which is strictly worse than any amendment it refuses.
--   3. `delete_project_invoice` then does `delete from public.project_payments`. Those are
--      real money received into a real bank account, with a `bank_txn_id` reconciling them
--      to a real statement line. Deleting an invoice is a bookkeeping correction; erasing
--      the record that the customer paid is not, and the milestone silently returns to
--      'pending' as though the money never arrived.
--
-- ── WHAT "ISSUED" MEANS HERE ──────────────────────────────────────────────────
-- `generate_invoice` writes `pending` or `paid` — it never writes `draft`. So every
-- invoice that has taken a number from the gapless CGST Rule 46 series is already
-- non-draft, and `status = 'draft'` is exactly the set that is safe to remove. `void` is
-- deliberately NOT deletable: voiding is how a wrong invoice is retired while its number
-- stays on the record, and deleting the void would undo the very thing it exists to do.
--
-- ── WHY THE NUMBER STILL DOES NOT COME BACK ───────────────────────────────────
-- `lib/queries/invoices.ts` calls the deletion a "number roll-back". It is not one:
-- `document_series.last_number` only ever increases, so deleting an issued invoice leaves
-- a permanent hole in the series that a GST audit will ask about. That is the reason this
-- is a refusal and not a warning — there is no undo to offer afterwards.
--
-- ── THE WAY OUT (CLAUDE.md §24 — never a dead end) ────────────────────────────
-- An issued invoice that is wrong is corrected by a CREDIT NOTE (`issue_credit_note`,
-- CGST Section 34), which is what the law provides and what leaves both documents on the
-- record. The messages below say so, and name the function.
--
-- The `app.invoice_amend_reason` escape hatch is honoured here too, exactly as the UPDATE
-- trigger honours it: transaction-scoped, needs a stated reason, reachable by no
-- application code path. A guard with no legitimate override is a guard somebody
-- eventually deletes.

begin;

-- ── 1. The trigger. This is the floor: it holds whatever route the DELETE came from ──

create or replace function public.tg_invoices_block_delete_issued()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_reason text := nullif(btrim(coalesce(current_setting('app.invoice_amend_reason', true), '')), '');
begin
  if old.status = 'draft' then
    return old;
  end if;

  if v_reason is not null then
    raise notice '[invoices] % deleted under app.invoice_amend_reason=%', old.id, v_reason;
    return old;
  end if;

  raise exception
    'Invoice % is % and cannot be deleted. Its number is already spent from the GST series and deleting it leaves a permanent gap. To cancel it, raise a credit note against it (issue_credit_note) — that keeps both documents on the record, which is what CGST Section 34 requires.',
    old.id, old.status
    using errcode = 'restrict_violation';
end;
$function$;

comment on function public.tg_invoices_block_delete_issued() is
  'R-014. Refuses DELETE on any invoice that is not a draft. The companion to '
  'tg_invoices_freeze_issued, which covers UPDATE only — deleting the row is worse than '
  'any amendment that one refuses.';

/* R-013 hygiene: a new SECURITY DEFINER function is granted EXECUTE to PUBLIC by default,
   which is hole 3 of the 27 Sep security audit regenerating itself. That migration was a
   one-shot sweep over the functions that existed then; it cannot cover this one. A trigger
   function returning `trigger` is not callable over PostgREST anyway, so this is belt and
   braces rather than a live hole — but "not exploitable today" is not a reason to leave a
   definer function open (AGENTS.md L112). */
revoke all on function public.tg_invoices_block_delete_issued() from public, anon, authenticated;

drop trigger if exists trg_invoices_block_delete_issued on public.invoices;
create trigger trg_invoices_block_delete_issued
  before delete on public.invoices
  for each row execute function public.tg_invoices_block_delete_issued();

-- ── 2. delete_project_invoice — draft only, and the receipts stay ────────────────────

create or replace function public.delete_project_invoice(p_invoice_id text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_inv     public.invoices;
  v_ms_ids  uuid[];
begin
  select * into v_inv from public.invoices where id = p_invoice_id;
  if not found then raise exception 'Invoice not found'; end if;
  /* R-013 (Pardeep, 27 Sep 2026): the hardened form. The old guard opened by testing
     that the tenant was NOT null and only then comparing — so a NULL tenant skipped the
     comparison entirely, which is the anon case and the signed-in-but-no-users-row case,
     and quote/invoice ids are countable. Migration 20260927100000 rewrote 17 definer RPCs
     by regex; this file recreates some of them, so it must carry the hardened shape
     forward or it silently undoes that fix.

     The old wording is deliberately NOT quoted here. `definer_rpc_hardening.test.sql`
     FAIL 4 scans `pg_get_functiondef`, which includes COMMENTS — so writing the phrase in
     prose turns that security test red for no reason (AGENTS.md L46). Verified: quoting it
     did exactly that. */
  if (v_tenant is null and coalesce(auth.role(), '') in ('anon', 'authenticated'))
     or (v_tenant is not null and v_inv.tenant_id is distinct from v_tenant) then
    raise exception 'Invoice not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  /* R-014. Checked HERE as well as in the trigger, on purpose. The trigger is the floor
     and cannot be bypassed; this one exists so the operator gets the refusal before any
     of the unlinking below has run, and so the message can name the project flow. Two
     guards, one of which is reachable and one of which is unavoidable.

     It honours the same escape hatch as the trigger, and that is not decoration: a hatch
     the trigger respects and the RPC does not is a hatch that works for a raw DELETE and
     silently fails for the sanctioned route — which is how somebody ends up deleting the
     row by hand instead, with no guard in the way at all. */
  if v_inv.status <> 'draft'
     and nullif(btrim(coalesce(current_setting('app.invoice_amend_reason', true), '')), '') is null then
    raise exception
      'Invoice % is % — an issued invoice cannot be deleted. Raise a credit note against it instead (Invoices → open % → Credit note); that keeps the number on the GST record, which deleting it would not.',
      p_invoice_id, v_inv.status, p_invoice_id
      using errcode = 'restrict_violation';
  end if;

  select array_agg(id) into v_ms_ids
    from public.project_milestones
   where invoice_id = p_invoice_id and tenant_id = v_inv.tenant_id;

  if v_ms_ids is null then
    raise exception 'Not a project invoice (nothing references it) — cannot delete here'
      using errcode = 'invalid_parameter_value';
  end if;

  /* R-014, the part that was destroying evidence.
     This used to be `delete from public.project_payments where milestone_id = any(...)`
     and, before that, an unmatching of the bank lines those payments were reconciled to.
     `project_payments` rows are money that actually arrived, carrying `bank_txn_id` back
     to a real statement line — they are not a detail of the invoice and they outlive it.

     A draft invoice should never have payments against it in the first place; if one
     somehow does, that is a fact to surface rather than to erase, so the delete is
     refused and the operator is told where to look. */
  if exists (
    select 1 from public.project_payments
     where milestone_id = any (v_ms_ids) and tenant_id = v_inv.tenant_id
  ) then
    raise exception
      'Invoice % has payments recorded against its milestones. Delete or refund those payments first (Projects → the project → Payments) — they are real receipts reconciled to your bank statement and this must not remove them.',
      p_invoice_id
      using errcode = 'restrict_violation';
  end if;

  update public.project_milestones
     set invoice_id = null, status = 'pending'
   where id = any (v_ms_ids);

  delete from public.invoices where id = p_invoice_id;
end;
$function$;

-- ── 3. delete_subscription_invoice — draft only ──────────────────────────────────────

create or replace function public.delete_subscription_invoice(p_invoice_id text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_inv    public.invoices;
  v_paid   integer;
  v_status payment_status;
begin
  select * into v_inv from public.invoices where id = p_invoice_id;
  if not found then raise exception 'Invoice not found'; end if;
  /* R-013 (Pardeep, 27 Sep 2026): the hardened form. The old guard opened by testing
     that the tenant was NOT null and only then comparing — so a NULL tenant skipped the
     comparison entirely, which is the anon case and the signed-in-but-no-users-row case,
     and quote/invoice ids are countable. Migration 20260927100000 rewrote 17 definer RPCs
     by regex; this file recreates some of them, so it must carry the hardened shape
     forward or it silently undoes that fix.

     The old wording is deliberately NOT quoted here. `definer_rpc_hardening.test.sql`
     FAIL 4 scans `pg_get_functiondef`, which includes COMMENTS — so writing the phrase in
     prose turns that security test red for no reason (AGENTS.md L46). Verified: quoting it
     did exactly that. */
  if (v_tenant is null and coalesce(auth.role(), '') in ('anon', 'authenticated'))
     or (v_tenant is not null and v_inv.tenant_id is distinct from v_tenant) then
    raise exception 'Invoice not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  if exists (select 1 from public.project_milestones where invoice_id = p_invoice_id) then
    raise exception 'This is a project invoice — delete it from the project flow'
      using errcode = 'invalid_parameter_value';
  end if;

  -- R-014. Same guard, same escape hatch, same reasons as the project path above.
  if v_inv.status <> 'draft'
     and nullif(btrim(coalesce(current_setting('app.invoice_amend_reason', true), '')), '') is null then
    raise exception
      'Invoice % is % — an issued invoice cannot be deleted. Raise a credit note against it instead (Invoices → open % → Credit note); that keeps the number on the GST record, which deleting it would not.',
      p_invoice_id, v_inv.status, p_invoice_id
      using errcode = 'restrict_violation';
  end if;

  if v_inv.quote_id is not null then
    select coalesce(sum(amount), 0) into v_paid
      from public.payments
     where quote_id = v_inv.quote_id and status = 'received';

    v_status := (case
      when v_paid >= coalesce(v_inv.amount, 0) and v_paid > 0 then 'received'
      when v_paid > 0                                         then 'partial'
      else 'none'
    end)::payment_status;

    update public.quotes
       set invoice_id = null, payment_status = v_status
     where id = v_inv.quote_id and tenant_id = v_inv.tenant_id;
  end if;

  delete from public.invoices where id = p_invoice_id;
end;
$function$;

commit;
