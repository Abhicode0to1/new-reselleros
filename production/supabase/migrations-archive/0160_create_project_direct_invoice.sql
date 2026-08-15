-- 0160 — create_project_direct_invoice: raise a one-shot project tax invoice.
--
-- The project side mirror of create_direct_invoice. A project sale is normally
-- quoted → accepted → milestone-invoiced. For a DIRECT project invoice we compose
-- the three tested RPCs in ONE transaction (atomic, CLAUDE.md §17b):
--   1. create_project_quote  — single full-amount milestone
--   2. accept_project_quote   — quotation → active project
--   3. raise_project_milestone_invoice — the GST tax invoice for that milestone
--
-- Line items come from the one-time Items Catalog (same as the project builder);
-- GST split + numbering are handled by the existing milestone-invoice machinery.

create or replace function public.create_project_direct_invoice(
  p_customer_id   uuid,
  p_customer_name text,
  p_title         text,
  p_description   text,
  p_line_items    jsonb,
  p_gst_rate      integer,
  p_inter_state   boolean
) returns table(invoice_id text, project_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lines   jsonb;
  v_taxable integer := 0;
  v_gst     integer;
  v_total   integer;
  v_pid     uuid;
  v_msid    uuid;
  v_inv     text;
begin
  if jsonb_typeof(p_line_items) <> 'array' or jsonb_array_length(p_line_items) = 0 then
    raise exception 'At least one line item is required';
  end if;

  -- create_project_quote sums each line's `amount` (taxable ₹). Backfill it as
  -- qty × rate when the caller didn't send it.
  select coalesce(jsonb_agg(
           li || jsonb_build_object('amount',
             coalesce(nullif((li->>'amount'), '')::int,
                      coalesce((li->>'qty')::int, 1) * coalesce((li->>'rate')::int, 0)))
         ), '[]'::jsonb)
    into v_lines from jsonb_array_elements(p_line_items) li;

  select coalesce(sum(greatest(coalesce((li->>'amount')::int, 0), 0)), 0)
    into v_taxable from jsonb_array_elements(v_lines) li;
  if v_taxable <= 0 then raise exception 'Invoice total must be greater than zero'; end if;
  v_gst   := round(v_taxable * coalesce(p_gst_rate, 18) / 100.0);
  v_total := v_taxable + v_gst;   -- GST-inclusive (milestone amounts are inclusive)

  v_pid := public.create_project_quote(
    p_customer_id, p_customer_name, p_title, p_description, v_lines,
    coalesce(p_gst_rate, 18), coalesce(p_inter_state, false),
    jsonb_build_array(jsonb_build_object('label', 'Full amount', 'total_amount', v_total, 'due_date', current_date::text))
  );

  perform public.accept_project_quote(v_pid);

  select pm.id into v_msid from public.project_milestones pm where pm.project_id = v_pid order by pm.seq limit 1;
  if v_msid is null then raise exception 'Milestone was not created for project %', v_pid; end if;

  v_inv := public.raise_project_milestone_invoice(v_msid);

  return query select v_inv, v_pid;
end;
$$;

grant execute on function public.create_project_direct_invoice(uuid, text, text, text, jsonb, integer, boolean) to authenticated;
