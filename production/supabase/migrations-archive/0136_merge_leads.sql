-- 0136_merge_leads.sql
-- Manual, confirmed lead de-duplication.
--
-- The Leads list flags likely duplicates (same phone / same company). When the
-- operator explicitly picks a primary and confirms a merge, this RPC folds the
-- duplicate INTO the primary atomically:
--   1. every child row (activities, quotes, tasks, campaign sends, coupon
--      redemptions, promoted-from contact) is repointed duplicate -> primary,
--   2. the primary's EMPTY fields are backfilled from the duplicate (never
--      overwriting data the primary already has); the bigger deal value wins,
--      and any duplicate notes are appended rather than lost,
--   3. the now-empty duplicate lead is deleted.
--
-- Nothing here runs without the operator's explicit confirm in the merge dialog.
-- SECURITY DEFINER + explicit tenant scoping (RLS is bypassed for definer fns).

create or replace function public.merge_leads(
  p_primary_id   text,
  p_duplicate_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant    uuid := current_tenant_id();
  v_primary   public.leads;
  v_duplicate public.leads;
begin
  if v_tenant is null then
    raise exception 'No tenant in context';
  end if;
  if p_primary_id = p_duplicate_id then
    raise exception 'Cannot merge a lead into itself';
  end if;

  -- Lock + fetch both rows, tenant-scoped. Locking prevents a concurrent edit
  -- from racing the merge.
  select * into v_primary
  from public.leads
  where id = p_primary_id and tenant_id = v_tenant
  for update;
  if not found then
    raise exception 'Primary lead % not found in this tenant', p_primary_id;
  end if;

  select * into v_duplicate
  from public.leads
  where id = p_duplicate_id and tenant_id = v_tenant
  for update;
  if not found then
    raise exception 'Duplicate lead % not found in this tenant', p_duplicate_id;
  end if;

  -- 1. Repoint every child row duplicate -> primary. lead ids are globally
  --    unique text PKs and we already proved the duplicate belongs to this
  --    tenant, so filtering on lead_id alone is safe (no cross-tenant leak).
  update public.lead_activities   set lead_id = p_primary_id where lead_id = p_duplicate_id;
  update public.quotes            set lead_id = p_primary_id where lead_id = p_duplicate_id;
  update public.tasks             set lead_id = p_primary_id where lead_id = p_duplicate_id;
  update public.campaign_sends    set lead_id = p_primary_id where lead_id = p_duplicate_id;
  update public.coupon_redemptions set lead_id = p_primary_id where lead_id = p_duplicate_id;
  update public.contacts          set promoted_to_lead_id = p_primary_id where promoted_to_lead_id = p_duplicate_id;

  -- 2. Backfill ONLY the primary's empty fields from the duplicate. Existing
  --    primary data is never overwritten. Value keeps the larger figure; notes
  --    are concatenated so nothing the operator typed is lost.
  update public.leads set
    contact_name  = coalesce(contact_name,  v_duplicate.contact_name),
    contact_email = coalesce(contact_email, v_duplicate.contact_email),
    contact_phone = coalesce(contact_phone, v_duplicate.contact_phone),
    plan          = coalesce(plan,          v_duplicate.plan),
    seats         = coalesce(seats,         v_duplicate.seats),
    value         = nullif(greatest(coalesce(value, 0), coalesce(v_duplicate.value, 0)), 0),
    gstin         = coalesce(gstin,         v_duplicate.gstin),
    domain        = coalesce(domain,        v_duplicate.domain),
    state_code    = coalesce(state_code,    v_duplicate.state_code),
    state         = coalesce(state,         v_duplicate.state),
    owner_id      = coalesce(owner_id,      v_duplicate.owner_id),
    follow_up_date = coalesce(follow_up_date, v_duplicate.follow_up_date),
    notes         = case
                      when coalesce(v_duplicate.notes, '') = '' then notes
                      when coalesce(notes, '') = ''             then v_duplicate.notes
                      else notes || E'\n---\n(merged) ' || v_duplicate.notes
                    end,
    updated_at    = now()
  where id = p_primary_id and tenant_id = v_tenant;

  -- 3. Delete the folded-in duplicate.
  delete from public.leads where id = p_duplicate_id and tenant_id = v_tenant;
end;
$$;

grant execute on function public.merge_leads(text, text) to authenticated;
