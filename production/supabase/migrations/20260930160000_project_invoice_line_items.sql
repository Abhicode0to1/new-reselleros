-- 20260930160000_project_invoice_line_items  (R-010)
--
-- WHAT WAS WRONG
--   A project-milestone tax invoice printed no particulars at all. The dialog and the PDF
--   both rendered "No line items recorded on the parent quote." over a correct
--   ₹5,00,000 + CGST ₹45,000 + SGST ₹45,000: right money, and a document that does not
--   say what was sold.
--
--   CGST Rule 46(g) requires a description of the service on a tax invoice, and 46(f) its
--   HSN/SAC. Without them the invoice is defective — the buyer's input credit is what is
--   actually at risk, not ours.
--
--   Two causes, and only one of them was visible from the screen:
--     1. raise_project_milestone_invoice never wrote `invoices.line_items`. Of the three
--        functions in this database that insert an invoice, raise_subscription_billing
--        writes lines and this one does not.
--     2. The invoice detail screen read `quote?.line_items ?? []`, and a project invoice
--        HAS no quote — it is raised from a milestone. So even a filled column would not
--        have been shown. That half is in the same commit as this file.
--
-- WHAT GOES ON THE LINE
--   One line, qty 1, rate = the milestone's taxable value. Deliberately not a per-unit
--   breakdown: a tax invoice whose qty × rate does not equal its amount is wrong on its
--   face, and raise_subscription_billing already states that rule beside its own single
--   line. The parts therefore sum to `taxable_value` by construction.
--
--   The SAC is NOT a literal. `project_sales.sac_code` already exists, is NOT NULL and
--   already defaults to '998314' — the code R-010 asks for — so the project's own
--   declared SAC goes on its invoice and a project sold under a different code carries
--   that code instead. (998314 is IT design and development services; 998313, the SaaS
--   default in lib/gst/hsn.ts, is IT consulting and support. A development project is not
--   a SaaS subscription and must not inherit its code.)
--
--   The project's `description` — the operator's own words about the work — goes in the
--   line's description. It costs nothing here and it is the part Rule 46(g) is actually
--   about.
--
-- THE BACKFILL
--   Invoices already raised hold NULL, so they would keep printing nothing. The freeze
--   trigger permits exactly this: `line_items` sits in its ONCE-SET tier, whose own
--   comment says "a backfill completes the record rather than amending it" — null may be
--   filled, a value may not be replaced. No escape hatch is needed and none is used, and
--   no amount is touched: the rate is read from the invoice's own frozen `taxable_value`,
--   not recomputed.
--
-- GUARD CARRIED FORWARD, NOT REWRITTEN
--   This recreates a SECURITY DEFINER function that migration 20260927100000 hardened, so
--   the hardened tenant guard is copied through verbatim. `create or replace` keeps the
--   existing grants, so none are restated — a `drop` here would reset them to the PUBLIC
--   default, which is how anon got back onto next_document_number once already (C-054).
--
-- HOW TO VERIFY (a SEPARATE run from the DDL — AGENTS.md §5):
--   select id, jsonb_array_length(line_items) from public.invoices
--    where id in (select invoice_id from public.project_milestones where invoice_id is not null);
--   -- expect 1 for every row, and none null

begin;

