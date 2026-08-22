-- create_project_direct_invoice: qualify `project_id`, which collides with the function's
-- own OUT column and makes every call fail.
--
-- ─── THE DEFECT ─────────────────────────────────────────────────────────────
-- The function is declared `RETURNS TABLE(invoice_id text, project_id uuid)`, so inside the
-- body `project_id` is a PL/pgSQL variable. This line therefore cannot be planned:
--
--     select id into v_msid from public.project_milestones where project_id = v_pid ...
--
--     ERROR 42702: column reference "project_id" is ambiguous
--     DETAIL:  It could refer to either a PL/pgSQL variable or a table column.
--
-- It aborts on every call, after `create_project_quote` and `accept_project_quote` have
-- already run — so the whole composed operation rolls back and the caller gets an error that
-- names neither the project nor the milestone.
--
-- ─── HOW LONG, AND HOW WE KNOW ──────────────────────────────────────────────
-- `project_sales` has **0 rows** and `project_milestones` has **0 rows** in the live
-- database, which is what you would expect of a path that has never once completed. The UI
-- has been wired to it the whole time: `create-project-quote-dialog.tsx:46` calls
-- `useCreateProjectDirectInvoice()`, which calls this RPC.
--
-- It went unnoticed because `supabase/tests/create_project_direct_invoice.test.sql` — the
-- one file that exercises it — had itself stopped running: it borrowed a live customer id
-- that was later deleted, and before that it asserted nothing anyway (AGENTS.md L11).
-- Rewriting that test on 22 Aug 2026 is what surfaced this.
--
-- ─── SCOPE ──────────────────────────────────────────────────────────────────
-- One line changes: the table gets an alias and both columns are qualified. Nothing else in
-- the body differs from `pg_get_functiondef` — hand-writing a replacement body is how three
-- guards were lost from record_payment (AGENTS.md L9).
--
-- Safe to apply: it turns a function that always throws into one that can succeed. There is
-- no existing data to migrate, because nothing has ever been created through it.
--
--     cd production
--     node scripts/apply-migration.mjs supabase/migrations/20260822200000_fix_project_direct_invoice_ambiguous_column.sql
--
-- Then verify in a SEPARATE run (§5 — a check inside the same transaction reports success
-- for a change that is about to disappear):
--
--     env -u SUPABASE_ACCESS_TOKEN npx supabase db query --linked \
--       -f supabase/tests/create_project_direct_invoice.test.sql
--
-- That test asserts the GST split (200000 + 36000 = 236000), status pending, the project
-- reaching 'active', and exactly one invoice per project sale.

begin;

create or replace function public.create_project_direct_invoice(
  p_customer_id uuid, p_customer_name text, p_title text, p_description text,
  p_line_items jsonb, p_gst_rate integer, p_inter_state boolean)
 returns table(invoice_id text, project_id uuid)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_lines   jsonb;
  v_taxable integer := 0;
  v_gst     integer;
  v_total   integer;
  v_pid     uuid;
  v_msid    uuid;
  v_inv     text;
begin
  if jsonb_typeof(p_line_items) <> 'array' or jsonb_array_length(p_line_items) = 0 then
    raise exception 'At least one line item is required';
  end if;

  select coalesce(jsonb_agg(
           li || jsonb_build_object('amount',
             coalesce(nullif((li->>'amount'), '')::int,
                      coalesce((li->>'qty')::int, 1) * coalesce((li->>'rate')::int, 0)))
         ), '[]'::jsonb)
    into v_lines from jsonb_array_elements(p_line_items) li;

  select coalesce(sum(greatest(coalesce((li->>'amount')::int, 0), 0)), 0)
    into v_taxable from jsonb_array_elements(v_lines) li;
  if v_taxable <= 0 then raise exception 'Invoice total must be greater than zero'; end if;
  v_gst   := round(v_taxable * coalesce(p_gst_rate, 18) / 100.0);
  v_total := v_taxable + v_gst;

  v_pid := public.create_project_quote(
    p_customer_id, p_customer_name, p_title, p_description, v_lines,
    coalesce(p_gst_rate, 18), coalesce(p_inter_state, false),
    jsonb_build_array(jsonb_build_object('label', 'Full amount', 'total_amount', v_total, 'due_date', current_date::text))
  );

  perform public.accept_project_quote(v_pid);

  -- THE ONE CHANGE: `pm` alias so `pm.project_id` is unmistakably the column, not this
  -- function's OUT variable of the same name.
  select pm.id into v_msid
    from public.project_milestones pm
   where pm.project_id = v_pid
   order by pm.seq
   limit 1;
  if v_msid is null then raise exception 'Milestone was not created for project %', v_pid; end if;

  v_inv := public.raise_project_milestone_invoice(v_msid);

  return query select v_inv, v_pid;
end;
$function$;

comment on function public.create_project_direct_invoice(uuid, text, text, text, jsonb, integer, boolean) is
  'Creates a project sale, accepts it, and raises the single full-amount milestone invoice, '
  'atomically. Until 22 Aug 2026 every call failed on an ambiguous `project_id` — the OUT '
  'column shadowed project_milestones.project_id — so project_sales had 0 rows despite the '
  'UI being wired to it since 0160.';

commit;
