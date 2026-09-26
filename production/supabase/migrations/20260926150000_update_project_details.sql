-- ============================================================================
-- Edit an active project — value, title, customer — 26 Sep 2026.
-- Cross-team request R-004, raised by Pardeep (Accounting & Finance) on 25 Sep 2026.
--
-- WHY
--   Once a project is Active nothing on /projects/[id] could change its contract value,
--   title or customer — only dates, costs and labour. When the deal changes (scope
--   added, a discount agreed, or the wrong value typed while booking a bank receipt)
--   the only way was a hand edit in the database. The project's value drives the
--   Project margin card and the P&L's project revenue, so a wrong value stays wrong in
--   the books until somebody opens psql.
--
-- WHAT IT ENFORCES, and why each rule is here
--   1. A new total below what is already INVOICED or PAID is refused. Allowing it would
--      make the schedule unsatisfiable and the receivable negative.
--   2. Milestones already invoiced or paid are untouched. Only the rest are re-planned,
--      and they must add up to the new total minus the locked part — the same rule as
--      update_project_future_milestones, deliberately, so the two cannot disagree about
--      what "locked" means.
--   3. Invoices already raised are never touched. A change after invoicing is a credit
--      or debit note, not an edit — the document the customer holds has already been
--      claimed against.
--   4. The CUSTOMER can only change while nothing has been invoiced. After that the
--      invoice belongs to the party it was issued to, and re-pointing the project would
--      leave the two disagreeing with no record of which is right. This is narrower
--      than R-004 asked for; it is flagged back to Pardeep rather than done quietly.
--
--   Passing NULL for any field leaves it as it is, so a caller changing only the title
--   does not have to restate the money.
--
-- MONEY UNIT: p_total_amount is the GST-INCLUSIVE contract value, in whole rupees —
-- the same thing the milestones add up to, and the same convention
-- raise_project_milestone_invoice uses. taxable and gst are derived from it.
-- ============================================================================

begin;

