-- Project receipt with TDS — a customer pays a project milestone net of TDS.
--
-- Excel Technologies paid ₹5,40,000 twice for "Complete ERP". The deal was ₹5,00,000 + 18%
-- GST = ₹5,90,000 per milestone, less 10% TDS (194J) on the ₹5,00,000 = ₹50,000. Banking →
-- Reconcile → Project payment had no TDS option, so the ₹5,40,000 receipt was taken as the
-- whole invoice: revenue and GST came out short and the ₹1,00,000 TDS credit (claimable in
-- the ITR against Form 16A / 26AS) was recorded nowhere.
--
-- record_project_receipt_with_tds does, in one transaction:
--   1. the bank receipt as a project payment (net, linked to the bank line — which
--      record_project_payment also reconciles);
--   2. the TDS as a second project payment (method 'tds', no bank line) — the customer
--      settled that part of the milestone by paying it to the government on our behalf;
--   3. optionally the milestone's tax invoice (after both, so it is born "paid");
--   4. the tds_receivable row (section, rate, pre-GST base, net) linked to the invoice,
--      status pending_cert — the TDS Receivable page then chases Form 16A.
-- Refused when the milestone is not in the caller's company or amounts are not positive.

create or replace function public.record_project_receipt_with_tds(
  p_milestone_id  uuid,
  p_net           integer,          -- ₹ that reached the bank
  p_tds           integer,          -- ₹ withheld by the customer
  p_section       text,             -- '194J', '194C', …
  p_rate_pct      numeric,          -- 10, 2, 1 …
  p_tds_base      integer,          -- pre-GST value the TDS was computed on
  p_received_at   date,
  p_bank_txn_id   uuid,
  p_reference     text,
  p_raise_invoice boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_ms      public.project_milestones;
  v_proj    public.project_sales;
  v_net_id  uuid;
  v_tds_id  uuid;
  v_invoice text;
  v_tds_row text;
begin
  if v_tenant is null then raise exception 'No tenant in context'; end if;
  select * into v_ms from public.project_milestones where id = p_milestone_id for update;
  if not found then raise exception 'Milestone not found'; end if;
  if v_ms.tenant_id is distinct from v_tenant then
    raise exception 'Milestone not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_net, 0) <= 0 or coalesce(p_tds, 0) <= 0 or coalesce(p_tds_base, 0) <= 0 then
    raise exception 'Net, TDS and the TDS base must all be more than zero';
  end if;
  select * into v_proj from public.project_sales where id = v_ms.project_id;

  -- 1 + 2. both parts of the settlement, through the one project-payment path
  v_net_id := public.record_project_payment(p_milestone_id, p_net, 'bank_transfer', p_reference, p_received_at, p_bank_txn_id);
  v_tds_id := public.record_project_payment(p_milestone_id, p_tds, 'tds',
                format('TDS %s @ %s%% on ₹%s', coalesce(p_section, '194J'), p_rate_pct, p_tds_base), p_received_at, null);

  -- 3. invoice, after both, so a fully settled milestone's invoice is born paid
  select invoice_id into v_invoice from public.project_milestones where id = p_milestone_id;
  if p_raise_invoice and v_invoice is null then
    v_invoice := public.raise_project_milestone_invoice(p_milestone_id);
  end if;

  -- 4. the credit to claim
  v_tds_row := 'TDS-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 10));
  insert into public.tds_receivable (
    id, tenant_id, invoice_id, payment_id, customer_id, customer_name, section, rate_pct,
    gross_amount, tds_amount, net_paid, fiscal_year, payment_received_date, status, notes
  ) values (
    v_tds_row, v_tenant, v_invoice, null, v_proj.customer_id, coalesce(v_proj.customer_name, ''),
    coalesce(p_section, '194J'), p_rate_pct, p_tds_base, p_tds, p_net,
    public.indian_fiscal_year(coalesce(p_received_at, current_date)), coalesce(p_received_at, current_date),
    'pending_cert',
    format('Project %s · milestone "%s" · project payments %s (bank) + %s (TDS)', v_proj.title, v_ms.label, v_net_id, v_tds_id)
  );

  return jsonb_build_object('net_payment', v_net_id, 'tds_payment', v_tds_id, 'invoice_id', v_invoice, 'tds_receivable', v_tds_row);
end;
$$;

revoke all on function public.record_project_receipt_with_tds(uuid, integer, integer, text, numeric, integer, date, uuid, text, boolean) from public, anon;
grant execute on function public.record_project_receipt_with_tds(uuid, integer, integer, text, numeric, integer, date, uuid, text, boolean) to authenticated;

comment on function public.record_project_receipt_with_tds(uuid, integer, integer, text, numeric, integer, date, uuid, text, boolean) is
  'Book a project milestone receipt paid net of TDS: bank payment + TDS payment + optional invoice + tds_receivable row, atomically.';
