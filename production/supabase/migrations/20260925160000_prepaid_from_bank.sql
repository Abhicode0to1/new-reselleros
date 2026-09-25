-- ============================================================================
-- Prepaid advances straight from a bank line, and one vendor invoice consumed
-- across several top-ups (FIFO).
--
-- THE CASE: Facebook (and other ad platforms) take money in advance and send a
-- monthly invoice for what the ads actually used. The top-up is NOT an expense —
-- it is a prepaid asset; the invoice is the expense. Until now:
--   • an advance had to be created on the Prepaid page by hand, and its bank line
--     then "marked reconciled manually" — no link, so un-reconciling the line left
--     the advance behind as a phantom asset;
--   • each top-up is its own advance, so one monthly invoice spanning three top-ups
--     had to be split by hand into three "Consume" entries.
--
-- WHAT THIS ADDS
--   1. bank_transactions.matched_to_type gains 'prepaid'; prepaid_advances gains
--      bank_txn_id (the line that funded it).
--   2. book_bank_txn_as_prepaid — creates the advance from the line and reconciles it.
--   3. consume_prepaid_fifo — books one vendor invoice against that vendor's oldest
--      open advances first. One expense per advance it draws on (each expense keeps
--      its prepaid_advance_id, which the Prepaid page lists per advance); GST is split
--      pro rata with the remainder on the last slice, so the slices add up exactly.
--      Refuses — changes nothing — if the vendor's open balance is less than the invoice.
--   4. reconcile_bank_txn — un-reconciling (or re-matching) a prepaid line removes its
--      advance, but REFUSES if any of it was already consumed: those expenses are in the
--      P&L and deleting their funding would leave them pointing at nothing.
--   5. Deleting an advance that a bank line funded un-reconciles that line (trigger), so
--      the line never claims to be matched to a record that no longer exists.
-- ============================================================================

-- ── 1. Schema ──────────────────────────────────────────────────────────────
alter table public.bank_transactions drop constraint if exists bank_transactions_matched_to_type_check;
alter table public.bank_transactions add constraint bank_transactions_matched_to_type_check
  check (matched_to_type = any (array['payment','expense','vendor_bill','transfer','salary','project','manual','split','statutory','prepaid']));

alter table public.prepaid_advances
  add column if not exists bank_txn_id uuid references public.bank_transactions(id) on delete set null;
create index if not exists prepaid_advances_bank_txn_idx on public.prepaid_advances (bank_txn_id);

comment on column public.prepaid_advances.bank_txn_id is
  'The bank line that funded this advance (book_bank_txn_as_prepaid). Null for advances entered by hand.';


