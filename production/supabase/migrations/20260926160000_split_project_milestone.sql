-- Split a project milestone so a part payment gets an invoice for what was paid.
--
-- raise_project_milestone_invoice invoices the WHOLE milestone. A ₹5,90,000 instalment booked
-- against the ₹23,60,000 "Advance baaki" milestone (Banking → Reconcile → Project payment,
-- "invoice bhi bana do") produced a ₹23,60,000 invoice, still "pending", with outstanding
-- shown as ₹23.6L instead of ₹17.7L (26 Sep 2026).
--
-- split_project_milestone(milestone, amount, label) carves `amount` (GST-inclusive) out of an
-- untouched milestone into a new milestone placed just before it; the original keeps the rest.
-- The project total does not change. The reconcile flow splits first, then pays and invoices
-- the new milestone — so the invoice is exactly the money received.
-- Refused unless the milestone has no invoice and no payments yet, and 0 < amount < total.

create or replace function public.split_project_milestone(
  p_milestone_id uuid,
  p_amount       integer,
  p_label        text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_ms     public.project_milestones;
  v_id     uuid;
begin
  if v_tenant is null then raise exception 'No tenant in context'; end if;
  select * into v_ms from public.project_milestones where id = p_milestone_id for update;
  if not found then raise exception 'Milestone not found'; end if;
  if v_ms.tenant_id is distinct from v_tenant then
    raise exception 'Milestone not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  if v_ms.invoice_id is not null then
    raise exception 'Milestone "%" is already invoiced — it cannot be split.', v_ms.label;
  end if;
  if exists (select 1 from public.project_payments where milestone_id = p_milestone_id) then
    raise exception 'Milestone "%" already has payments — record this one without an invoice, or split it from the project page.', v_ms.label;
  end if;
  if coalesce(p_amount, 0) <= 0 or p_amount >= v_ms.total_amount then
    raise exception 'Split amount must be more than 0 and less than the milestone (₹%).', v_ms.total_amount;
  end if;

  -- make room: the new part takes this milestone's place, the rest moves one down
  update public.project_milestones set seq = seq + 1
   where project_id = v_ms.project_id and seq >= v_ms.seq;

  insert into public.project_milestones (tenant_id, project_id, seq, label, total_amount, due_date, status)
  values (v_ms.tenant_id, v_ms.project_id, v_ms.seq,
          coalesce(nullif(trim(coalesce(p_label, '')), ''), v_ms.label || ' (part)'),
          p_amount, v_ms.due_date, 'pending')
  returning id into v_id;

  update public.project_milestones set total_amount = total_amount - p_amount where id = p_milestone_id;
  update public.project_sales set updated_at = now() where id = v_ms.project_id;
  return v_id;
end;
$$;

revoke all on function public.split_project_milestone(uuid, integer, text) from public, anon;
grant execute on function public.split_project_milestone(uuid, integer, text) to authenticated;

comment on function public.split_project_milestone(uuid, integer, text) is
  'Carve p_amount out of an untouched milestone into a new milestone just before it (project total unchanged) — so a part payment is invoiced for what was paid.';
