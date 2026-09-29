-- Audit log with the values that changed (27 Sep 2026).
--
-- activity_log said "expense updated — Office Rent" and nothing else: not the amount
-- before, not the amount after, not which field. For a money row that is a log of the
-- fact that something happened, not of what. Now:
--
--   update → changes = { "<column>": { "old": …, "new": … } } for every column that
--            actually changed (updated_at / created_at ignored); no row when nothing did.
--   delete → changes = { "old": <the whole row> }, so a deleted expense, salary or
--            challan can be read back — and re-entered — from the log.
--   insert → no values (the row itself is the record), as before.
--
-- Attached to the money tables that had no trail at all: salary_payments,
-- tax_payments, statutory_dues_payments, prepaid_advances, credit_notes, debit_notes,
-- referral_commissions, project_payments, tds_receivable. The trigger stays
-- SECURITY DEFINER and only fires for a signed-in user (auth.uid()), as before.

alter table public.activity_log add column if not exists changes jsonb;

create or replace function public.log_row_change()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_json    jsonb;
  v_old     jsonb;
  v_tenant  uuid;
  v_id      text;
  v_label   text;
  v_changes jsonb;
  v_key     text;
begin
  if auth.uid() is null then return null; end if;
  if tg_op = 'DELETE' then v_json := to_jsonb(old); else v_json := to_jsonb(new); end if;
  v_tenant := nullif(v_json->>'tenant_id', '')::uuid;
  if v_tenant is null then return null; end if;
  v_id := v_json->>'id';
  v_label := coalesce(
    v_json->>'full_name', v_json->>'name', v_json->>'company', v_json->>'company_name',
    v_json->>'invoice_no', v_json->>'quote_no', v_json->>'title', v_json->>'vendor_name',
    v_json->>'category', v_json->>'kind', v_json->>'period', ''
  );

  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    v_changes := '{}'::jsonb;
    for v_key in select jsonb_object_keys(v_json) loop
      if v_key in ('updated_at', 'created_at') then continue; end if;
      if v_json->v_key is distinct from v_old->v_key then
        v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('old', v_old->v_key, 'new', v_json->v_key));
      end if;
    end loop;
    if v_changes = '{}'::jsonb then return null; end if;   -- a touch, not a change
  elsif tg_op = 'DELETE' then
    v_changes := jsonb_build_object('old', v_json);
  end if;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), lower(tg_op), tg_table_name, v_id, left(v_label, 120), v_changes);
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['salary_payments', 'tax_payments', 'statutory_dues_payments', 'prepaid_advances',
                           'credit_notes', 'debit_notes', 'referral_commissions', 'project_payments', 'tds_receivable']
  loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop trigger if exists trg_activity_%I on public.%I', t, t);
    execute format('create trigger trg_activity_%I after insert or update or delete on public.%I for each row execute function public.log_row_change()', t, t);
  end loop;
end $$;