create or replace function public.raise_project_milestone_invoice(p_milestone_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_ms       record;
  v_proj     record;
  v_id       text;
  v_paid     integer;
  v_full     boolean;
  v_pay_date date;
  v_inv_date date;
  v_rate     integer;
  v_taxable  integer;
  v_tax      integer;
  v_lines    jsonb;
begin
  select * into v_ms from public.project_milestones where id = p_milestone_id for update;
  if not found then raise exception 'Milestone not found'; end if;
  /* R-013 (Pardeep, 27 Sep 2026): the hardened form. The old guard opened by testing
     that the tenant was NOT null and only then comparing — so a NULL tenant skipped the
     comparison entirely, which is the anon case and the signed-in-but-no-users-row case,
     and quote/invoice ids are countable. Migration 20260927100000 rewrote 17 definer RPCs
     by regex; this file recreates one of them, so it must carry the hardened shape
     forward or it silently undoes that fix.

     The old wording is deliberately NOT quoted here. `definer_rpc_hardening.test.sql`
     FAIL 4 scans `pg_get_functiondef`, which includes COMMENTS — so writing the phrase in
     prose turns that security test red for no reason (AGENTS.md L46). Verified: quoting it
     did exactly that. */
  if (v_tenant is null and coalesce(auth.role(), '') in ('anon', 'authenticated'))
     or (v_tenant is not null and v_ms.tenant_id is distinct from v_tenant) then
    raise exception 'Milestone not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  if v_ms.invoice_id is not null then
    raise exception 'Invoice % already raised for this milestone', v_ms.invoice_id
      using errcode = 'unique_violation';
  end if;

  select * into v_proj from public.project_sales where id = v_ms.project_id;

  select coalesce(sum(amount), 0), min(received_at)
    into v_paid, v_pay_date
    from public.project_payments where milestone_id = p_milestone_id;
  v_full := v_paid >= v_ms.total_amount;

  -- R-003. Was: the first payment's date when fully paid. The number is allocated
  -- below, from today's series, so any earlier date puts the two out of step.
  v_inv_date := public.ist_today();

  v_rate    := coalesce(v_proj.gst_rate, 18);
  v_taxable := round(v_ms.total_amount * 100.0 / (100 + v_rate));
  v_tax     := v_ms.total_amount - v_taxable;

  /* R-010. ONE line, qty 1, rate = this milestone's taxable value — so qty × rate is the
     amount and the document cannot contradict itself. The SAC comes from the project, not
     from a literal: `project_sales.sac_code` is NOT NULL and defaults to 998314. */
  v_lines := jsonb_build_array(jsonb_build_object(
    'id',          'milestone-' || v_ms.seq::text,
    'name',        coalesce(nullif(btrim(v_proj.title), ''), 'Project services')
                   || ' — '
                   || coalesce(nullif(btrim(v_ms.label), ''), 'Milestone ' || v_ms.seq::text),
    'description', nullif(btrim(coalesce(v_proj.description, '')), ''),
    'qty',         1,
    'rate',        v_taxable,
    'cost',        0,
    'hsn',         v_proj.sac_code
  ));

  v_id := public.next_document_number('invoice', v_ms.tenant_id, public.ist_today());
  if v_id is null then raise exception 'Could not allocate invoice number'; end if;

  insert into public.invoices
    (id, tenant_id, customer_id, customer_name, amount, status,
     invoice_date, due_date, paid_date, adjusted_advances, net_payable, quote_id,
     taxable_value, tax_amount, tax_rate, inter_state, line_items)
  values
    (v_id, v_ms.tenant_id, v_proj.customer_id, v_proj.customer_name, v_ms.total_amount,
     (case when v_full then 'paid' else 'pending' end)::invoice_status,
     v_inv_date, greatest(coalesce(v_ms.due_date, v_inv_date), v_inv_date),
     -- The money's own date, not the document's. An advance really did arrive then.
     case when v_full then v_pay_date else null end,
     '[]'::jsonb,
     case when v_full then 0 else v_ms.total_amount end,
     null,
     v_taxable, v_tax, v_rate, coalesce(v_proj.inter_state, false), v_lines);

  update public.project_milestones
     set invoice_id = v_id,
         status     = case when v_full then 'paid' else 'invoiced' end
   where id = p_milestone_id;

  return v_id;
end;
$function$;

comment on function public.raise_project_milestone_invoice(uuid) is
  'Raises the tax invoice for one project milestone. Writes a single line item (qty 1, rate = the milestone''s taxable value, SAC from project_sales.sac_code) because CGST Rule 46 requires a description and an HSN/SAC on a tax invoice, and this path used to write none.';

-- ── Backfill: invoices already raised from a milestone ──────────────────────
-- Idempotent by the `line_items is null` filter, and the freeze trigger's ONCE-SET rule
-- allows null -> value while refusing value -> a different value. Amounts are read from
-- the invoice, never recomputed.
update public.invoices i
   set line_items = jsonb_build_array(jsonb_build_object(
         'id',          'milestone-' || m.seq::text,
         'name',        coalesce(nullif(btrim(p.title), ''), 'Project services')
                        || ' — '
                        || coalesce(nullif(btrim(m.label), ''), 'Milestone ' || m.seq::text),
         'description', nullif(btrim(coalesce(p.description, '')), ''),
         'qty',         1,
         'rate',        coalesce(i.taxable_value,
                                 round(i.amount * 100.0 / (100 + coalesce(i.tax_rate, 18)))),
         'cost',        0,
         'hsn',         p.sac_code
       ))
  from public.project_milestones m
  join public.project_sales p on p.id = m.project_id
 where m.invoice_id = i.id
   and i.line_items is null;

commit;
