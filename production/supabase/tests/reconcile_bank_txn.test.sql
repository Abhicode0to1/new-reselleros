-- Regression test: reconcile_bank_txn (migration 20260901160000)
--
-- Run against the live/linked DB. Self-asserting: RAISEs on failure. The whole
-- thing runs inside a transaction that ROLLS BACK, so the DB stays clean.
--
--   env -u SUPABASE_ACCESS_TOKEN npx supabase db query --linked \
--     -f supabase/tests/reconcile_bank_txn.test.sql
--
-- What it proves — the reason this RPC exists at all:
--   1. Matching a bank line to an expense sets BOTH the bank line's match AND
--      the expense's reverse link (reconciled_txn_id) in ONE call. The old
--      client did this as separate round trips; a failure between them left a
--      matched line with no reverse link. Here it is one transaction.
--   2. Un-reconciling (type = null) reverses everything the match created — the
--      expense link, the balance-sheet classification, and the statutory-dues
--      payment — so none of them can outlive the reconciliation.
--   3. A caller in tenant B CANNOT reconcile tenant A's bank line. The function
--      is SECURITY DEFINER (it reads the row past RLS), so the explicit tenant
--      guard is the only thing standing between two workspaces' money.

begin;

-- ── Fixtures: two tenants, a user in B, one bank account + line in A ─────────
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code) values
  ('cccccccc-0000-0000-0000-0000000000a1'::uuid, 'RECON TEST A', 'recon-a@example.in', '07'),
  ('cccccccc-0000-0000-0000-0000000000b1'::uuid, 'RECON TEST B', 'recon-b@example.in', '07');

insert into auth.users (id, email) values
  ('cccccccc-0000-0000-0000-0000000000b2', 'user-b@example.test');
insert into public.users (id, tenant_id, email) values
  ('cccccccc-0000-0000-0000-0000000000b2'::uuid, 'cccccccc-0000-0000-0000-0000000000b1'::uuid, 'user-b@example.in');

insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date, is_active)
  values ('cccccccc-0000-0000-0000-00000000ac01'::uuid, 'cccccccc-0000-0000-0000-0000000000a1'::uuid,
          'Recon HDFC', 'HDFC', 'current', 0, current_date, true);

-- Money-OUT line + an expense of the same amount, both tenant A, both unmatched.
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, source)
  values ('cccccccc-0000-0000-0000-0000000000f1'::uuid, 'cccccccc-0000-0000-0000-0000000000a1'::uuid,
          'cccccccc-0000-0000-0000-00000000ac01'::uuid, current_date, 'AWS invoice', 5000, 'manual');
insert into public.expenses (id, tenant_id, category, expense_date, amount)
  values ('EXP-RECON-1', 'cccccccc-0000-0000-0000-0000000000a1'::uuid, 'software', current_date, 5000);

-- ── Test 1: match to expense sets the bank line AND the reverse link, atomically ──
do $$
declare v_type text; v_id text; v_link uuid;
begin
  perform public.reconcile_bank_txn(
    'cccccccc-0000-0000-0000-0000000000f1'::uuid, 'expense', 'EXP-RECON-1', 'manual');

  select matched_to_type, matched_to_id into v_type, v_id
    from public.bank_transactions where id = 'cccccccc-0000-0000-0000-0000000000f1'::uuid;
  if v_type is distinct from 'expense' or v_id is distinct from 'EXP-RECON-1' then
    raise exception 'FAIL 1a: bank line not matched (type=%, id=%)', v_type, v_id;
  end if;

  select reconciled_txn_id into v_link from public.expenses where id = 'EXP-RECON-1';
  if v_link is distinct from 'cccccccc-0000-0000-0000-0000000000f1'::uuid then
    raise exception 'FAIL 1b: expense reverse link not set (got %) — this is the half-reconcile the RPC exists to stop', v_link;
  end if;
  raise notice 'PASS 1: match set both the bank line and the expense reverse link in one call';
end $$;

-- ── Test 2: un-reconcile reverses the expense link + balance-sheet + statutory ──
insert into public.balance_sheet_items (tenant_id, section, label, bank_txn_id)
  values ('cccccccc-0000-0000-0000-0000000000a1'::uuid, 'liability', 'Director loan',
          'cccccccc-0000-0000-0000-0000000000f1'::uuid);
insert into public.statutory_dues_payments (tenant_id, amount, paid_on, bank_txn_id)
  values ('cccccccc-0000-0000-0000-0000000000a1'::uuid, 5000, current_date,
          'cccccccc-0000-0000-0000-0000000000f1'::uuid);

do $$
declare v_type text; v_link uuid; v_bs int; v_st int;
begin
  perform public.reconcile_bank_txn(
    'cccccccc-0000-0000-0000-0000000000f1'::uuid, null, null, null);

  select matched_to_type into v_type from public.bank_transactions where id = 'cccccccc-0000-0000-0000-0000000000f1'::uuid;
  if v_type is not null then raise exception 'FAIL 2a: bank line still matched after un-reconcile (%)', v_type; end if;

  select reconciled_txn_id into v_link from public.expenses where id = 'EXP-RECON-1';
  if v_link is not null then raise exception 'FAIL 2b: expense link survived un-reconcile (%)', v_link; end if;

  select count(*) into v_bs from public.balance_sheet_items where bank_txn_id = 'cccccccc-0000-0000-0000-0000000000f1'::uuid;
  select count(*) into v_st from public.statutory_dues_payments where bank_txn_id = 'cccccccc-0000-0000-0000-0000000000f1'::uuid;
  if v_bs <> 0 then raise exception 'FAIL 2c: balance-sheet classification survived un-reconcile (% rows)', v_bs; end if;
  if v_st <> 0 then raise exception 'FAIL 2d: statutory payment survived un-reconcile (% rows)', v_st; end if;
  raise notice 'PASS 2: un-reconcile reversed the expense link, the balance-sheet line and the statutory payment';
end $$;

-- ── Test 3: a tenant-B caller cannot touch tenant A's bank line ─────────────
select set_config('request.jwt.claims',
  '{"sub":"cccccccc-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
set local role authenticated;

do $$
declare ok boolean := false;
begin
  begin
    perform public.reconcile_bank_txn(
      'cccccccc-0000-0000-0000-0000000000f1'::uuid, 'expense', 'EXP-RECON-1', 'manual');
  exception when insufficient_privilege then
    ok := true;
  end;
  if not ok then
    raise exception 'FAIL 3: tenant B reconciled tenant A''s bank line — the tenant guard did not hold';
  end if;
  raise notice 'PASS 3: cross-tenant reconcile was refused';
end $$;

reset role;
rollback;
