-- 20260816130000_subscription_billing_terms
--
-- WHAT THIS ADDS
--   subscriptions.billing_cycle           monthly | quarterly | half_yearly | yearly
--   subscriptions.term_months             12 by default; 24/36 for a multi-year deal
--   subscriptions.parent_subscription_id  the main plan an add-on is co-termed to
--
-- WHY billing_cycle MOVES ONTO THE SUBSCRIPTION
--   It only existed on `quotes`. A quote is the document that SOLD the thing; the
--   subscription is the thing. Once a quote is paid, nothing downstream could answer
--   "how often is this customer invoiced?" without walking back to a quote that may
--   have been superseded, and renewal quotes did not carry it forward at all.
--
--   lib/quotes/billing.ts is blunt about the state it was in: "frequency is a stated
--   schedule/label — it does not (yet) auto-generate N invoices per year in the DB."
--   This column is what a real billing run reads.
--
-- WHY term_months EXISTS SEPARATELY FROM renewal_date
--   renewal_date says WHEN the term ends. term_months says HOW LONG it is, which is
--   what a schedule needs to lay out instalments. They can be derived from each other
--   only if you assume 12 — the assumption that makes multi-year impossible.
--
-- WHY parent_subscription_id AND NOT A SHARED "anniversary" COLUMN
--   Co-terming is a relationship, not a date. Copying the parent's anniversary onto
--   the child looks equivalent until the parent's renewal moves — an extension, a
--   term change — and the copies silently disagree. A foreign key cannot drift.
--
--   ON DELETE SET NULL, not CASCADE: deleting a main plan must never delete the
--   backup add-on the customer is still using. The add-on simply stops being
--   co-termed and keeps its own dates.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   It does not backfill billing_cycle from the originating quote. Most rows predate
--   any cycle being meaningful and every one of them is annual in practice, so the
--   default is correct AND honest — writing a guessed cycle onto historic rows would
--   make a schedule that looks derived from data when it was derived from an
--   assumption.
--
-- HOW TO VERIFY (SEPARATE run from the DDL — AGENTS.md §5):
--
--   select billing_cycle, term_months, count(*)
--     from public.subscriptions group by 1, 2 order by 1, 2;
--   -- expect every existing row at ('yearly', 12)
--
--   select count(*) from public.subscriptions where parent_subscription_id is not null;
--   -- expect 0

begin;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'billing_cycle') then
    create type public.billing_cycle as enum ('monthly', 'quarterly', 'half_yearly', 'yearly');
  end if;
end $$;

alter table public.subscriptions
  add column if not exists billing_cycle          public.billing_cycle not null default 'yearly',
  add column if not exists term_months            integer not null default 12,
  -- uuid, matching subscriptions.id. (quotes.id is text and subscriptions.id is not;
  -- assuming they matched is what the first attempt at this migration got wrong.)
  add column if not exists parent_subscription_id uuid references public.subscriptions(id) on delete set null;

-- A term of zero or negative months is not a subscription, it is a data error that
-- would divide a schedule by zero.
alter table public.subscriptions
  drop constraint if exists subscriptions_term_months_positive;
alter table public.subscriptions
  add constraint subscriptions_term_months_positive check (term_months > 0);

-- A subscription cannot be its own parent. Deeper cycles are not prevented here —
-- a check constraint cannot walk a chain — but co-terming is one level by design and
-- the self-reference is the case that actually happens by accident.
alter table public.subscriptions
  drop constraint if exists subscriptions_no_self_parent;
alter table public.subscriptions
  add constraint subscriptions_no_self_parent check (parent_subscription_id is distinct from id);

comment on column public.subscriptions.billing_cycle is
  'How often this subscription is INVOICED. Distinct from a quote line''s commitment, which is the price tier. Previously lived only on quotes, so nothing downstream could answer it once the quote was superseded.';
comment on column public.subscriptions.term_months is
  'Length of the committed term. 12 = annual, 36 = a three-year deal. renewal_date says when the term ends; this says how long it is — a schedule needs both, and deriving one from the other assumes 12.';
comment on column public.subscriptions.parent_subscription_id is
  'The main plan this add-on is co-termed to. A relationship, not a copied date: copying the parent''s anniversary drifts the moment the parent''s renewal moves. ON DELETE SET NULL so removing a main plan never deletes an add-on the customer still uses.';

create index if not exists subscriptions_parent_idx
  on public.subscriptions (parent_subscription_id)
  where parent_subscription_id is not null;

commit;
