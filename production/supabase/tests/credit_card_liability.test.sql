-- Regression test: credit card as a liability account (migration 0151).
--
-- Run against a dev/test DB (NOT prod). Self-asserting: RAISEs on failure.
-- Everything runs inside a transaction that ROLLS BACK, so the DB stays clean.
--
-- What it proves — the money accounting of a company credit card:
--   1. A card SPEND (a debit on the card account) makes the card's running
--      balance go NEGATIVE by that amount → "owed" goes up. The bank is untouched.
--   2. Paying the card BILL (a bank→card transfer: bank debit + card credit)
--      reduces the bank and clears the card's owed.
--   3. Net worth (bank + card) is UNCHANGED by the bill payment — the expense is
--      counted exactly once (at spend time), never double-counted by the payment.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code)
  values ('bbbbbbbb-0000-0000-0000-0000000000b1'::uuid, 'CC LIABILITY TEST', 'cc-liab@example.in', '07');

/* An operator inside this tenant, and this is the fix of 22 Aug 2026.
   `bank_account_current_balance` is SECURITY DEFINER and scoped by `current_tenant_id()`.
   The file set only {"role":"service_role"} — a role, not an identity — so there was no
   tenant to scope to and the function returned 0 for every account. The failure read
   "FAIL: card spend touched the bank (bank=0)", which sent a reader looking at card logic
   for a number that came from an empty result. See AGENTS.md L10: distinguish a wrong
   number from no rows. */
insert into auth.users (id, email)
  values ('bbbbbbbb-0000-0000-0000-0000000000a1'::uuid, 'cc-tester@example.test');
insert into public.users (id, tenant_id, email, full_name, role, is_active)
  values ('bbbbbbbb-0000-0000-0000-0000000000a1'::uuid, 'bbbbbbbb-0000-0000-0000-0000000000b1'::uuid,
          'cc-tester@example.test', 'CC Tester', 'owner', true);
select set_config('request.jwt.claims',
  json_build_object('sub','bbbbbbbb-0000-0000-0000-0000000000a1','role','authenticated')::text, true);

insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date, is_active)
  values ('bbbbbbbb-0000-0000-0000-00000000bb01'::uuid, 'bbbbbbbb-0000-0000-0000-0000000000b1'::uuid, 'HDFC Current', 'HDFC', 'current', 100000, current_date, true);
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date, is_active)
  values ('bbbbbbbb-0000-0000-0000-00000000bb02'::uuid, 'bbbbbbbb-0000-0000-0000-0000000000b1'::uuid, 'HDFC Credit Card', 'Credit Card', 'credit_card', 0, current_date, true);

do $$
declare
  v_bank uuid := 'bbbbbbbb-0000-0000-0000-00000000bb01';
  v_card uuid := 'bbbbbbbb-0000-0000-0000-00000000bb02';
  v_bank1 int; v_card1 int; v_bank2 int; v_card2 int;
begin
  -- 1. Card spend ₹5,000 — a debit on the card (owed goes up), bank untouched.
  insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
    values ('bbbbbbbb-0000-0000-0000-0000000000b1'::uuid, v_card, current_date, 'AWS hosting', 5000, 0, 'manual', 'expense', 'manual');

  v_bank1 := public.bank_account_current_balance(v_bank);
  v_card1 := public.bank_account_current_balance(v_card);
  if v_bank1 <> 100000 then raise exception 'FAIL: card spend touched the bank (bank=%)', v_bank1; end if;
  if v_card1 <> -5000  then raise exception 'FAIL: card spend did not raise owed (card=%, expected -5000)', v_card1; end if;

  -- 2. Pay the card bill — transfer bank → card ₹5,000 (bank debit + card credit).
  insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
    values ('bbbbbbbb-0000-0000-0000-0000000000b1'::uuid, v_bank, current_date, 'Card bill payment', 5000, 0, 'manual', 'transfer', 'manual');
  insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
    values ('bbbbbbbb-0000-0000-0000-0000000000b1'::uuid, v_card, current_date, 'Card bill received', 0, 5000, 'manual', 'transfer', 'manual');

  v_bank2 := public.bank_account_current_balance(v_bank);
  v_card2 := public.bank_account_current_balance(v_card);
  if v_bank2 <> 95000 then raise exception 'FAIL: bill payment wrong bank balance (bank=%, expected 95000)', v_bank2; end if;
  if v_card2 <> 0     then raise exception 'FAIL: bill payment did not clear the card (card=%, expected 0)', v_card2; end if;

  -- 3. Net worth unchanged by the bill payment (expense counted once).
  if (v_bank1 + v_card1) <> (v_bank2 + v_card2) then
    raise exception 'FAIL: bill payment changed net worth %→% (double-count!)', v_bank1 + v_card1, v_bank2 + v_card2;
  end if;

  raise notice 'PASS: card spend raises owed (bank untouched); bill payment clears card + debits bank; net worth unchanged (no double-count)';
end $$;

-- A NOTICE is invisible through `supabase db query -f`: this file returned exit 0 with no
-- output at all, which is indistinguishable from a file that asserted nothing. One row says it.
select 'PASS' as credit_card_liability;

rollback;
