-- ============================================================================
-- Tax payments from the bank: GST (GSTR-3B cash) and income tax (advance /
-- self-assessment), booked against an imported bank line.
--
-- WHY A NEW TABLE, NOT statutory_dues_payments
-- statutory_dues_payments holds TDS / PF / ESI challans, and three readers sum its
-- WHOLE amount with no filter on kind (balance-sheet "statutory dues payable",
-- payroll dues, ESI). A GST payment in that table would silently shrink the TDS/PF
-- still owed. A separate table leaves every existing total exactly as it was.
--
-- WHAT EACH KIND DOES TO THE BOOKS (read by the app, not by triggers)
--   gst                  → reduces GST payable for the return period (YYYY-MM)
--   advance_tax          → "Advance tax paid" asset for the financial year
--   self_assessment_tax  → same, for the year it was paid for
-- Interest and late fee paid with the tax are real expenses; they are booked as a
-- "Rates & Taxes" expense linked to the same bank line, never folded into tax.
--
-- The bank line is marked matched_to_type = 'statutory' (an existing allowed value),
-- so no constraint on bank_transactions changes.
-- ============================================================================

create table if not exists public.tax_payments (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references public.tenants(id) on delete cascade,
  kind            text        not null check (kind in ('gst', 'advance_tax', 'self_assessment_tax')),
  -- Tax only, whole rupees. Interest / late fee live on the linked expense.
  amount          integer     not null check (amount > 0),
  interest        integer     not null default 0 check (interest >= 0),
  late_fee        integer     not null default 0 check (late_fee >= 0),
  -- GST: the return month. Income tax: the financial year, 'YYYY-YY'.
  period          text        check (period is null or period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  fy              text        check (fy is null or fy ~ '^\d{4}-\d{2}$'),
  paid_on         date        not null,
  bank_account_id uuid        references public.bank_accounts(id) on delete set null,
  bank_txn_id     uuid        references public.bank_transactions(id) on delete set null,
  expense_id      text        references public.expenses(id) on delete set null,
  notes           text        check (notes is null or length(notes) <= 1000),
  created_at      timestamptz not null default now(),
  constraint tax_payments_gst_has_period check ((kind = 'gst') = (period is not null)),
  constraint tax_payments_income_tax_has_fy check ((kind <> 'gst') = (fy is not null))
);

comment on table public.tax_payments is
  'GST and income-tax payments booked from bank lines. Kept apart from statutory_dues_payments (TDS/PF/ESI) so neither total leaks into the other.';

alter table public.tax_payments enable row level security;

drop policy if exists "tenant isolation read" on public.tax_payments;
create policy "tenant isolation read" on public.tax_payments
  for select to authenticated using (tenant_id = public.current_tenant_id());

drop policy if exists "tenant isolation write" on public.tax_payments;
create policy "tenant isolation write" on public.tax_payments
  for insert to authenticated with check (tenant_id = public.current_tenant_id());

drop policy if exists "tenant isolation update" on public.tax_payments;
create policy "tenant isolation update" on public.tax_payments
  for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

drop policy if exists "tenant isolation delete" on public.tax_payments;
create policy "tenant isolation delete" on public.tax_payments
  for delete to authenticated using (tenant_id = public.current_tenant_id());

drop policy if exists zzz_service_role_all on public.tax_payments;
create policy zzz_service_role_all on public.tax_payments
  as permissive for all to service_role using (true) with check (true);

create index if not exists tax_payments_tenant_idx on public.tax_payments (tenant_id, kind, paid_on);
create index if not exists tax_payments_bank_txn_idx on public.tax_payments (bank_txn_id);

grant select, insert, update, delete on public.tax_payments to authenticated;
grant select, insert, update, delete on public.tax_payments to service_role;


-- ── Book a money-out bank line as a tax payment ────────────────────────────
create or replace function public.book_bank_txn_as_tax(
  p_txn_id   uuid,
  p_kind     text,
  p_period   text    default null,   -- gst: 'YYYY-MM'
  p_fy       text    default null,   -- income tax: 'YYYY-YY'
  p_interest integer default 0,
  p_late_fee integer default 0,
  p_notes    text    default null
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_txn      public.bank_transactions;
  v_interest integer := coalesce(p_interest, 0);
  v_late     integer := coalesce(p_late_fee, 0);
  v_tax      integer;
  v_exp_id   text;
  v_id       uuid;
  v_label    text;
begin
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if p_kind not in ('gst', 'advance_tax', 'self_assessment_tax') then
    raise exception 'Unknown tax type "%" — pick GST, advance tax or self-assessment tax.', p_kind;
  end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id and tenant_id = v_tenant;
  if not found then raise exception 'Bank line not found in your company.'; end if;
  if v_txn.matched_to_type is not null then raise exception 'This bank line is already reconciled — un-reconcile it first.'; end if;
  if coalesce(v_txn.debit, 0) <= 0 then raise exception 'A tax payment must be a money-out line.'; end if;

  if v_interest < 0 or v_late < 0 then raise exception 'Interest and late fee cannot be negative.'; end if;
  v_tax := v_txn.debit - v_interest - v_late;
  if v_tax <= 0 then
    raise exception 'Interest + late fee (₹%) leave no tax out of this ₹% line — check the amounts.', v_interest + v_late, v_txn.debit;
  end if;

  if p_kind = 'gst' then
    if p_period is null or p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' then
      raise exception 'Pick the GST return month this payment is for.';
    end if;
    v_label := 'GST ' || p_period;
  else
    if p_fy is null or p_fy !~ '^\d{4}-\d{2}$'
       or (split_part(p_fy, '-', 1)::int + 1) % 100 <> split_part(p_fy, '-', 2)::int then
      raise exception 'Pick the financial year, e.g. 2026-27.';
    end if;
    v_label := case p_kind when 'advance_tax' then 'Advance tax FY ' else 'Self-assessment tax FY ' end || p_fy;
  end if;

  /* Interest and late fee are expenses — booked, paid from this account, and tied to
     this line so they never show as an unreconciled expense. */
  if v_interest + v_late > 0 then
    v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int));
    insert into public.expenses
      (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method,
       description, paid, paid_date, bank_account_id, reconciled_txn_id, bill_type)
    values
      (v_exp_id, v_tenant, 'Rates & Taxes', 'Government', v_txn.txn_date, v_interest + v_late, 0, 'bank_transfer',
       v_label || ' — ' ||
         concat_ws(' + ',
           case when v_interest > 0 then 'interest ₹' || v_interest end,
           case when v_late > 0 then 'late fee ₹' || v_late end),
       true, v_txn.txn_date, v_txn.bank_account_id, p_txn_id, 'none');
  end if;

  insert into public.tax_payments
    (tenant_id, kind, amount, interest, late_fee, period, fy, paid_on, bank_account_id, bank_txn_id, expense_id, notes)
  values
    (v_tenant, p_kind, v_tax, v_interest, v_late,
     case when p_kind = 'gst' then p_period end,
     case when p_kind <> 'gst' then p_fy end,
     v_txn.txn_date, v_txn.bank_account_id, p_txn_id, v_exp_id,
     nullif(trim(coalesce(p_notes, '')), ''))
  returning id into v_id;

  update public.bank_transactions
     set matched_to_type = 'statutory', matched_to_id = v_id::text, match_confidence = 'manual',
         matched_at = now(), matched_by = auth.uid(), updated_at = now()
   where id = p_txn_id;

  return v_id;
end;
$$;

revoke all on function public.book_bank_txn_as_tax(uuid, text, text, text, integer, integer, text) from public;
grant execute on function public.book_bank_txn_as_tax(uuid, text, text, text, integer, integer, text) to authenticated, service_role;


-- ── reconcile_bank_txn: un-reconciling a tax line reverses it ──────────────
-- Unchanged from the live definition except the tax_payments block: a bank line
-- that stops being a tax payment (un-reconciled, or re-matched to something else)
-- takes its tax row and its interest/late-fee expense with it.
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
