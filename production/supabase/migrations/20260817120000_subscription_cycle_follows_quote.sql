-- 20260817120000_subscription_cycle_follows_quote
--
-- A subscription's billing cycle is whatever the quote it was sold on says.
--
-- ─── THE GAP THIS CLOSES ────────────────────────────────────────────────────
-- record_payment builds the subscription with an explicit column list
-- (baseline.sql:4577-4583) and billing_cycle is not in it. So the column takes its
-- default — yearly — no matter what the customer signed.
--
-- That made every other piece of split billing unreachable: a customer accepts a
-- quarterly quote, whose PDF prints "Per invoice (4/yr)", and gets a yearly
-- subscription that the billing cron correctly declines to split. The cycle was
-- collected on the quote, shown to the customer, printed on the document — and then
-- dropped at the one point where it started to mean money.
--
-- ─── WHY A TRIGGER RATHER THAN A LINE IN record_payment ─────────────────────
-- record_payment is not the only thing that inserts a subscription: the Subscription
-- Onboarding dialog does, add-seats does, and the next one will not remember either.
-- The rule is about the subscription ROW, so it belongs on the table.
--
-- It is also 480 lines of money code that works. Adding one column to its insert
-- means re-deploying the whole function to change a default — a poor trade against a
-- twelve-line trigger that no future insert can route around.
--
-- ─── IT OVERWRITES, IT DOES NOT DEFER ───────────────────────────────────────
-- The quote wins even when the caller passed a cycle. The quote is the document the
-- customer signed; a subscription that disagrees with it is wrong by definition, and
-- "whoever wrote last wins" is not a rule anyone can reason about later.
--
-- Only applies when the quote actually carries a cycle. A subscription with no quote
-- behind it keeps whatever it was created with.
--
-- HOW TO VERIFY (separate run from this DDL — CLAUDE.md §25.6):
--   begin;
--     update public.quotes set billing_cycle = 'quarterly' where id = '<some quote>';
--     insert into public.subscriptions (tenant_id, customer_name, plan, quote_id, status)
--       values (…, '<some quote>', 'active') returning billing_cycle;  -- expect quarterly
--   rollback;

begin;

create or replace function public.subscription_cycle_follows_quote()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cycle public.billing_cycle;
begin
  if new.quote_id is null then
    return new;
  end if;

  select q.billing_cycle into v_cycle
    from public.quotes q
   where q.id = new.quote_id;

  if v_cycle is not null then
    new.billing_cycle := v_cycle;
  end if;

  return new;
end;
$function$;

drop trigger if exists subscriptions_cycle_follows_quote on public.subscriptions;
create trigger subscriptions_cycle_follows_quote
  before insert on public.subscriptions
  for each row
  execute function public.subscription_cycle_follows_quote();

comment on function public.subscription_cycle_follows_quote() is
  'Copies the billing cycle from the quote a subscription was sold on. On the table because record_payment omits the column entirely (baseline.sql:4577) and the onboarding dialog and add-seats insert subscriptions too.';

commit;
