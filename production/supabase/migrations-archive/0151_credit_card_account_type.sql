-- 0151 — Credit card as a liability-style bank account.
--
-- A company credit card is money you OWE (a liability), not cash you hold. We
-- model it as an account whose running balance goes NEGATIVE as you spend —
-- exactly like the existing 'overdraft' type — and reuse the whole banking
-- stack unchanged:
--
--   • A card SPEND is a `debit` bank_transaction on the card account (money out
--     of the liability's "available" → balance more negative → owed goes up),
--     categorised as an expense via the existing book_bank_txn_as_expense flow.
--   • Paying the card BILL is a normal account transfer (bank → card) via the
--     existing record_account_transfer RPC: bank gets a debit, the card gets a
--     credit → owed goes down. It is a TRANSFER, never an expense, so the card
--     spend is counted in P&L exactly once (no double-count by construction).
--
-- `bank_account_current_balance` (opening_balance + Σ(credit − debit)) already
-- yields the right number: it is ≤ 0 for a card with an outstanding balance, and
-- the UI / balance sheet present −balance as "amount owed" (a liability).
--
-- This migration only widens the account_type CHECK; no data changes.

alter table public.bank_accounts drop constraint if exists bank_accounts_account_type_check;

alter table public.bank_accounts
  add constraint bank_accounts_account_type_check
  check (account_type = any (array[
    'current', 'savings', 'overdraft', 'fixed_deposit', 'cash', 'other', 'credit_card'
  ]::text[]));
