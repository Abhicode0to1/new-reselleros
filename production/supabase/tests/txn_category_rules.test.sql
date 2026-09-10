-- Regression test for 20260822090000_txn_categorisation.sql
--
-- WHAT THIS PROVES. The migration's safety is entirely in its constraints, and a
-- constraint that does not actually bite is decoration. Every case below asserts a
-- WRITE IS REFUSED, which is the only way to know the guard exists — `create table`
-- succeeding tells you nothing about whether the check clause works.
--
-- THE CASES (each FAILS LOUDLY -- the file is self-asserting)
--   1. A blank pattern is refused.                    <- would match every line in a file
--   2. A whitespace-only pattern is refused.          <- the same bug wearing a disguise
--   3. An unknown direction is refused.               <- vocabulary lives in the DB
--   4. The same pattern+direction twice is refused.   <- two answers for one narration
--   5. ...but the same pattern on the OTHER direction is allowed.  <- not over-blocked
--   6. A category without a source is refused.        <- unattributable number in the books
--   7. A source without a category is refused.        <- the same rule, other way round
--   8. Confidence outside 0..100 is refused.
--   9. A valid rule and a valid categorised line both insert.     <- feature works
--
-- ON CASE 5: over-blocking is the failure mode a constraint test usually misses. A unique
-- index on (tenant, pattern) alone would have looked correct and quietly made it impossible
-- to say "SALARY on a debit is wages, SALARY on a credit is a refund" — which is the exact
-- distinction the direction column exists for.
--
-- SAFETY: synthetic tenant, one transaction, ends in ROLLBACK. No real row is read into an
-- assertion or written.

begin;

insert into public.tenants (id, name, email, doc_code, tier)
values ('7e57e57e-0002-4000-8000-000000000002', 'ZZ CATRULE TEST TENANT',
        'zz-catrule@example.invalid', 'ZZCAT', 'reseller');

do $$
declare
  v_tenant uuid := '7e57e57e-0002-4000-8000-000000000002';
  v_acct   uuid;
  v_txn    uuid;
  v_ok     boolean;
begin
  -- ── 1 + 2: a pattern that would match everything ──────────────────────────
  begin
    insert into public.txn_category_rules (tenant_id, pattern, category)
    values (v_tenant, '', 'Software');
    raise exception 'CASE 1 FAIL: an empty pattern was accepted — it would categorise every line in the statement';
  exception when check_violation then null;
  end;

  begin
    insert into public.txn_category_rules (tenant_id, pattern, category)
    values (v_tenant, '    ', 'Software');
    raise exception 'CASE 2 FAIL: a whitespace-only pattern was accepted';
  exception when check_violation then null;
  end;

  -- ── 3: vocabulary ─────────────────────────────────────────────────────────
  begin
    insert into public.txn_category_rules (tenant_id, pattern, category, direction)
    values (v_tenant, 'PAYUFACEBOOK', 'Marketing', 'outgoing');
    raise exception 'CASE 3 FAIL: direction "outgoing" was accepted — the DB must hold the vocabulary, not just TypeScript';
  exception when check_violation then null;
  end;

  -- ── 4 + 5: one answer per pattern per direction ────────────────────────────
  insert into public.txn_category_rules (tenant_id, pattern, category, direction)
  values (v_tenant, 'PAYUFACEBOOK', 'Marketing', 'debit');

  begin
    -- Same pattern, same direction, DIFFERENT category: a contradiction, not a preference.
    insert into public.txn_category_rules (tenant_id, pattern, category, direction)
    values (v_tenant, '  payufacebook  ', 'Software', 'debit');
    raise exception 'CASE 4 FAIL: a second rule for the same narration+direction was accepted — the categoriser would then depend on row order';
  exception when unique_violation then null;
  end;

  -- The other direction is a genuinely different statement and must still be allowed.
  insert into public.txn_category_rules (tenant_id, pattern, category, direction)
  values (v_tenant, 'PAYUFACEBOOK', 'Marketing', 'credit');

  -- ── 6 + 7 + 8: a category must be attributable ────────────────────────────
  insert into public.bank_accounts (tenant_id, name, bank_name)
  values (v_tenant, 'ZZ Test Account', 'ZZ Bank') returning id into v_acct;

  insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, debit, credit)
  values (v_tenant, v_acct, current_date, 'K4UHU5ENAJ52FPOTCU/PAYUFACEBOOK', 5000, 0)
  returning id into v_txn;

  begin
    update public.bank_transactions set category = 'Marketing' where id = v_txn;
    raise exception 'CASE 6 FAIL: a category with no source was accepted — nobody could tell a rule hit from a machine guess';
  exception when check_violation then null;
  end;

  begin
    update public.bank_transactions set category_source = 'rule' where id = v_txn;
    raise exception 'CASE 7 FAIL: a source with no category was accepted';
  exception when check_violation then null;
  end;

  begin
    update public.bank_transactions
       set category = 'Marketing', category_source = 'ai', category_confidence = 140
     where id = v_txn;
    raise exception 'CASE 8 FAIL: confidence 140 was accepted';
  exception when check_violation then null;
  end;

  -- ── 9: the feature actually works ─────────────────────────────────────────
  update public.bank_transactions
     set category = 'Marketing', category_source = 'rule', category_confidence = 100
   where id = v_txn;

  select category = 'Marketing' and category_source = 'rule'
    into v_ok from public.bank_transactions where id = v_txn;
  if not v_ok then
    raise exception 'CASE 9 FAIL: a valid categorisation did not stick';
  end if;

  raise notice 'ALL 9 CASES PASS';
end $$;

select 'PASS' as result;

rollback;