create or replace function public.update_project_details(
  p_project_id    uuid,
  p_title         text    default null,
  p_description   text    default null,
  p_customer_id   uuid    default null,
  p_customer_name text    default null,
  p_total_amount  integer default null,
  p_gst_rate      integer default null,
  p_inter_state   boolean default null,
  p_milestones    jsonb   default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant      uuid := public.current_tenant_id();
  v_proj        public.project_sales;
  v_locked_sum  integer := 0;
  v_max_seq     integer := 0;
  v_invoiced    integer := 0;
  v_paid        integer := 0;
  v_new_total   integer;
  v_rate        integer;
  v_taxable     integer;
  v_gst         integer;
  v_new_sum     integer := 0;
  v_seq         integer;
  v_m           jsonb;
begin
  select * into v_proj from public.project_sales where id = p_project_id for update;
  if not found then
    raise exception 'Project not found';
  end if;
  if v_tenant is not null and v_proj.tenant_id is distinct from v_tenant then
    raise exception 'Not in the caller tenant' using errcode = 'insufficient_privilege';
  end if;

  -- What is already committed. "Locked" means invoiced OR paid, exactly as
  -- update_project_future_milestones defines it.
  select coalesce(sum(m.total_amount), 0), coalesce(max(m.seq), 0)
    into v_locked_sum, v_max_seq
  from public.project_milestones m
  where m.project_id = p_project_id
    and (m.invoice_id is not null
         or exists (select 1 from public.project_payments p where p.milestone_id = m.id));

  select count(*) into v_invoiced
    from public.project_milestones m
   where m.project_id = p_project_id and m.invoice_id is not null;

  select coalesce(sum(p.amount), 0) into v_paid
    from public.project_payments p where p.project_id = p_project_id;

  -- Customer -----------------------------------------------------------------
  if p_customer_id is not null and p_customer_id is distinct from v_proj.customer_id then
    if v_invoiced > 0 then
      raise exception
        'This project already has % tax invoice(s), issued to "%". Changing the customer now would leave those invoices pointing at a different party. Raise a credit note against them first, then invoice the correct customer.',
        v_invoiced, coalesce(v_proj.customer_name, 'the current customer')
        using errcode = 'invalid_parameter_value';
    end if;
    update public.project_sales
       set customer_id   = p_customer_id,
           customer_name = coalesce(p_customer_name, customer_name)
     where id = p_project_id;
  elsif p_customer_name is not null then
    update public.project_sales set customer_name = p_customer_name where id = p_project_id;
  end if;

  -- Title / description --------------------------------------------------------
  if p_title is not null then
    if length(btrim(p_title)) < 2 then
      raise exception 'A project needs a title of at least 2 characters.'
        using errcode = 'invalid_parameter_value';
    end if;
    update public.project_sales set title = btrim(p_title) where id = p_project_id;
  end if;
  if p_description is not null then
    update public.project_sales
       set description = nullif(btrim(p_description), '')
     where id = p_project_id;
  end if;

  -- Money ----------------------------------------------------------------------
  v_new_total := coalesce(p_total_amount, v_proj.total_amount);
  v_rate      := coalesce(p_gst_rate, v_proj.gst_rate, 18);

  if v_new_total <= 0 then
    raise exception 'A contract value must be more than zero.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Rule 1. Below what is already committed the schedule cannot be satisfied.
  if v_new_total < greatest(v_locked_sum, v_paid) then
    raise exception
      'The new value Rs % is below what is already invoiced or paid (Rs %). Reduce it only to that figure or above - to go lower, credit-note the invoices first.',
      v_new_total, greatest(v_locked_sum, v_paid)
      using errcode = 'invalid_parameter_value';
  end if;

  v_taxable := round(v_new_total * 100.0 / (100 + v_rate));
  v_gst     := v_new_total - v_taxable;

  update public.project_sales
     set total_amount   = v_new_total,
         taxable_amount = v_taxable,
         gst_amount     = v_gst,
         gst_rate       = v_rate,
         inter_state    = coalesce(p_inter_state, inter_state),
         updated_at     = now()
   where id = p_project_id;

  -- Re-plan the milestones that are not locked ---------------------------------
  -- NULL means "leave the schedule alone" - a title-only edit must not touch it.
  if p_milestones is not null then
    for v_m in select * from jsonb_array_elements(p_milestones) loop
      v_new_sum := v_new_sum + greatest(coalesce((v_m->>'total_amount')::integer, 0), 0);
    end loop;

    if v_locked_sum + v_new_sum <> v_new_total then
      raise exception
        'Schedule must total Rs %. Rs % is already invoiced or paid and fixed, so the remaining milestones must add up to Rs %.',
        v_new_total, v_locked_sum, (v_new_total - v_locked_sum)
        using errcode = 'invalid_parameter_value';
    end if;

    delete from public.project_milestones m
     where m.project_id = p_project_id
       and m.invoice_id is null
       and not exists (select 1 from public.project_payments p where p.milestone_id = m.id);

    v_seq := v_max_seq;
    for v_m in select * from jsonb_array_elements(p_milestones) loop
      v_seq := v_seq + 1;
      insert into public.project_milestones (tenant_id, project_id, seq, label, total_amount, due_date, status)
      values (v_proj.tenant_id, p_project_id, v_seq,
              coalesce(nullif(btrim(v_m->>'label'), ''), 'Milestone ' || v_seq),
              greatest(coalesce((v_m->>'total_amount')::integer, 0), 0),
              nullif(v_m->>'due_date', '')::date,
              'pending');
    end loop;
  elsif p_total_amount is not null and p_total_amount <> v_proj.total_amount then
    -- The value moved and no schedule came with it. Refusing is better than leaving a
    -- schedule that no longer adds up: every screen reading the project would show a
    -- total the milestones disagree with, and nothing would say why.
    raise exception
      'The contract value changed but no milestone schedule was sent, so the instalments would no longer add up to it. Re-plan the remaining milestones in the same save.'
      using errcode = 'invalid_parameter_value';
  end if;
end;
$function$;

grant execute on function public.update_project_details(uuid, text, text, uuid, text, integer, integer, boolean, jsonb) to authenticated;

commit;
