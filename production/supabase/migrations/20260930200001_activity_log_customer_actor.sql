-- R-016 (1 Oct 2026): a portal customer's change no longer breaks the activity trigger,
-- and the activity feed names them as "Customer <name>".
--
-- BUG: log_row_change() wrote `user_id = auth.uid()` for every authenticated change.
-- activity_log.user_id references public.users(id), but a portal customer signs in as a
-- row in customer_users — they are NOT in public.users. So any write a customer made
-- through a SECURITY DEFINER RPC (set_subscription_auto_renew, portal_request_quote …)
-- died with `activity_log_user_id_fkey` and the whole change rolled back.
-- supabase/tests/portal_set_auto_renew.test.sql was red because of exactly this.
--
-- FIX: the trigger asks who the caller is.
--   * staff (in public.users)        → user_id = auth.uid(), actor_label null (as before)
--   * portal customer (customer_users) → user_id null, actor_label 'Customer <customers.name>'
--   * anyone else with a JWT          → user_id null, actor_label null (the feed says
--                                        "Someone" rather than the change failing)
-- The FK stays: it is what joins a staff row to its name/initials in the feed.
-- Body otherwise identical to 20260927150000_audit_log_values.sql.

alter table public.activity_log add column if not exists actor_label text;

comment on column public.activity_log.actor_label is
  'Who did it, when the actor is not a staff user (user_id is null) — e.g. ''Customer Acme Pvt Ltd'' for a portal customer. Null for staff rows; the feed uses users.full_name for those.';

create or replace function public.log_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_json    jsonb;
  v_old     jsonb;
  v_tenant  uuid;
  v_id      text;
  v_label   text;
  v_changes jsonb;
  v_key     text;
  v_uid     uuid := auth.uid();
  v_user    uuid;
  v_actor   text;
begin
  if v_uid is null then return null; end if;
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

  -- Who is acting: a staff user, or a portal customer (not in public.users).
  select u.id into v_user from public.users u where u.id = v_uid;
  if v_user is null then
    select 'Customer ' || c.name into v_actor
      from public.customer_users cu
      join public.customers c on c.id = cu.customer_id
     where cu.auth_user_id = v_uid
     limit 1;
  end if;

  insert into public.activity_log (tenant_id, user_id, actor_label, action, entity, entity_id, label, changes)
  values (v_tenant, v_user, left(v_actor, 120), lower(tg_op), tg_table_name, v_id, left(v_label, 120), v_changes);
  return null;
end $$;
