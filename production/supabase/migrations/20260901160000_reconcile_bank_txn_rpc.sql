-- Atomic bank-reconcile: one RPC does the six writes that the client used to
-- fire one-by-one (bank line, the two reverse links, and the un-reconcile
-- reversals). Two hooks — the manual dialog (useReconcileTransaction) and the
-- batch auto-reconcile (applyReconcile) — carried byte-identical copies of that
-- sequence, kept in sync only by hand; a comment even claimed they already
-- shared one path. They did not. And because the writes were separate round
-- trips, a failure after the first left a bank line matched with its reverse
-- link unset — a half-reconciled money state no rollback could catch.
--
-- This makes it one transaction, one source of truth. It mirrors the client
-- writes EXACTLY (same order, same conditions) so behaviour is unchanged; the
-- only differences are atomicity and that matched_by is now auth.uid() set
-- server-side. The salary/expense paid-status trigger on bank_transactions
-- (sync_salary_paid_status) still fires on the UPDATE below, unchanged.
--
-- Types (measured on live 1 Sep 2026): bank_transactions.matched_to_id is TEXT,
-- so p_matched_to_id is text; project_payments.id is UUID (cast ::uuid);
-- expenses.id is TEXT (no cast). security invoker would also work here — the
-- writes are the same ones the user already made under RLS — but the sibling
-- reconcile RPCs are definer with an explicit tenant guard, so this matches them.

create or replace function public.reconcile_bank_txn(
  p_txn_id           uuid,
  p_matched_to_type  text,
  p_matched_to_id    text,
  p_match_confidence text
)
 returns public.bank_transactions
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn    public.bank_transactions;
  v_row    public.bank_transactions;
begin
  select * into v_txn from public.bank_transactions where id = p_txn_id;
  if not found then
    raise exception 'Bank transaction not found' using errcode = 'no_data_found';
  end if;
  if v_tenant is not null and v_txn.tenant_id is distinct from v_tenant then
    raise exception 'Not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  if p_matched_to_type is not null then
    update public.bank_transactions
       set matched_to_type  = p_matched_to_type,
           matched_to_id    = p_matched_to_id,
           matched_at       = now(),
           matched_by       = auth.uid(),
           match_confidence = coalesce(p_match_confidence, 'manual')
     where id = p_txn_id
     returning * into v_row;
  else
    update public.bank_transactions
       set matched_to_type  = null,
           matched_to_id    = null,
           matched_at       = null,
           matched_by       = null,
           match_confidence = null
     where id = p_txn_id
     returning * into v_row;
  end if;

  -- Reverse link on project_payments: clear any stale pointer to this line,
  -- then set it when matching to a project payment. (project_payments.id is uuid.)
  update public.project_payments set bank_txn_id = null where bank_txn_id = p_txn_id;
  if p_matched_to_type = 'project' and p_matched_to_id is not null then
    update public.project_payments set bank_txn_id = p_txn_id where id = p_matched_to_id::uuid;
  end if;

  -- Reverse link on expenses: same clear-then-set. (expenses.id is text.)
  update public.expenses set reconciled_txn_id = null where reconciled_txn_id = p_txn_id;
  if p_matched_to_type = 'expense' and p_matched_to_id is not null then
    update public.expenses set reconciled_txn_id = p_txn_id where id = p_matched_to_id;
  end if;

  -- Un-reconcile also reverses a line booked as capital / director's loan
  -- (balance sheet) or a statutory (TDS/PF/ESI) challan, so nothing drifts.
  if p_matched_to_type is null then
    delete from public.balance_sheet_items       where bank_txn_id = p_txn_id;
    delete from public.statutory_dues_payments    where bank_txn_id = p_txn_id;
  end if;

  return v_row;
end;
$function$;

grant execute on function public.reconcile_bank_txn(uuid, text, text, text) to authenticated;
