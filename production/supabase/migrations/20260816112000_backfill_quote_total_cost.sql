-- 20260816112000_backfill_quote_total_cost
--
-- WHAT THIS FIXES
--   `quotes.total_cost` was left at 0 on quotes created by the Subscription Onboarding
--   dialog, which inserted `subtotal` but no `total_cost`. The line items on those rows
--   carry the real cost, so the column and the JSON disagreed — and every margin figure
--   read off the column reported 100% on a deal that was making 17.5%.
--
--   Found on Q-2026-9778: total_cost = 0, line_items = [{qty:10, cost:1980, rate:2400}].
--   The quotes list showed "Pipeline Margin ₹0" and the detail page showed
--   "100% est. margin" for the same quote, from the same wrong column.
--
-- WHY THE APP NO LONGER DEPENDS ON THIS COLUMN
--   The fix that matters is in the app: /quotes and /quotes/[id] now compute margin from
--   `line_items`, which is the per-product record and cannot fall out of step with
--   itself. This backfill is for anything that reads the column later — reports, exports,
--   a future RPC — so a stored money value is not left knowingly wrong.
--
-- WHY ONLY ROWS WHERE THE COLUMN IS ZERO AND THE LINES ARE NOT
--   A genuinely zero-cost quote (a free trial, a giveaway) is a real thing and must not
--   be rewritten. Only rows where the lines prove a cost exists are touched.
--
-- HOW TO VERIFY (SEPARATE run from the DDL — AGENTS.md §5):
--
--   select id, total_cost,
--          (select sum((l->>'qty')::numeric * (l->>'cost')::numeric)
--             from jsonb_array_elements(line_items) l) as from_lines
--     from public.quotes
--    where jsonb_array_length(line_items) > 0;
--   -- expect total_cost = from_lines on every row, or total_cost still 0 where the
--   -- lines genuinely sum to 0

begin;

update public.quotes q
   set total_cost = sub.line_cost
  from (
    select id,
           coalesce((
             select sum((l->>'qty')::numeric * (l->>'cost')::numeric)
               from jsonb_array_elements(line_items) l
           ), 0)::integer as line_cost
      from public.quotes
     where jsonb_typeof(line_items) = 'array'
       and jsonb_array_length(line_items) > 0
  ) sub
 where q.id = sub.id
   and coalesce(q.total_cost, 0) = 0
   and sub.line_cost > 0;

commit;