-- ── 2. Book a money-out line as a prepaid advance ──────────────────────────
create or replace function public.book_bank_txn_as_prepaid(
  p_txn_id      uuid,
  p_vendor_name text,
  p_category    text default 'Advertising',
  p_notes       text default null
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn    public.bank_transactions;
  v_id     uuid;
begin
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if nullif(trim(coalesce(p_vendor_name, '')), '') is null then
    raise exception 'Enter who the advance was paid to (e.g. Facebook).';
  end if;
  if nullif(trim(coalesce(p_category, '')), '') is null or p_category = 'Salaries' then
    raise exception 'Pick the expense category this advance will be used for.';
  end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id and tenant_id = v_tenant;
  if not found then raise exception 'Bank line not found in your company.'; end if;
  if v_txn.matched_to_type is not null then raise exception 'This bank line is already reconciled — un-reconcile it first.'; end if;
  if coalesce(v_txn.debit, 0) <= 0 then raise exception 'An advance paid out must be a money-out line.'; end if;

  insert into public.prepaid_advances
    (tenant_id, vendor_name, category, total_amount, consumed_amount, paid_date, payment_method,
     bank_account_id, notes, created_by, bank_txn_id)
  values
    (v_tenant, trim(p_vendor_name), p_category, v_txn.debit, 0, v_txn.txn_date, 'bank_transfer',
     v_txn.bank_account_id, coalesce(nullif(trim(coalesce(p_notes, '')), ''), v_txn.description), auth.uid(), p_txn_id)
  returning id into v_id;

  update public.bank_transactions
     set matched_to_type = 'prepaid', matched_to_id = v_id::text, match_confidence = 'manual',
         matched_at = now(), matched_by = auth.uid(), updated_at = now()
   where id = p_txn_id;

  return v_id;
end;
$$;

revoke all on function public.book_bank_txn_as_prepaid(uuid, text, text, text) from public;
grant execute on function public.book_bank_txn_as_prepaid(uuid, text, text, text) to authenticated, service_role;


-- ── 3. One vendor invoice, consumed oldest-advance-first ────────────────────
create or replace function public.consume_prepaid_fifo(
  p_vendor_name text,
  p_amount      integer,              -- invoice total, GST included (as in expenses.amount)
  p_gst         integer default 0,    -- of which GST (input credit)
  p_date        date    default current_date,
  p_note        text    default null,
  p_attachment  text    default null
) returns integer                     -- the vendor's open balance left after this invoice
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant    uuid := public.current_tenant_id();
  v_available integer;
  v_left      integer := p_amount;
  v_gst_left  integer := greatest(0, coalesce(p_gst, 0));
  v_adv       record;
  v_take      integer;
  v_gst_take  integer;
  v_exp_id    text;
  v_parts     integer;
  v_part      integer := 0;
begin
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Invoice amount must be more than zero.'; end if;
  if v_gst_left > p_amount then raise exception 'GST (₹%) cannot be more than the invoice total (₹%).', v_gst_left, p_amount; end if;

  /* Lock this vendor's open advances before reading the balance, so two invoices booked
     at once cannot both spend the same money. */
  perform 1 from public.prepaid_advances
    where tenant_id = v_tenant and upper(trim(vendor_name)) = upper(trim(p_vendor_name))
      and total_amount > consumed_amount
    for update;

  select coalesce(sum(total_amount - consumed_amount), 0), count(*)
    into v_available, v_parts
    from public.prepaid_advances
   where tenant_id = v_tenant and upper(trim(vendor_name)) = upper(trim(p_vendor_name))
     and total_amount > consumed_amount;

  if v_available < p_amount then
    raise exception 'Only ₹% is left in % advances, but the invoice is ₹%. Record the missing top-up first (reconcile its bank line as an advance), then book the invoice.',
      v_available, trim(p_vendor_name), p_amount;
  end if;

  for v_adv in
    select * from public.prepaid_advances
     where tenant_id = v_tenant and upper(trim(vendor_name)) = upper(trim(p_vendor_name))
       and total_amount > consumed_amount
     order by paid_date, created_at, id
  loop
    exit when v_left <= 0;
    v_part := v_part + 1;
    v_take := least(v_left, v_adv.total_amount - v_adv.consumed_amount);
    /* GST pro rata; the slice that finishes the invoice takes whatever GST is left, so
       the parts sum to the invoice's GST exactly. */
    v_gst_take := case when v_take = v_left then v_gst_left
                       else least(v_gst_left, round(coalesce(p_gst, 0)::numeric * v_take / p_amount)::int) end;

    v_exp_id := 'EXP-' || upper(substr(md5(gen_random_uuid()::text), 1, 10));
    insert into public.expenses
      (id, tenant_id, category, vendor_name, vendor_id, amount, gst_paid, expense_date, paid, paid_date,
       bill_type, payment_method, description, notes, attachment_url, prepaid_advance_id)
    values
      (v_exp_id, v_tenant, v_adv.category, v_adv.vendor_name, v_adv.vendor_id, v_take, v_gst_take, p_date, true, p_date,
       case when v_gst_take > 0 then 'gst' else 'none' end, 'advance',
       'Invoice from ' || v_adv.vendor_name || ' advance' ||
         case when v_take < p_amount then ' (part ' || v_part || ', ₹' || v_take || ' of ₹' || p_amount || ')' else '' end,
       p_note, p_attachment, v_adv.id);

    update public.prepaid_advances
       set consumed_amount = consumed_amount + v_take, updated_at = now()
     where id = v_adv.id;

    v_left := v_left - v_take;
    v_gst_left := v_gst_left - v_gst_take;
  end loop;

  return v_available - p_amount;
end;
$$;

revoke all on function public.consume_prepaid_fifo(text, integer, integer, date, text, text) from public;
grant execute on function public.consume_prepaid_fifo(text, integer, integer, date, text, text) to authenticated, service_role;


-- ── 4. reconcile_bank_txn: a prepaid line takes its advance with it ────────
-- Same as 20260925140000 except the prepaid block.
create or replace function public.reconcile_bank_txn(p_txn_id uuid, p_matched_to_type text, p_matched_to_id text, p_match_confidence text)
 returns bank_transactions
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn    public.bank_transactions;
  v_row    public.bank_transactions;
  v_tax_expenses text[];
  v_used   integer;
begin
  select * into v_txn from public.bank_transactions where id = p_txn_id;
  if not found then
    raise exception 'Bank transaction not found' using errcode = 'no_data_found';
  end if;
  if v_tenant is not null and v_txn.tenant_id is distinct from v_tenant then
    raise exception 'Not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  -- A prepaid line that stops being one: refuse if its advance was already used.
  if v_txn.matched_to_type = 'prepaid' and p_matched_to_type is distinct from 'prepaid' then
    select coalesce(sum(consumed_amount), 0) into v_used
      from public.prepaid_advances where bank_txn_id = p_txn_id;
    if v_used > 0 then
      raise exception 'This advance has ₹% already booked as expenses from invoices. Delete those invoice expenses first (Prepaid page), then un-reconcile.', v_used;
    end if;
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

  if p_matched_to_type is distinct from 'prepaid' then
    delete from public.prepaid_advances where bank_txn_id = p_txn_id;
  end if;

  -- Tax payment on this line: gone once the line is no longer a tax payment.
  if p_matched_to_type is distinct from 'statutory' then
    select array_agg(expense_id) filter (where expense_id is not null) into v_tax_expenses
      from public.tax_payments where bank_txn_id = p_txn_id;
    delete from public.tax_payments where bank_txn_id = p_txn_id;
    if v_tax_expenses is not null then
      delete from public.expenses where id = any (v_tax_expenses);
    end if;
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


-- ── 5. Deleting a bank-funded advance frees its bank line ──────────────────
create or replace function public.prepaid_advance_unlink_bank_line()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if old.bank_txn_id is not null then
    update public.bank_transactions
       set matched_to_type = null, matched_to_id = null, matched_at = null,
           matched_by = null, match_confidence = null, updated_at = now()
     where id = old.bank_txn_id
       and matched_to_type = 'prepaid'
       and matched_to_id = old.id::text;
  end if;
  return old;
end;
$$;

drop trigger if exists trg_prepaid_advance_unlink_bank_line on public.prepaid_advances;
create trigger trg_prepaid_advance_unlink_bank_line
  after delete on public.prepaid_advances
  for each row execute function public.prepaid_advance_unlink_bank_line();
