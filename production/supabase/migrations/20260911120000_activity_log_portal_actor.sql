-- A portal customer could not write ANYTHING. The audit trigger refused it.
--
-- ─── WHAT WAS BROKEN, AND PROVEN BROKEN ─────────────────────────────────────
-- `log_row_change()` is the generic audit trigger. It sits on thirteen tables:
--
--   bank_transactions contacts customers employees expenses invoices leads
--   payments project_sales quotes subscriptions users vendor_bills
--
-- and it stamps `auth.uid()` into `activity_log.user_id`. That column references
-- `public.users`, which holds STAFF. A portal customer is a row in
-- `customer_users` and has NO row in `users` — so every write they made hit:
--
--   23503  insert or update on table "activity_log"
--          violates foreign key constraint "activity_log_user_id_fkey"
--
-- Measured 11 Sep 2026, as a real portal customer (an auth user with
-- `is_staff = false`) against a local database:
--
--   insert into public.leads (…)            → 23503, the FK above
--   set_subscription_auto_renew(…)          → 23503, the FK above
--
-- Those are not obscure paths. The first is what `portal_request_quote` does,
-- i.e. the "Request a quote" button that is the primary call to action on
-- `/portal/shop`. The second is the auto-renew toggle on `/portal/subscription`.
-- Both failed for every genuine customer.
--
-- ─── WHY IT WAS NEVER SEEN ──────────────────────────────────────────────────
-- The trigger already returns early when `auth.uid()` is null, so service_role
-- (webhooks, cron) and anon (public buy pages) were never affected. What is left
-- is exactly one caller: a signed-in portal customer. And the SQL regression test
-- for the auto-renew RPC borrowed its auth user with
--
--   select id from public.customer_users … from auth.users limit 1
--
-- — an arbitrary row, which on every database that mattered happened to be a
-- STAFF member's auth user. So the test exercised the portal RPC as if a staff
-- account were the customer, and passed. It went red the moment a real customer
-- signed in on that database and `limit 1` returned them instead. The test is
-- fixed separately; it now creates its own auth user.
--
-- ─── THE FIX: NULL ACTOR, NAMED IN THE LABEL ────────────────────────────────
-- The same choice already made by hand in `api/portal/hosting/[id]/panel/route.ts`
-- when it writes its own audit row, and for the same reason: pointing
-- `user_id` at a staff id would credit the action to somebody who did not take
-- it, and dropping the row would hide a customer-initiated change from the
-- reseller who needs to see it ("the customer turned off auto-renew").
--
-- So the row is still written, with `user_id = null` and the customer named in
-- the label. `activity_log.user_id` is already nullable, and the read path
-- already copes: `lib/queries/activity.ts` embeds the actor over the nullable FK
-- (a LEFT join in PostgREST, not `!inner`), and `(app)/activity/page.tsx` renders
-- `r.actor?.full_name ?? "Someone"` with `r.actor?.initials ?? "?"`, and only
-- offers a row in the actor filter `if (r.user_id)`. Nothing needed changing
-- there — which is what makes null the right shape rather than a workaround.
--
-- The actor goes FIRST in the label, before the row's own name, because the label
-- is truncated at 120 characters. Put it last and a long company name would push
-- the only identifying detail off the end, leaving a row that says "Someone"
-- twice over.
--
-- Staff rows are deliberately byte-identical to before: same `user_id`, same
-- `left(v_label, 120)`. This migration must not rewrite anybody's audit history
-- shape, only stop refusing half the actors.

create or replace function public.log_row_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_json      jsonb;
  v_tenant    uuid;
  v_id        text;
  v_label     text;
  v_uid       uuid;
  v_is_staff  boolean;
  v_customer  text;
begin
  v_uid := auth.uid();
  /* Unchanged: no session, no audit row. This is what keeps service_role
     (cron, webhooks) and anon (public buy pages) out of here entirely. */
  if v_uid is null then return null; end if;

  if tg_op = 'DELETE' then v_json := to_jsonb(old); else v_json := to_jsonb(new); end if;
  v_tenant := nullif(v_json->>'tenant_id', '')::uuid;
  if v_tenant is null then return null; end if;
  v_id := v_json->>'id';
  v_label := coalesce(
    v_json->>'full_name', v_json->>'name', v_json->>'company', v_json->>'company_name',
    v_json->>'invoice_no', v_json->>'quote_no', v_json->>'title', v_json->>'vendor_name', ''
  );

  /* The whole fix. `users` holds staff; a portal customer is only in
     `customer_users`. RLS is not in the way here — this function is
     SECURITY DEFINER and its owner bypasses it. */
  v_is_staff := exists (select 1 from public.users u where u.id = v_uid);

  if v_is_staff then
    insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label)
    values (v_tenant, v_uid, lower(tg_op), tg_table_name, v_id, left(v_label, 120));
  else
    select cu.email into v_customer
      from public.customer_users cu
     where cu.auth_user_id = v_uid
     limit 1;

    insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label)
    values (
      v_tenant,
      /* Not v_uid: the FK points at staff, and this actor is not staff. */
      null,
      lower(tg_op),
      tg_table_name,
      v_id,
      left(
        coalesce(nullif(btrim(v_customer), ''), 'A portal customer')
          || ' (customer portal)'
          || case when coalesce(v_label, '') <> '' then ' — ' || v_label else '' end,
        120)
    );
  end if;

  return null;
end $function$;

comment on function public.log_row_change() is
  'Generic audit trigger. Staff actions are stamped with their users.id. A portal customer has no users row, so their actions are recorded with user_id = null and the customer named first in the label — before 11 Sep 2026 they raised a foreign-key violation instead, which made every portal write fail (proven on leads and subscriptions).';
