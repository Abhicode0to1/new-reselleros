-- Phase 1 of docs/AI-CATEGORISATION-PLAN.md — the column and the rules table. No AI.
--
-- WHAT WAS MISSING. api/ai/extract-statement already reads a bank statement with Gemini
-- vision and returns the rows; the import dialog already previews them. The one step
-- nobody had was naming what each row IS. `bank_transactions` has no category column, and
-- extract-statement contains the word "categor" zero times.
--
-- NOT THE SAME AS RECONCILIATION. The table already carries matched_to_type /
-- matched_to_id / match_confidence, which ties a line to a record that ALREADY EXISTS (a
-- payment, an expense, a salary). Categorising is the other case: a line with nothing to
-- tie to, which still has to land somewhere in the books. Both are needed and this sits
-- beside the matcher rather than replacing it — reconciliation should always win first,
-- because a line that matches a real row does not need a guess, it needs a link.
--
-- WHY RULES BEFORE A MODEL. Measured on the live books, 22 Aug 2026: 35 categorised
-- expenses across 8 categories, and Salaries is 22 of the 35 — about four examples per
-- category with a tail of one. That is not enough to train anything, so the deterministic
-- layer is not a stopgap until a clever version lands; it IS the mechanism. And it works,
-- because the answer is written in the narration:
--
--   IMPS-621856395591-PARDEEP SHARMA-ICIC-XX XXXXXX4658-SALARY   -> Salaries
--   DHDF23P1QTMPV7/BILLDKPLAYSTOREGOOGL                          -> Software
--   K4UHU5ENAJ52FPOTCU/PAYUFACEBOOK                              -> Marketing
--
-- CONTAINS ONLY — a deliberate departure from the plan written an hour earlier, which said
-- `contains | regex`. Dropped, for two reasons: every narration measured is a plain
-- substring, and a regex authored in a UI is a denial-of-service waiting to happen
-- (catastrophic backtracking on a statement import). A match_type column can be added the
-- day a real case needs one; shipping the footgun first cannot be undone.
--
-- NOTHING IS AUTO-POSTED by this migration or the code that reads it. Categorisation feeds
-- P&L and GST input credit, so it takes the same posture every AI route in this repo
-- already takes: suggest, operator confirms, then write.

begin;

-- ── 1. Where the answer lands ────────────────────────────────────────────────
alter table public.bank_transactions
  add column if not exists category            text,
  add column if not exists category_source     text,
  add column if not exists category_confidence integer;

-- The vocabulary lives in the DATABASE, not only in TypeScript. On 21 Aug a reminder table
-- accepted 'checkin' while the app's type had always said 'check_in', and the compiler
-- caught it only because the two happened to meet. A check constraint means they cannot
-- drift in the first place.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bank_txn_category_source_vocab') then
    alter table public.bank_transactions
      add constraint bank_txn_category_source_vocab
      check (category_source is null or category_source in ('rule', 'ai', 'manual'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'bank_txn_category_confidence_range') then
    alter table public.bank_transactions
      add constraint bank_txn_category_confidence_range
      check (category_confidence is null or category_confidence between 0 and 100);
  end if;

  -- A category with no stated source is an unattributable number in the books: nobody can
  -- tell a rule hit from a machine guess from a human decision, which is exactly what an
  -- auditor asks. Either both are set or neither is.
  if not exists (select 1 from pg_constraint where conname = 'bank_txn_category_needs_source') then
    alter table public.bank_transactions
      add constraint bank_txn_category_needs_source
      check ((category is null) = (category_source is null));
  end if;
end $$;

comment on column public.bank_transactions.category is
  'Expense/income category for a line that has nothing to reconcile against. Never auto-posted — set only after an operator confirms. See docs/AI-CATEGORISATION-PLAN.md.';
comment on column public.bank_transactions.category_source is
  'rule | ai | manual. Which layer decided, so a rule hit is never mistaken for a guess.';

create index if not exists idx_bank_txn_tenant_category
  on public.bank_transactions (tenant_id, category);

-- Finding the work: the lines still needing a category. Partial, because that set shrinks
-- to nothing and an index over the whole table would be mostly dead weight.
create index if not exists idx_bank_txn_uncategorised
  on public.bank_transactions (tenant_id, txn_date)
  where category is null;

-- ── 2. The rules ─────────────────────────────────────────────────────────────
create table if not exists public.txn_category_rules (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  -- Matched case-insensitively as a SUBSTRING of the narration.
  pattern             text not null,
  category            text not null,
  -- 'debit' | 'credit' | 'any'. A correctness guard, not a nicety: "SALARY" on a CREDIT is
  -- money coming IN — a refund or reversal — and filing it under Salaries overstates the
  -- wage bill. A direction-blind rule would do exactly that.
  direction           text not null default 'any',
  hit_count           integer not null default 0,
  -- Which transaction taught us this, when a rule is born from an operator correction
  -- (Phase 4). Set null rather than cascading: losing the rule because its example row was
  -- deleted would silently un-learn something the operator had taught the system.
  created_from_txn_id uuid references public.bank_transactions(id) on delete set null,
  created_by          uuid references public.users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint txn_rule_direction_vocab check (direction in ('debit', 'credit', 'any')),
  -- A blank pattern matches EVERY line. It is the cheapest bug to create from a UI and the
  -- most expensive to notice, so the row cannot exist. The TypeScript module guards this
  -- too; that is deliberate belt-and-braces, not duplication — the constraint stops it
  -- being stored, the module stops an already-stored one from doing damage.
  constraint txn_rule_pattern_not_blank check (length(trim(pattern)) > 0),
  constraint txn_rule_category_not_blank check (length(trim(category)) > 0)
);

-- One answer per pattern per direction. Two rules saying the same narration is two
-- different categories is a contradiction, not a preference, so the operator is made to
-- edit the existing rule instead of stacking a second one behind it.
create unique index if not exists idx_txn_rule_unique_pattern
  on public.txn_category_rules (tenant_id, upper(trim(pattern)), direction);

create index if not exists idx_txn_rule_tenant on public.txn_category_rules (tenant_id);

drop trigger if exists trg_txn_category_rules_updated_at on public.txn_category_rules;
create trigger trg_txn_category_rules_updated_at
  before update on public.txn_category_rules
  for each row execute function public.handle_updated_at();

-- ── 3. RLS — tenant-scoped, like every other table (CLAUDE.md §4) ────────────
alter table public.txn_category_rules enable row level security;

drop policy if exists txn_category_rules_tenant_read   on public.txn_category_rules;
drop policy if exists txn_category_rules_tenant_write  on public.txn_category_rules;
drop policy if exists txn_category_rules_tenant_update on public.txn_category_rules;
drop policy if exists txn_category_rules_tenant_delete on public.txn_category_rules;

create policy txn_category_rules_tenant_read on public.txn_category_rules
  for select using (tenant_id = public.current_tenant_id());

create policy txn_category_rules_tenant_write on public.txn_category_rules
  for insert with check (tenant_id = public.current_tenant_id());

create policy txn_category_rules_tenant_update on public.txn_category_rules
  for update using (tenant_id = public.current_tenant_id())
          with check (tenant_id = public.current_tenant_id());

create policy txn_category_rules_tenant_delete on public.txn_category_rules
  for delete using (tenant_id = public.current_tenant_id());

commit;
