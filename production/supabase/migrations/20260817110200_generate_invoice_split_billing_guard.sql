-- 20260817110200_generate_invoice_split_billing_guard
--
-- Stop a split-billed subscription being invoiced TWICE.
--
-- ─── THE COLLISION ──────────────────────────────────────────────────────────
-- With 20260817110000 in place there are now two things that can raise an invoice
-- for the same money:
--
--   · the quote path (generate_invoice / create_direct_invoice) → one invoice for
--     the whole term
--   · raise_subscription_billing(instalment)                    → one per period
--
-- A quarterly ₹28,320 subscription billed by both is ₹56,640 of tax invoices for
-- ₹28,320 of supply. Worse than an overcharge: two documents in a numbered GST
-- series describing supply that happened once.
--
-- ─── WHY A TRIGGER AND NOT A CHECK INSIDE generate_invoice ──────────────────
-- generate_invoice is not the only way a row reaches public.invoices —
-- create_direct_invoice (0158) is another, and the next one will not remember this
-- rule either. The fact being protected is about the INVOICE ROW, so it belongs on
-- the table, where every path has to pass it.
--
-- ─── THE LINE BETWEEN THE TWO PATHS ─────────────────────────────────────────
-- The cycle decides. A YEARLY subscription splits into exactly one period, which is
-- what the quote path already does — so yearly is untouched and nothing about
-- today's behaviour changes. Only cycles that genuinely split (monthly, quarterly,
-- half-yearly) move to instalments, and for those the quote path must refuse.
--
-- Instalment invoices carry quote_id NULL, so they pass the guard by construction
-- rather than by an exemption someone could later widen.
--
-- ─── THE REFUSAL NAMES THE NEXT STEP (CLAUDE.md §24) ────────────────────────
-- The rep clicked "Generate invoice" and is entitled to know where the invoice went,
-- not just that they cannot have one.
--
-- HOW TO VERIFY (separate run from this DDL — CLAUDE.md §25.6):
--   begin;
--     update public.subscriptions set billing_cycle='quarterly' where quote_id is not null;
--     select public.generate_invoice((select quote_id from public.subscriptions limit 1));
--     -- expect: 'This subscription is billed quarterly …'
--   rollback;

begin;

create or replace function public.reject_full_term_invoice_when_split_billed()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cycle text;
begin
  /* An instalment invoice has no quote behind it — nothing to collide with. */
  if new.quote_id is null then
    return new;
  end if;

  select s.billing_cycle::text into v_cycle
    from public.subscriptions s
   where s.quote_id = new.quote_id
     and s.billing_cycle is distinct from 'yearly'::billing_cycle
   limit 1;

  if v_cycle is not null then
    raise exception
      'This subscription is billed %, so it is invoiced one period at a time — not once for the whole term. Each period is invoiced automatically on its own date; open the subscription to see the billing schedule.',
      replace(v_cycle, '_', '-')
      using errcode = 'check_violation';
  end if;

  return new;
end;
$function$;

drop trigger if exists invoices_reject_full_term_when_split_billed on public.invoices;
create trigger invoices_reject_full_term_when_split_billed
  before insert on public.invoices
  for each row
  execute function public.reject_full_term_invoice_when_split_billed();

comment on function public.reject_full_term_invoice_when_split_billed() is
  'Refuses a whole-term invoice for a subscription that is billed per period. On the table rather than inside generate_invoice because create_direct_invoice reaches public.invoices too.';

commit;
