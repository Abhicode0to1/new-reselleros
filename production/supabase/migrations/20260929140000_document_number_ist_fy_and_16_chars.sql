-- 20260929140000_document_number_ist_fy_and_16_chars.sql
--
-- R-015, parts 1 and 2 (Pardeep, 29 Sep 2026). Part 3 (partial payments) is its own
-- migration — it lives inside record_payment and does not belong in this one.
--
-- ══ 1. THE FINANCIAL YEAR CAME FROM THE CLOCK, AND THE CLOCK IS IN UTC ══════════
--
-- `next_document_number` called `indian_fiscal_year()` with no argument, so the series a
-- document lands in was decided by `current_date` — and this database runs in UTC
-- (verified: `show timezone` → UTC). IST is UTC+5:30, so between 00:00 and 05:30 IST
-- `current_date` is YESTERDAY.
--
-- On the one night of the year when that matters, 1 April, an invoice raised at 02:00 IST
-- is stamped 31 March and takes a number from the CLOSING year's series. The document,
-- the number and the GSTR-1 month all move together into a year that ended two hours
-- earlier. It is the same defect as R-025 one layer down, in SQL rather than TypeScript,
-- and it is reachable by anybody working early on the first day of the year — which,
-- being the first day of the year, is a day people work early.
--
-- Every GST document creator had the same `current_date`, so `invoice_date` was wrong in
-- the same window as the number. Both are fixed here, together, because fixing one alone
-- makes the document disagree with its own number — which is worse than either.
--
-- The card asked for `next_document_number(..., p_on date default current_date)` so a
-- caller can back-date. That parameter is here. But note what the audit found: no path in
-- this codebase can back-date an invoice today — every creator dates the document
-- `current_date` in the same statement that allocates the number. So the card's example
-- ("raise a 28 March invoice in April") is not currently reachable, and the live bug is
-- the IST one above. The parameter is still worth having: `invoices.invoice_date` is
-- plain and insertable, and the day a back-dating feature arrives this is the seam it
-- needs.
--
-- ══ 2. THE NUMBER WAS 21 CHARACTERS AND CGST RULE 46(b) ALLOWS 16 ═══════════════
--
--   INV-ADPL-2026-27-0002    21   ← what this app issued
--   INV-ADPL-27-0002         16   ← what it issues now
--
-- The financial year is carried by its END year, which is unambiguous and monotonic:
-- FY26-27 → "27", FY27-28 → "28". The counter still resets per financial year in
-- `document_series`, so nothing about uniqueness changes.
--
-- **The tenant code STAYS**, and that is a correction to the card, which offered
-- "tenant code hatao" as one option. `invoices.id` is a bare global PRIMARY KEY, not
-- per-tenant — drop the code and the second tenant to issue its first invoice of a year
-- collides with the first tenant's, as a primary-key violation at the moment of issue.
-- The code is what keeps the series global-unique, so the length had to come from the
-- year instead.
--
-- The code is capped at 4 characters here for the same reason: nothing has ever
-- constrained `tenants.doc_code`, and a 6-character one would put the number back over
-- 16 with no warning. 4 is what the uuid fallback already produces, so this changes
-- nothing for any tenant that has not set an unusually long code.
--
-- Old numbers are untouched. A tenant mid-year simply sees the shape change at the next
-- document; the counter continues, so no number is skipped and none is reused. Both
-- shapes carry the tenant code and the year, so neither can collide with the other.

begin;

-- ── The IST helper the rest of this file leans on ────────────────────────────────────

create or replace function public.ist_today()
returns date
language sql
stable
as $function$
  /* STABLE, not IMMUTABLE: it reads the clock. Stable is what makes it safe to call
     twice in one statement — both calls see the same snapshot, so a number and the
     document it is stamped on can never land on different days. */
  select (now() at time zone 'Asia/Kolkata')::date;
$function$;

comment on function public.ist_today() is
  'Today in IST. `current_date` is the SERVER date and this server is UTC, so between '
  '00:00 and 05:30 IST it is yesterday — which on 1 April puts a document in the closing '
  'financial year. R-015 / AGENTS.md §6.';

-- ── The financial year now defaults to the IST day, not the UTC one ─────────────────

