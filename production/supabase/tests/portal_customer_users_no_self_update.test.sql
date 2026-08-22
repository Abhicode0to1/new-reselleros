-- Regression test: a portal customer cannot re-point their own customer_users link to
-- another customer (migration 0064 — cross-customer escalation hole).
--
-- Proves:
--   1. As the authenticated portal user, UPDATE customer_users SET customer_id=<victim>
--      affects 0 rows — and it affects 0 rows BECAUSE the policy refuses it.
--   2. portal_touch_login() still stamps last_login_at on the caller's own row.
--
-- ─── REWRITTEN 22 Aug 2026 — CASE 1 WAS PASSING FOR THE WRONG REASON ────────
-- The old file did this, in this order:
--
--     set local role authenticated;
--     do $$ begin
--       select auth_user_id::text into v_uid from public.customer_users where customer_id = '…a7';
--       perform set_config('request.jwt.claims', json_build_object('sub', v_uid, …), true);
--       update public.customer_users set customer_id = '…a8' where auth_user_id::text = v_uid;
--       -- assert 0 rows updated
--
-- The SELECT runs as `authenticated` with **no claims set yet**, so RLS filters it and
-- `v_uid` comes back NULL. The exploit UPDATE then reads
-- `where auth_user_id::text = NULL`, which matches nothing whatever the policies say. The
-- security assertion passed against a query that could never have touched a row — the
-- classic "cannot insert / cannot update" test that is free to pass because the statement was
-- never valid to begin with. `sandbox_tenant_isolation.test.sql` documents the same trap from
-- its own history.
--
-- The visible symptom was case 2: `portal_touch_login()` keys off `auth.uid()`, and with a
-- null sub it also updated nothing — `FAIL: last_login_at not stamped by RPC`. That failure
-- was the only reason anybody looked, and it was the lesser of the two problems.
--
-- Fixed the way `hierarchy_peer_isolation.test.sql` already does it: **read the id BEFORE the
-- role switch** and carry it in a transaction-local GUC, which `authenticated` can read but a
-- temp table it cannot. The fixture also creates its own auth user rather than borrowing the
-- first real one (AGENTS.md L11).

begin;

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('ffffffff-0000-0000-0000-0000000000a7', 'SEC T', 'sec@example.in', '07', 'SEC1');

insert into public.customers (id, tenant_id, name)
  values ('cccccccc-0000-0000-0000-0000000000a7', 'ffffffff-0000-0000-0000-0000000000a7', 'Cust A'),
         ('cccccccc-0000-0000-0000-0000000000a8', 'ffffffff-0000-0000-0000-0000000000a7', 'Cust B (victim)');

insert into auth.users (id, email)
  values ('ffffffff-0000-0000-0000-0000000000e1', 'portal-tester@example.test');

insert into public.customer_users (auth_user_id, customer_id, tenant_id, email, role, last_login_at)
  values ('ffffffff-0000-0000-0000-0000000000e1', 'cccccccc-0000-0000-0000-0000000000a7',
          'ffffffff-0000-0000-0000-0000000000a7', 'a@sec.in', 'admin', '2020-01-01T00:00:00Z');

/* Captured BEFORE the role switch, while the connection can still see the row. This is the
   whole fix: afterwards the SELECT returns nothing and every later comparison silently
   becomes "= NULL". */
select set_config('portal.uid', 'ffffffff-0000-0000-0000-0000000000e1', true);

set local role authenticated;

do $$
declare v_uid text := current_setting('portal.uid', true); v_cnt int;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  /* Guard the guard. If the id were ever null again, everything below would pass for free —
     which is exactly what happened before 22 Aug 2026. */
  if v_uid is null or v_uid = '' then
    raise exception 'SETUP FAIL: portal.uid is empty, so the exploit below would match no rows and prove nothing';
  end if;
  if auth.uid()::text <> v_uid then
    raise exception 'SETUP FAIL: auth.uid() is % but the portal user is % — the impersonation did not take', auth.uid(), v_uid;
  end if;

  /* Prove the row IS reachable as this user, so "0 rows updated" below means refused and
     not invisible. */
  select count(*) into v_cnt from public.customer_users where auth_user_id::text = v_uid;
  if v_cnt <> 1 then
    raise exception 'SETUP FAIL: the portal user sees % of their own link rows, expected 1 — a blocked session cannot demonstrate a blocked update', v_cnt;
  end if;

  -- ── 1. THE EXPLOIT: re-point my own link at another customer ──────────────
  update public.customer_users
     set customer_id = 'cccccccc-0000-0000-0000-0000000000a8'
   where auth_user_id::text = v_uid;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 0 then
    raise exception 'FAIL: exploit updated % row(s) — a portal customer could re-point their link at another customer''s data', v_cnt;
  end if;

  -- ── 2. and the legitimate RPC still works ────────────────────────────────
  perform public.portal_touch_login();
end $$;

reset role;

do $$
declare v_cid uuid; v_ll timestamptz;
begin
  select customer_id, last_login_at into v_cid, v_ll
    from public.customer_users
   where auth_user_id = 'ffffffff-0000-0000-0000-0000000000e1';

  if v_cid <> 'cccccccc-0000-0000-0000-0000000000a7' then
    raise exception 'FAIL: link customer_id changed to % (cross-customer leak)', v_cid;
  end if;
  if v_ll <= '2020-01-02T00:00:00Z' then
    raise exception 'FAIL: last_login_at not stamped by portal_touch_login (%)', v_ll;
  end if;

  raise notice 'PASS: link intact (no escalation) and last_login stamped via portal_touch_login';
end $$;

select 'PASS' as portal_customer_users_no_self_update;

rollback;
