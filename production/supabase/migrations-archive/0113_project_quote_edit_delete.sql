-- 0113: edit + delete a project sale/quotation (guarded).
--
-- Both refuse once money is attached — a milestone has been invoiced OR a
-- payment recorded — so we never orphan a GST invoice or a receipt. In that
-- case the operator must first delete the milestone invoice (which reverses its
-- payment), then edit/delete the quote.

-- ── Update: replace project fields + milestone schedule ──────────────────────
create or replace function public.update_project_quote(
  p_project_id    uuid,
  p_customer_name text,
  p_title         text,
  p_description   text,
  p_line_items    jsonb,
  p_gst_rate      integer,
  p_inter_state   boolean,
  p_milestones    jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_proj    public.project_sales;
  v_taxable integer := 0;
  v_gst     integer;
  v_li      jsonb;
  v_m       jsonb;
  v_seq     integer := 0;
begin
  select * into v_proj from public.project_sales where id = p_project_id;
  if not found then raise exception 'Project not found'; end if;
  if v_tenant is not null and v_proj.tenant_id is distinct from v_tenant then
    raise exception 'Not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.project_milestones where project_id = p_project_id and invoice_id is not null) then
    raise exception 'Can''t edit — a milestone is already invoiced. Delete that invoice first.'
      using errcode = 'invalid_parameter_value';
  end if;
  if exists (select 1 from public.project_payments where project_id = p_project_id) then
    raise exception 'Can''t edit — payments are recorded. Remove them first.'
      using errcode = 'invalid_parameter_value';
  end if;

  for v_li in select * from jsonb_array_elements(coalesce(p_line_items, '[]'::jsonb)) loop
    v_taxable := v_taxable + greatest(coalesce((v_li->>'amount')::integer, 0), 0);
  end loop;
  if v_taxable <= 0 then raise exception 'Needs at least one line item'; end if;
  v_gst := round(v_taxable * coalesce(p_gst_rate, 18) / 100.0);

  update public.project_sales
     set customer_name  = p_customer_name,
         title          = p_title,
         description    = nullif(trim(coalesce(p_description,'')),''),
         gst_rate       = coalesce(p_gst_rate, 18),
         inter_state    = coalesce(p_inter_state, false),
         line_items     = coalesce(p_line_items, '[]'::jsonb),
         taxable_amount = v_taxable,
         gst_amount     = v_gst,
         total_amount   = v_taxable + v_gst,
         updated_at     = now()
   where id = p_project_id;

  -- Rebuild the milestone schedule (safe: none invoiced, no payments).
  delete from public.project_milestones where project_id = p_project_id;
  for v_m in select * from jsonb_array_elements(coalesce(p_milestones, '[]'::jsonb)) loop
    v_seq := v_seq + 1;
    insert into public.project_milestones (tenant_id, project_id, seq, label, total_amount, due_date)
    values (v_proj.tenant_id, p_project_id, v_seq,
            coalesce(v_m->>'label', 'Milestone ' || v_seq),
            greatest(coalesce((v_m->>'total_amount')::integer, 0), 0),
            nullif(v_m->>'due_date','')::date);
  end loop;
end;
$$;
grant execute on function public.update_project_quote(uuid, text, text, text, jsonb, integer, boolean, jsonb) to authenticated;

-- ── Delete: remove the project + its milestones (guarded) ────────────────────
create or replace function public.delete_project_sale(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_proj   public.project_sales;
begin
  select * into v_proj from public.project_sales where id = p_project_id;
  if not found then raise exception 'Project not found'; end if;
  if v_tenant is not null and v_proj.tenant_id is distinct from v_tenant then
    raise exception 'Not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.project_milestones where project_id = p_project_id and invoice_id is not null) then
    raise exception 'Can''t delete — a milestone is invoiced. Delete that invoice first.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Free any bank lines matched to this project's payments before cascade.
  update public.bank_transactions b
     set matched_to_type = null, matched_to_id = null, matched_at = null, match_confidence = null
   where b.tenant_id = v_proj.tenant_id and b.matched_to_type = 'project'
     and b.matched_to_id in (select p.id::text from public.project_payments p where p.project_id = p_project_id);

  -- Cascade removes project_milestones + project_payments (FK on delete cascade).
  delete from public.project_sales where id = p_project_id;
end;
$$;
grant execute on function public.delete_project_sale(uuid) to authenticated;