create or replace function public.indian_fiscal_year(p_date date default public.ist_today())
returns text
language sql
stable
as $function$
  select case
    when extract(month from p_date) >= 4
      then 'FY' || to_char(p_date, 'YY') || to_char(p_date + interval '1 year', 'YY')
    else 'FY' || to_char(p_date - interval '1 year', 'YY') || to_char(p_date, 'YY')
  end;
$function$;

comment on function public.indian_fiscal_year(date) is
  'Indian FY label for a date. The DEFAULT is IST today, not current_date — see '
  'public.ist_today(). No longer IMMUTABLE, because its default reads the clock; callers '
  'that pass an explicit date are unaffected. R-015.';

-- ── 16 characters ───────────────────────────────────────────────────────────────────

create or replace function public.format_document_number(p_prefix text, p_fiscal_year text, p_number integer)
returns text
language sql
immutable
as $function$
  /* <PREFIX>-<CODE>-<YY>-<NNNN>, where p_prefix already carries "INV-ADPL".
     3 + 1 + 4 + 1 + 2 + 1 + 4 = 16 for the longest GST prefix (INV, RFV).
     Was '-20' || start-year || '-' || end-year, which added five characters and put the
     number at 21 — over the CGST Rule 46(b) limit. */
  select p_prefix || '-' || substring(p_fiscal_year from 5 for 2)
       || '-' || lpad(p_number::text, 4, '0');
$function$;

comment on function public.format_document_number(text, text, integer) is
  'Document number shape, <= 16 characters (CGST Rule 46(b)). The FY is carried by its '
  'END year: FY2627 -> 27. R-015.';

-- ── The allocator, now taking the document''s own date ───────────────────────────────
--
-- Dropped and recreated rather than replaced: adding a third parameter with a default
-- alongside the existing two-argument function would leave BOTH resolvable for a
-- two-argument call, and Postgres answers that with "function is not unique" at every
-- call site rather than choosing. The grants are restored below, from the ones the old
-- function actually held (read off pg_proc.proacl, not information_schema — AGENTS.md §5).

drop function if exists public.next_document_number(text, uuid);

create or replace function public.next_document_number(
  p_doc_type  text,
  p_tenant_id uuid default null,
  p_on        date default null
)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller      uuid := public.current_tenant_id();
  v_tenant_id   uuid;
  v_on          date := coalesce(p_on, public.ist_today());
  v_fy          text;
  v_prefix      text;
  v_code        text;
  v_next_number integer;
begin
  if v_caller is not null then
    if p_tenant_id is not null and p_tenant_id <> v_caller then
      raise exception 'Cannot allocate a document number for another tenant'
        using errcode = 'insufficient_privilege';
    end if;
    v_tenant_id := v_caller;
  else
    v_tenant_id := p_tenant_id;
  end if;

  if v_tenant_id is null then
    raise exception 'No tenant context — next_document_number requires authenticated session or explicit tenant_id';
  end if;

  if p_doc_type not in ('invoice','receipt_voucher','refund_voucher','credit_note','debit_note','quote','purchase_order','campaign') then
    raise exception 'Invalid doc_type: %', p_doc_type;
  end if;

  /* R-015: from the DOCUMENT's date, not the clock. A document dated in one financial
     year must not take its number from another's series — that is what a GSTR-1 return
     is reconciled against. */
  v_fy     := public.indian_fiscal_year(v_on);
  v_prefix := public.default_doc_prefix(p_doc_type);

  select doc_code into v_code from public.tenants where id = v_tenant_id;
  v_code := coalesce(nullif(trim(v_code), ''), upper(substring(replace(v_tenant_id::text, '-', '') from 1 for 4)));
  /* Capped at 4 (R-015). Nothing has ever constrained tenants.doc_code, and a longer one
     would silently push the number back over the Rule 46(b) 16-character limit. 4 is what
     the uuid fallback on the line above already produces. */
  v_code := substring(v_code from 1 for 4);

  insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values (v_tenant_id, p_doc_type, v_fy, v_prefix, 1)
  on conflict (tenant_id, doc_type, fiscal_year)
  do update set
    last_number = document_series.last_number + 1,
    updated_at  = now()
  returning last_number into v_next_number;

  return public.format_document_number(v_prefix || '-' || v_code, v_fy, v_next_number);
end;
$function$;

comment on function public.next_document_number(text, uuid, date) is
  'Allocates the next gapless document number. p_on is the DOCUMENT''s date and decides '
  'which financial year series it comes from; null means IST today. R-015 / §17a.';

