-- Project receipt milestone — book a bank receipt against a project whose milestones are
-- already fully paid (a second phase, extra work, a repeat order on the same project).
--
-- The reconcile dialog's "Existing project" picker could only offer a milestone with a
-- balance left. A customer paying a second ₹5,40,000 on a project already paid in full
-- had nowhere to go but "Naya project" — splitting one contract into two. And
-- update_project_future_milestones cannot help: it keeps the project total fixed.
--
-- This appends ONE milestone for exactly the amount received and grows the project's
-- value by the same GST-inclusive amount, split into taxable + GST at the project's own
-- rate. Line items (quote-built projects) get a matching line so the quote still adds up.
-- The operator chooses this explicitly in the dialog, which shows the value change.
-- It only adds — no existing milestone, payment or invoice is touched.

create or replace function public.add_project_receipt_milestone(
  p_project_id uuid,
  p_amount     integer,
  p_label      text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_proj    public.project_sales;
  v_rate    integer;
  v_taxable integer;
  v_gst     integer;
  v_seq     integer;
  v_id      uuid;
  v_label   text := coalesce(nullif(trim(coalesce(p_label, '')), ''), 'Additional payment');
begin
  if v_tenant is null then raise exception 'No tenant in context'; end if;
  select * into v_proj from public.project_sales where id = p_project_id for update;
  if not found then raise exception 'Project not found'; end if;
  if v_proj.tenant_id is distinct from v_tenant then
    raise exception 'Project not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  if v_proj.status in ('completed', 'cancelled') then
    raise exception 'Project is %, reopen it before adding a payment', v_proj.status;
  end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Amount must be > 0'; end if;

  v_rate    := coalesce(v_proj.gst_rate, 18);
  v_taxable := round(p_amount * 100.0 / (100 + v_rate));
  v_gst     := p_amount - v_taxable;

  select coalesce(max(seq), 0) + 1 into v_seq from public.project_milestones where project_id = p_project_id;

  insert into public.project_milestones (tenant_id, project_id, seq, label, total_amount, status)
  values (v_proj.tenant_id, p_project_id, v_seq, v_label, p_amount, 'pending')
  returning id into v_id;

  update public.project_sales
     set taxable_amount = taxable_amount + v_taxable,
         gst_amount     = gst_amount + v_gst,
         total_amount   = total_amount + p_amount,
         line_items     = case
                            when jsonb_array_length(coalesce(line_items, '[]'::jsonb)) = 0 then line_items
                            else line_items || jsonb_build_array(jsonb_build_object(
                                   'name', v_label, 'qty', 1, 'rate', v_taxable, 'amount', v_taxable))
                          end,
         updated_at     = now()
   where id = p_project_id;

  return v_id;
end;
$$;

revoke all on function public.add_project_receipt_milestone(uuid, integer, text) from public, anon;
grant execute on function public.add_project_receipt_milestone(uuid, integer, text) to authenticated;

comment on function public.add_project_receipt_milestone(uuid, integer, text) is
  'Append one milestone of p_amount (GST-inclusive) to a project and grow its value by the same amount — for a bank receipt on a project already paid in full. Adds only; nothing existing changes.';
