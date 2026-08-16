-- 20260816110500_add_quote_approval
--
-- WHAT THIS CHANGES
--   Adds the discount/margin approval state to `quotes`:
--     approval_status            not_required | pending | approved | rejected
--     approval_tier              manager | owner   (which sign-off is needed)
--     approval_requested_by/_at  who asked, when
--     approved_by/_at            who cleared it, when
--     approved_discount_bps      the discount that was ACTUALLY signed off
--     approved_margin_bps        the margin that was ACTUALLY signed off
--     approval_rejection_reason  why, in the approver's words
--
-- WHY THE APPROVED NUMBERS ARE STORED AND NOT JUST A BOOLEAN
--   This is the point of the whole migration. A quote approved at a 15% discount and
--   then edited to 40% must not still read "Approved" — but with only a status flag
--   there is nothing to compare against, so the edit is invisible and the approval
--   silently covers a deal nobody agreed to. Storing the signed-off numbers lets
--   `isStale()` in lib/quotes/approval.ts say "this was cleared at different figures".
--
--   Basis points, not percentages: 12% is 1200. An integer percentage column would make
--   10.4% and 10.0% the same number, and one of those is over the auto-approve line.
--
-- WHY approval_requested_by IS SEPARATE FROM quotes.owner_id
--   owner_id is who the quote belongs to; requested_by is who pushed it into the queue.
--   They are usually the same person and occasionally are not (a manager tidying up a
--   rep's quote). The self-approval rule keys on requested_by, so conflating the two
--   would let a manager approve a quote they submitted on someone else's behalf.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   No trigger recomputes the tier in Postgres. The matrix lives in one place —
--   lib/quotes/approval.ts — because a second copy in PL/pgSQL is a second set of
--   thresholds to keep in step, and this codebase has already been bitten three times
--   by the same rule written twice (three product price lists, two UserRole unions, a
--   CLAUDE.md that contradicted the schema on paise). These columns record decisions;
--   they do not re-derive them.
--
--   Existing rows are left at 'not_required'. Back-dating an approval state onto quotes
--   that were sent before this rule existed would invent a sign-off that never happened.
--
-- HOW TO VERIFY (SEPARATE run from the DDL — AGENTS.md §5):
--
--   select approval_status, count(*) from public.quotes group by 1;
--   -- expect every existing row in 'not_required'
--
--   select column_name, data_type from information_schema.columns
--    where table_schema='public' and table_name='quotes' and column_name like 'appro%'
--    order by 1;
--   -- expect 9 rows

begin;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'quote_approval_status') then
    create type public.quote_approval_status as enum ('not_required', 'pending', 'approved', 'rejected');
  end if;
  if not exists (select 1 from pg_type where typname = 'quote_approval_tier') then
    create type public.quote_approval_tier as enum ('manager', 'owner');
  end if;
end $$;

alter table public.quotes
  add column if not exists approval_status           public.quote_approval_status not null default 'not_required',
  add column if not exists approval_tier             public.quote_approval_tier,
  add column if not exists approval_requested_by     uuid references public.users(id) on delete set null,
  add column if not exists approval_requested_at     timestamptz,
  add column if not exists approved_by               uuid references public.users(id) on delete set null,
  add column if not exists approved_at               timestamptz,
  add column if not exists approved_discount_bps     integer,
  add column if not exists approved_margin_bps       integer,
  add column if not exists approval_rejection_reason text;

comment on column public.quotes.approved_discount_bps is
  'Discount in BASIS POINTS that was actually signed off (1500 = 15%). Compared against the quote''s current discount so an edit after approval does not silently stay approved. Nullable: no approval yet.';
comment on column public.quotes.approved_margin_bps is
  'Gross margin in BASIS POINTS that was actually signed off. Null also means "margin was unknown at approval time" — see lib/quotes/approval.ts.';
comment on column public.quotes.approval_requested_by is
  'Who put this in the approvals queue. Separate from owner_id on purpose: the self-approval rule keys on THIS column, so a manager submitting on a rep''s behalf still cannot clear it themselves.';

-- The approvals queue reads "everything waiting in my tenant", so the index leads with
-- tenant_id and status. Partial, because approved and not_required rows are the vast
-- majority and are never queried this way.
create index if not exists quotes_approval_pending_idx
  on public.quotes (tenant_id, approval_requested_at)
  where approval_status = 'pending';

commit;
