-- A vendor invoice booked from prepaid advances carries its tax facts (27 Sep 2026).
--
-- consume_prepaid_fifo wrote the expense with only the GST total. The GST page then
-- had to GUESS the head (CGST+SGST vs IGST — Meta India is in Haryana, so for a Delhi
-- buyer it is IGST), the ITC rule found no vendor GSTIN (the advance rarely carried a
-- vendor_id) and refused the credit, and TDS u/s 194C on the advertising bill — which
-- must be deducted even though the money went out as an advance — had nowhere to go.
--
-- Now the call takes vendor_id, bill number, the GST split by head, and TDS section +
-- amount; each is written to the expense slice(s) exactly as a normal expense would be:
-- heads pro rata with the remainder on the last slice, TDS whole on the last slice.
-- A vendor_id given here is also written back to the vendor's advances that had none,
-- so next time the advance already knows its vendor.
--
-- The 6-arg signature is dropped first (an extra overload makes positional calls
-- ambiguous — see 20260927170000).

drop function if exists public.consume_prepaid_fifo(text, integer, integer, date, text, text);

create or replace function public.consume_prepaid_fifo(
  p_vendor_name text, p_amount integer, p_gst integer default 0, p_date date default current_date,
  p_note text default null, p_attachment text default null,
  p_vendor_id uuid default null, p_bill_no text default null,
  p_igst integer default null, p_cgst integer default null, p_sgst integer default null,
  p_tds_section text default null, p_tds_amount integer default 0
)
returns integer
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_tenant    uuid := public.current_tenant_id();
  v_available integer;
  v_left      integer := p_amount;
  v_gst_left  integer := greatest(0, coalesce(p_gst, 0));
  v_igst_left integer; v_cgst_left integer; v_sgst_left integer;
  v_adv       record;
  v_take      integer;
  v_gst_take  integer; v_igst_take integer; v_cgst_take integer; v_sgst_take integer;
  v_exp_id    text;
  v_parts     integer;
  v_part      integer := 0;
  v_vendor_id uuid;
  v_tds       integer := greatest(0, coalesce(p_tds_amount, 0));
begin
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Invoice amount must be more than zero.'; end if;
  if v_gst_left > p_amount then raise exception 'GST (₹%) cannot be more than the invoice total (₹%).', v_gst_left, p_amount; end if;

  /* Heads: given → must add up to the GST; not given → all under CGST+SGST split evenly
     (what the GST page assumed before, now stated on the row instead of guessed later). */
  if p_igst is not null or p_cgst is not null or p_sgst is not null then
    v_igst_left := greatest(0, coalesce(p_igst, 0)); v_cgst_left := greatest(0, coalesce(p_cgst, 0)); v_sgst_left := greatest(0, coalesce(p_sgst, 0));
    if v_igst_left + v_cgst_left + v_sgst_left <> v_gst_left then
      raise exception 'IGST + CGST + SGST (₹%) must equal the GST (₹%).', v_igst_left + v_cgst_left + v_sgst_left, v_gst_left;
    end if;
  else
    v_igst_left := 0; v_cgst_left := v_gst_left / 2; v_sgst_left := v_gst_left - v_cgst_left;
  end if;
  if v_tds > p_amount - v_gst_left then raise exception 'TDS (₹%) cannot be more than the pre-GST value (₹%).', v_tds, p_amount - v_gst_left; end if;
  if v_tds > 0 and nullif(trim(coalesce(p_tds_section, '')), '') is null then raise exception 'Pick the TDS section for ₹% of TDS.', v_tds; end if;

  if p_vendor_id is not null then
    perform 1 from public.vendors where id = p_vendor_id and tenant_id = v_tenant;
    if not found then raise exception 'Vendor not found'; end if;
  end if;

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

  /* Teach the advances their vendor, once. */
  if p_vendor_id is not null then
    update public.prepaid_advances set vendor_id = p_vendor_id, updated_at = now()
     where tenant_id = v_tenant and vendor_id is null and upper(trim(vendor_name)) = upper(trim(p_vendor_name));
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
    if v_take = v_left then
      v_gst_take := v_gst_left; v_igst_take := v_igst_left; v_cgst_take := v_cgst_left; v_sgst_take := v_sgst_left;
    else
      v_gst_take  := least(v_gst_left,  round(coalesce(p_gst, 0)::numeric * v_take / p_amount)::int);
      v_igst_take := least(v_igst_left, round(v_igst_left::numeric * v_take / v_left)::int);
      v_cgst_take := least(v_cgst_left, round(v_cgst_left::numeric * v_take / v_left)::int);
      v_sgst_take := least(v_sgst_left, v_gst_take - v_igst_take - v_cgst_take);
    end if;
    v_vendor_id := coalesce(p_vendor_id, v_adv.vendor_id);

    v_exp_id := 'EXP-' || upper(substr(md5(gen_random_uuid()::text), 1, 10));
    insert into public.expenses
      (id, tenant_id, category, vendor_name, vendor_id, amount, gst_paid, igst, cgst, sgst, expense_date, paid, paid_date,
       bill_type, bill_no, payment_method, description, notes, attachment_url, prepaid_advance_id,
       tds_section, tds_amount)
    values
      (v_exp_id, v_tenant, v_adv.category, v_adv.vendor_name, v_vendor_id, v_take, v_gst_take, v_igst_take, v_cgst_take, v_sgst_take, p_date, true, p_date,
       case when v_gst_take > 0 then 'gst' else 'none' end, nullif(trim(coalesce(p_bill_no, '')), ''), 'advance',
       'Invoice from ' || v_adv.vendor_name || ' advance' ||
         case when v_take < p_amount then ' (part ' || v_part || ', ₹' || v_take || ' of ₹' || p_amount || ')' else '' end,
       p_note, p_attachment, v_adv.id,
       case when v_take = v_left and v_tds > 0 then trim(p_tds_section) end,
       case when v_take = v_left then v_tds else 0 end);

    update public.prepaid_advances
       set consumed_amount = consumed_amount + v_take, updated_at = now()
     where id = v_adv.id;

    v_left := v_left - v_take;
    v_gst_left := v_gst_left - v_gst_take; v_igst_left := v_igst_left - v_igst_take; v_cgst_left := v_cgst_left - v_cgst_take; v_sgst_left := v_sgst_left - v_sgst_take;
  end loop;

  return v_available - p_amount;
end;
$$;
revoke execute on function public.consume_prepaid_fifo(text, integer, integer, date, text, text, uuid, text, integer, integer, integer, text, integer) from public, anon;
grant execute on function public.consume_prepaid_fifo(text, integer, integer, date, text, text, uuid, text, integer, integer, integer, text, integer) to authenticated, service_role;