revoke all on function public.next_document_number(text, uuid, date) from public;
grant execute on function public.next_document_number(text, uuid, date)
  to anon, authenticated, service_role;

-- ══ 3. THE SIX GST DOCUMENT CREATORS ══════════════════════════════════════════
--
-- Each of these had exactly ONE `current_date` — the document's own date — and each
-- allocated its number with no date at all. Both are corrected together: the date becomes
-- IST, and the same IST date is handed to the allocator, so the document and its number
-- can never disagree about which financial year they are in. `ist_today()` is STABLE, so
-- two calls inside one statement see one snapshot.
--
-- Bodies below are the LIVE definitions read out of this database with
-- pg_get_functiondef (AGENTS.md L8/L9 — the migration history has drifted from them),
-- with that single substitution applied. Nothing else in them is touched.
--
-- record_payment and refund_payment also allocate numbers (receipt and refund vouchers).
-- They are deliberately NOT in this migration: a receipt voucher is dated when the money
-- is received, which is a different question, and record_payment is the 26,000-character
-- centre of the money spine. It is handled on its own, with the whole SQL suite run
-- against it (AGENTS.md L9, L36).

-- ── generate_invoice: 1 current_date -> ist_today(), 1 allocator call(s) now dated ──
CREATE OR REPLACE FUNCTION public.generate_invoice(p_quote_id text)
 RETURNS TABLE(invoice_id text, net_payable integer, total_advances integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_quote     record;
  v_adv       jsonb;
  v_total     integer;
  v_first     timestamptz;
  v_id        text;
  v_gross     integer;
  v_net       integer;
  v_status    invoice_status;
  v_today     date := public.ist_today();
  v_taxable   integer;
  v_tax       integer;
  v_rate      integer;
  v_cust_st   text;
  v_sell_st   text;
  v_inter     boolean;
begin
  select q.id, q.tenant_id, q.customer_id, q.customer_name, q.amount,
         q.payment_method, q.payment_reference, q.invoice_id,
         q.subtotal, q.discount_pct, q.tax_rate, q.payment_terms_days
    into v_quote
    from public.quotes q
   where q.id = p_quote_id
   for update;

  if not found then
    raise exception 'Quote % not found', p_quote_id using errcode = 'no_data_found';
  end if;

  if public.current_tenant_id() is not null
     and v_quote.tenant_id is distinct from public.current_tenant_id() then
    raise exception 'Quote % is not in the caller''s tenant', p_quote_id
      using errcode = 'insufficient_privilege';
  end if;

  if v_quote.invoice_id is not null then
    raise exception 'Invoice % already exists for quote %', v_quote.invoice_id, p_quote_id
      using errcode = 'unique_violation';
  end if;

  v_gross := coalesce(v_quote.amount, 0);
  if v_gross <= 0 then
    raise exception 'Quote % has no amount — cannot generate a zero-value tax invoice', p_quote_id
      using errcode = 'check_violation';
  end if;

  v_rate := coalesce(v_quote.tax_rate, 18);
  if v_quote.subtotal is not null then
    v_taxable := v_quote.subtotal - round(v_quote.subtotal * coalesce(v_quote.discount_pct, 0) / 100.0);
  else
    v_taxable := round(v_gross * 100.0 / (100 + v_rate));
  end if;
  v_tax := v_gross - v_taxable;

  select state_code into v_cust_st from public.customers where id = v_quote.customer_id;
  select state_code into v_sell_st from public.tenants   where id = v_quote.tenant_id;
  v_inter := (v_cust_st is not null and v_sell_st is not null and v_cust_st <> v_sell_st);

  select a.advances, coalesce(a.total_paid, 0), a.first_at
    into v_adv, v_total, v_first
    from public.compute_advance_adjustment(p_quote_id) a;
  v_adv   := coalesce(v_adv, '[]'::jsonb);
  v_total := coalesce(v_total, 0);

  v_net    := greatest(0, v_gross - v_total);
  v_status := case when v_net = 0 then 'paid' else 'pending' end::invoice_status;

  v_id := public.next_document_number('invoice', v_quote.tenant_id, public.ist_today());
  if v_id is null then
    raise exception 'Could not allocate invoice number for quote %', p_quote_id;
  end if;

  insert into public.invoices (
    id, tenant_id, customer_id, customer_name, amount, status,
    invoice_date, due_date, paid_date, razorpay_id,
    adjusted_advances, net_payable, first_advance_at, quote_id,
    taxable_value, tax_amount, tax_rate, inter_state
  ) values (
    v_id, v_quote.tenant_id, v_quote.customer_id, v_quote.customer_name, v_gross, v_status,
    -- THE ONE CHANGE: the fallback was 0, which made every termless invoice due on issue.
    v_today, v_today + coalesce(v_quote.payment_terms_days, 30), case when v_status = 'paid' then v_today else null end,
    case when v_quote.payment_method = 'razorpay' then v_quote.payment_reference else null end,
    v_adv, v_net, v_first, v_quote.id,
    v_taxable, v_tax, v_rate, v_inter
  );

  update public.quotes
     set payment_status = 'invoiced'::payment_status,
         invoice_id     = v_id
   where id = p_quote_id;

  return query select v_id, v_net, v_total;
end;
$function$;

-- ── raise_project_milestone_invoice: 1 current_date -> ist_today(), 1 allocator call(s) now dated ──
CREATE OR REPLACE FUNCTION public.raise_project_milestone_invoice(p_milestone_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
begin
  select * into v_ms from public.project_milestones where id = p_milestone_id for update;
  if not found then raise exception 'Milestone not found'; end if;
  if v_tenant is not null and v_ms.tenant_id is distinct from v_tenant then
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

  v_id := public.next_document_number('invoice', v_ms.tenant_id, public.ist_today());
  if v_id is null then raise exception 'Could not allocate invoice number'; end if;

  insert into public.invoices
    (id, tenant_id, customer_id, customer_name, amount, status,
     invoice_date, due_date, paid_date, adjusted_advances, net_payable, quote_id,
     taxable_value, tax_amount, tax_rate, inter_state)
  values
    (v_id, v_ms.tenant_id, v_proj.customer_id, v_proj.customer_name, v_ms.total_amount,
     (case when v_full then 'paid' else 'pending' end)::invoice_status,
     v_inv_date, greatest(coalesce(v_ms.due_date, v_inv_date), v_inv_date),
     -- The money's own date, not the document's. An advance really did arrive then.
     case when v_full then v_pay_date else null end,
     '[]'::jsonb,
     case when v_full then 0 else v_ms.total_amount end,
     null,
     v_taxable, v_tax, v_rate, coalesce(v_proj.inter_state, false));

  update public.project_milestones
     set invoice_id = v_id,
         status     = case when v_full then 'paid' else 'invoiced' end
   where id = p_milestone_id;

  return v_id;
end;
$function$;

-- ── raise_subscription_billing: 1 current_date -> ist_today(), 1 allocator call(s) now dated ──
CREATE OR REPLACE FUNCTION public.raise_subscription_billing(p_billing_id uuid)
 RETURNS TABLE(invoice_id text, gross integer, already_raised boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_b        record;
  v_sub      record;
  v_id       text;
  v_gross    integer;
  v_tax      integer;
  v_cust_st  text;
  v_sell_st  text;
  v_inter    boolean;
  v_lines    jsonb;
  v_terms    integer := 0;
  v_today    date := public.ist_today();
  v_existing integer;
  v_received integer := 0;
  v_applied  integer := 0;
  v_credit   integer := 0;
  v_status   invoice_status;
begin
  select b.* into v_b
    from public.subscription_billings b
   where b.id = p_billing_id
   for update;

  if not found then
    raise exception 'Billing instalment % not found', p_billing_id
      using errcode = 'no_data_found';
  end if;

  if public.current_tenant_id() is not null
     and v_b.tenant_id is distinct from public.current_tenant_id() then
    raise exception 'Billing instalment % is not in the caller''s tenant', p_billing_id
      using errcode = 'insufficient_privilege';
  end if;

  /* Already billed. Ordinary answer, not an error — the cron retries. */
  if v_b.invoice_id is not null then
    select i.amount into v_existing from public.invoices i where i.id = v_b.invoice_id;
    return query select v_b.invoice_id, coalesce(v_existing, 0), true;
    return;
  end if;

  select s.id, s.tenant_id, s.customer_id, s.customer_name, s.plan, s.seats, s.quote_id
    into v_sub
    from public.subscriptions s
   where s.id = v_b.subscription_id;

  if not found then
    raise exception 'Subscription % behind instalment % no longer exists',
      v_b.subscription_id, p_billing_id using errcode = 'no_data_found';
  end if;

  v_tax   := round(v_b.taxable_amount * v_b.tax_rate / 100.0);
  v_gross := v_b.taxable_amount + v_tax;

  -- ── What has already been paid towards this subscription ──────────────────
  if v_sub.quote_id is not null then
    select coalesce(sum(p.amount), 0) into v_received
      from public.payments p
     where p.quote_id = v_sub.quote_id
       and p.status   = 'received';
  end if;

  select coalesce(sum(i.paid_amount), 0) into v_applied
    from public.subscription_billings b
    join public.invoices i on i.id = b.invoice_id
   where b.subscription_id = v_b.subscription_id;

  v_credit := least(greatest(0, v_received - v_applied), v_gross);
  v_status := case when v_credit >= v_gross then 'paid' else 'pending' end::invoice_status;

  select state_code into v_cust_st from public.customers where id = v_sub.customer_id;
  select state_code into v_sell_st from public.tenants   where id = v_b.tenant_id;
  v_inter := (v_cust_st is not null and v_sell_st is not null and v_cust_st <> v_sell_st);

  if v_sub.quote_id is not null then
    select coalesce(q.payment_terms_days, 0) into v_terms
      from public.quotes q where q.id = v_sub.quote_id;
  end if;
  v_terms := coalesce(v_terms, 0);

  /* ONE line, qty 1, rate = the whole instalment. Not qty = seats with a per-seat
     rate: an instalment of ₹2,000 over 3 seats is ₹666.67 each, and a tax invoice
     whose qty × rate does not equal its amount is wrong on its face. The seat count
     and service period go in the description, where CGST Rule 46 wants them. */
  v_lines := jsonb_build_array(jsonb_build_object(
    'id',          'instalment-' || v_b.period_index::text,
    'name',        v_sub.plan,
    'description', coalesce(v_sub.seats, 0)::text || ' seats · '
                   || to_char(v_b.period_start, 'DD Mon YYYY') || ' to '
                   || to_char(v_b.period_end,   'DD Mon YYYY'),
    'qty',         1,
    'rate',        v_b.taxable_amount,
    'cost',        0
  ));

  v_id := public.next_document_number('invoice', v_b.tenant_id, public.ist_today());
  if v_id is null then
    raise exception 'Could not allocate an invoice number for instalment %', p_billing_id;
  end if;

  insert into public.invoices (
    id, tenant_id, customer_id, customer_name, amount, status,
    invoice_date, due_date, paid_date,
    /* quote_id STAYS NULL — build-props.ts:69-71 prefers the quote for every amount
       it prints, so linking a ₹2,360 instalment to its ₹28,320 quote would print
       ₹28,320 on it. The link lives on subscription_billings. */
    quote_id,
    net_payable, paid_amount, taxable_value, tax_amount, tax_rate, inter_state,
    line_items
  ) values (
    v_id, v_b.tenant_id, v_sub.customer_id, v_sub.customer_name, v_gross, v_status,
    v_today, v_today + v_terms,
    case when v_status = 'paid' then v_today else null end,
    null,
    greatest(0, v_gross - v_credit), v_credit,
    v_b.taxable_amount, v_tax, v_b.tax_rate, v_inter,
    v_lines
  );

  update public.subscription_billings
     set invoice_id = v_id, updated_at = now()
   where id = p_billing_id;

  return query select v_id, v_gross, false;
end;
$function$;

-- ── issue_credit_note: 1 current_date -> ist_today(), 1 allocator call(s) now dated ──
CREATE OR REPLACE FUNCTION public.issue_credit_note(p_invoice_id text, p_gross_amount integer, p_reason_code text DEFAULT 'other'::text, p_reason text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_inv             record;
  v_is_service      boolean;
  v_caller_tenant   uuid;
  v_already         integer;
  v_max_creditable  integer;
  v_rate            integer;
  v_taxable         integer;
  v_tax             integer;
  v_cn_id           text;
  v_new_net         integer;
begin
  v_is_service := auth.role() = 'service_role';
  if not v_is_service then
    v_caller_tenant := public.current_tenant_id();
    if v_caller_tenant is null then raise exception 'No tenant context'; end if;
  end if;

  if p_gross_amount is null or p_gross_amount <= 0 then
    raise exception 'Credit amount must be greater than zero' using errcode = 'check_violation';
  end if;

  select i.id, i.tenant_id, i.customer_id, i.customer_name, i.amount, i.net_payable,
         i.tax_rate, i.inter_state
    into v_inv
    from public.invoices i where i.id = p_invoice_id for update;
  if not found then raise exception 'Invoice % not found', p_invoice_id using errcode = 'no_data_found'; end if;
  if not v_is_service and v_inv.tenant_id is distinct from v_caller_tenant then
    raise exception 'Invoice % is not in the caller''s tenant', p_invoice_id using errcode = 'insufficient_privilege';
  end if;

  select coalesce(sum(amount), 0) into v_already from public.credit_notes where invoice_id = p_invoice_id;
  v_max_creditable := coalesce(v_inv.amount, 0) - v_already;
  if p_gross_amount > v_max_creditable then
    raise exception 'Credit % exceeds the creditable balance % on invoice %',
      p_gross_amount, v_max_creditable, p_invoice_id using errcode = 'check_violation';
  end if;

  v_rate := coalesce(v_inv.tax_rate, 18);
  if v_rate = 0 then
    v_taxable := p_gross_amount;
    v_tax     := 0;
  else
    v_taxable := round(p_gross_amount * 100.0 / (100 + v_rate));
    v_tax     := p_gross_amount - v_taxable;
  end if;

  v_cn_id := public.next_document_number('credit_note', v_inv.tenant_id, public.ist_today());
  if v_cn_id is null then raise exception 'Could not allocate a credit note number'; end if;

  insert into public.credit_notes (
    id, tenant_id, invoice_id, customer_id, customer_name, credit_date,
    reason_code, reason, amount, taxable_value, tax_amount, tax_rate, inter_state, notes, created_by
  ) values (
    v_cn_id, v_inv.tenant_id, p_invoice_id, v_inv.customer_id, v_inv.customer_name, public.ist_today(),
    coalesce(p_reason_code, 'other'), p_reason, p_gross_amount, v_taxable, v_tax, v_rate,
    coalesce(v_inv.inter_state, false), p_notes, auth.uid()
  );

  v_new_net := greatest(0, coalesce(v_inv.net_payable, v_inv.amount) - p_gross_amount);
  update public.invoices set net_payable = v_new_net, updated_at = now() where id = p_invoice_id;

  return jsonb_build_object(
    'credit_note_id',  v_cn_id,
    'invoice_id',      p_invoice_id,
    'amount',          p_gross_amount,
    'taxable_value',   v_taxable,
    'tax_amount',      v_tax,
    'tax_rate',        v_rate,
    'inter_state',     coalesce(v_inv.inter_state, false),
    'new_net_payable', v_new_net
  );
end;
$function$;

-- ── issue_debit_note: 1 current_date -> ist_today(), 1 allocator call(s) now dated ──
CREATE OR REPLACE FUNCTION public.issue_debit_note(p_invoice_id text, p_gross_amount integer, p_reason_code text DEFAULT 'other'::text, p_reason text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_inv           record;
  v_is_service    boolean;
  v_caller_tenant uuid;
  v_rate          integer;
  v_taxable       integer;
  v_tax           integer;
  v_dn_id         text;
  v_new_net       integer;
begin
  v_is_service := auth.role() = 'service_role';
  if not v_is_service then
    v_caller_tenant := public.current_tenant_id();
    if v_caller_tenant is null then raise exception 'No tenant context'; end if;
  end if;

  if p_gross_amount is null or p_gross_amount <= 0 then
    raise exception 'Debit amount must be greater than zero' using errcode = 'check_violation';
  end if;

  select i.id, i.tenant_id, i.customer_id, i.customer_name, i.amount, i.net_payable,
         i.tax_rate, i.inter_state
    into v_inv
    from public.invoices i where i.id = p_invoice_id for update;
  if not found then raise exception 'Invoice % not found', p_invoice_id using errcode = 'no_data_found'; end if;
  if not v_is_service and v_inv.tenant_id is distinct from v_caller_tenant then
    raise exception 'Invoice % is not in the caller''s tenant', p_invoice_id using errcode = 'insufficient_privilege';
  end if;

  v_rate := coalesce(v_inv.tax_rate, 18);
  if v_rate = 0 then
    v_taxable := p_gross_amount;
    v_tax     := 0;
  else
    v_taxable := round(p_gross_amount * 100.0 / (100 + v_rate));
    v_tax     := p_gross_amount - v_taxable;
  end if;

  v_dn_id := public.next_document_number('debit_note', v_inv.tenant_id, public.ist_today());
  if v_dn_id is null then raise exception 'Could not allocate a debit note number'; end if;

  insert into public.debit_notes (
    id, tenant_id, invoice_id, customer_id, customer_name, debit_date,
    reason_code, reason, amount, taxable_value, tax_amount, tax_rate, inter_state, notes, created_by
  ) values (
    v_dn_id, v_inv.tenant_id, p_invoice_id, v_inv.customer_id, v_inv.customer_name, public.ist_today(),
    coalesce(p_reason_code, 'other'), p_reason, p_gross_amount, v_taxable, v_tax, v_rate,
    coalesce(v_inv.inter_state, false), p_notes, auth.uid()
  );

  v_new_net := coalesce(v_inv.net_payable, v_inv.amount) + p_gross_amount;
  update public.invoices set net_payable = v_new_net, updated_at = now() where id = p_invoice_id;

  return jsonb_build_object(
    'debit_note_id',   v_dn_id,
    'invoice_id',      p_invoice_id,
    'amount',          p_gross_amount,
    'taxable_value',   v_taxable,
    'tax_amount',      v_tax,
    'tax_rate',        v_rate,
    'inter_state',     coalesce(v_inv.inter_state, false),
    'new_net_payable', v_new_net
  );
end;
$function$;

-- ── create_direct_invoice: 1 current_date -> ist_today(), 1 allocator call(s) now dated ──
CREATE OR REPLACE FUNCTION public.create_direct_invoice(p_customer_id uuid, p_line_items jsonb, p_notes text DEFAULT NULL::text, p_recurring boolean DEFAULT false)
 RETURNS TABLE(invoice_id text, quote_id text, net_payable integer, tax_rate integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_is_svc   boolean := auth.role() = 'service_role';
  v_cust     record;
  v_export   boolean;
  v_rate     integer;
  v_subtotal integer;
  v_gross    integer;
  v_qid      text;
  v_inv      record;
  v_commit   text := case when p_recurring then 'annual_yearly' else 'one_time' end;
  v_lines    jsonb;
begin
  if not v_is_svc and v_tenant is null then raise exception 'No tenant context'; end if;
  if p_customer_id is null then raise exception 'Customer required'; end if;
  if jsonb_typeof(p_line_items) <> 'array' or jsonb_array_length(p_line_items) = 0 then
    raise exception 'At least one line item is required';
  end if;

  select c.id, c.name, c.country, c.tenant_id into v_cust
    from public.customers c where c.id = p_customer_id;
  if not found then raise exception 'Customer not found'; end if;
  if not v_is_svc and v_cust.tenant_id is distinct from v_tenant then
    raise exception 'Customer is not in the caller''s tenant';
  end if;
  v_tenant := v_cust.tenant_id;

  v_export := coalesce(nullif(lower(trim(v_cust.country)), ''), 'india') not in ('india','in','ind','bharat');
  v_rate := case when v_export then 0 else 18 end;

  select coalesce(jsonb_agg(li || jsonb_build_object('commitment', v_commit)), '[]'::jsonb)
    into v_lines
    from jsonb_array_elements(p_line_items) li;

  select coalesce(sum( coalesce((li->>'qty')::int, 1) * coalesce((li->>'rate')::int, 0) ), 0)
    into v_subtotal
    from jsonb_array_elements(v_lines) li;
  if v_subtotal <= 0 then raise exception 'Invoice total must be greater than zero'; end if;
  v_gross := v_subtotal + round(v_subtotal * v_rate / 100.0)::int;

  v_qid := public.next_document_number('quote', v_tenant, public.ist_today());
  if v_qid is null then raise exception 'Could not allocate a quote number'; end if;

  insert into public.quotes (
    id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, discount_pct,
    line_items, status, payment_status, is_one_off, created_date, notes
  ) values (
    v_qid, v_tenant, p_customer_id, v_cust.name, v_gross, v_subtotal, v_rate, 0,
    v_lines, 'accepted', 'awaiting', not p_recurring, public.ist_today(), p_notes
  );

  select gi.invoice_id, gi.net_payable into v_inv
    from public.generate_invoice(v_qid) gi;

  return query select v_inv.invoice_id, v_qid, v_inv.net_payable, v_rate;
end;
$function$;

commit;
