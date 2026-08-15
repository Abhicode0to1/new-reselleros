-- 0114 — Edit only the FUTURE (un-invoiced, un-paid) milestones of a project.
--
-- update_project_quote() hard-blocks any edit once a milestone is invoiced or
-- paid, because rebuilding the whole schedule would orphan a GST invoice / a
-- receipt. But operators legitimately need to re-plan the *remaining*
-- installments after taking an advance. This RPC lets them do that safely:
--
--   • Milestones that are invoiced (invoice_id set) OR have a payment are LOCKED
--     — their amount/label/due are never touched.
--   • Only the un-locked milestones are replaced with p_milestones.
--   • The contract total is fixed (an invoice was issued against it), so
--     locked_sum + new_sum MUST still equal project.total_amount, else we reject.
--
-- p_milestones = the desired FUTURE milestones only:
--   [{ "label": text, "total_amount": int (GST-inclusive), "due_date": "YYYY-MM-DD"|null }]

create or replace function public.update_project_future_milestones(
  p_project_id uuid,
  p_milestones jsonb
) returns void
  language plpgsql
  security definer
  set search_path to 'public'
as $$
declare
  v_tenant     uuid := public.current_tenant_id();
  v_proj       public.project_sales;
  v_locked_sum integer := 0;
  v_max_seq    integer := 0;
  v_new_sum    integer := 0;
  v_seq        integer;
  v_m          jsonb;
begin
  select * into v_proj from public.project_sales where id = p_project_id;
  if not found then raise exception 'Project not found'; end if;
  if v_tenant is not null and v_proj.tenant_id is distinct from v_tenant then
    raise exception 'Not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  -- Sum + top sequence of the LOCKED milestones (invoiced or paid).
  select coalesce(sum(m.total_amount), 0), coalesce(max(m.seq), 0)
    into v_locked_sum, v_max_seq
  from public.project_milestones m
  where m.project_id = p_project_id
    and (m.invoice_id is not null
         or exists (select 1 from public.project_payments p where p.milestone_id = m.id));

  -- Sum of the proposed future milestones.
  for v_m in select * from jsonb_array_elements(coalesce(p_milestones, '[]'::jsonb)) loop
    v_new_sum := v_new_sum + greatest(coalesce((v_m->>'total_amount')::integer, 0), 0);
  end loop;

  if v_locked_sum + v_new_sum <> v_proj.total_amount then
    raise exception 'Schedule must total %. ₹% is already invoiced/paid and fixed, so the remaining milestones must add up to ₹%.',
      v_proj.total_amount, v_locked_sum, (v_proj.total_amount - v_locked_sum)
      using errcode = 'invalid_parameter_value';
  end if;

  -- Replace ONLY the un-locked milestones.
  delete from public.project_milestones m
  where m.project_id = p_project_id
    and m.invoice_id is null
    and not exists (select 1 from public.project_payments p where p.milestone_id = m.id);

  v_seq := v_max_seq;
  for v_m in select * from jsonb_array_elements(coalesce(p_milestones, '[]'::jsonb)) loop
    v_seq := v_seq + 1;
    insert into public.project_milestones (tenant_id, project_id, seq, label, total_amount, due_date, status)
    values (v_proj.tenant_id, p_project_id, v_seq,
            coalesce(v_m->>'label', 'Milestone ' || v_seq),
            greatest(coalesce((v_m->>'total_amount')::integer, 0), 0),
            nullif(v_m->>'due_date', '')::date,
            'pending');
  end loop;

  update public.project_sales set updated_at = now() where id = p_project_id;
end;
$$;

grant execute on function public.update_project_future_milestones(uuid, jsonb) to authenticated;
