-- 0226_bank_balance_tenant_guard.sql
--
-- SECURITY: add the missing tenant check to bank_account_current_balance().
--
-- The function is SECURITY DEFINER, so it runs as its owner and **RLS does not
-- apply inside it**. It took an arbitrary account UUID and returned that
-- account's balance with no ownership check at all:
--
--     select coalesce((select opening_balance from bank_accounts
--                       where id = p_account_id), 0) + …
--
-- EXECUTE is granted to `authenticated` (verified; `anon` is correctly denied),
-- so any signed-in user of ANY tenant who holds or guesses a bank_accounts.id
-- could read another tenant's balance. The only thing standing in the way was
-- the secrecy of a UUID — obscurity, not isolation.
--
-- Impact today is nil: exactly one tenant currently has bank accounts (2 rows).
-- This is a LATENT hole that goes live the moment a second tenant adds an
-- account — and prod already hosts more than one real tenant.
--
-- Found by auditing all 110 SECURITY DEFINER functions. The rest were clean:
-- every one sets `search_path`, and the others that don't mention tenant_id are
-- safe for other reasons (e.g. set_subscription_auto_renew scopes by
-- current_customer_id(), which is tighter than tenant).
--
-- Both callers are authenticated client-side reads (lib/queries/bank.ts,
-- lib/queries/balance-sheet.ts), so `current_tenant_id()` is always populated —
-- no service-role path relies on this, and nothing needs to change app-side.
--
-- Idempotent: CREATE OR REPLACE, safe to re-run.

create or replace function public.bank_account_current_balance(p_account_id uuid)
returns integer
language sql
stable
security definer
set search_path to 'public'
as $function$
  -- Both halves are tenant-scoped. Filtering only the account row would still
  -- leak, since a foreign account's id would then sum ITS transactions.
  select coalesce((
           select opening_balance
             from public.bank_accounts
            where id = p_account_id
              and tenant_id = public.current_tenant_id()
         ), 0)
       + coalesce((
           select sum(credit - debit)::int
             from public.bank_transactions
            where bank_account_id = p_account_id
              and tenant_id = public.current_tenant_id()
         ), 0);
$function$;

comment on function public.bank_account_current_balance(uuid) is
  'Opening balance + net of transactions for one bank account. Tenant-scoped: a caller only ever sees their own account (the function is SECURITY DEFINER, so RLS does not apply inside it and the check must be explicit).';

-- Grants stay minimal, per 0145's deny-by-default posture: `authenticated` only.
--
-- Deliberately NOT granted to service_role. For that role `current_tenant_id()`
-- is null, so this would now return a silent 0 rather than a balance — a wrong
-- number is worse than a missing one. If a cron or webhook ever needs balances,
-- give it a separate function that takes the tenant explicitly.
revoke all on function public.bank_account_current_balance(uuid) from public, anon;
grant execute on function public.bank_account_current_balance(uuid) to authenticated;
