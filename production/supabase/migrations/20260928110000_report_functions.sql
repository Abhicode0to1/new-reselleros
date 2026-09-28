-- S17 — Balance Sheet, P&L aur Ledger ab SQL me jodte hain, browser me nahi.
--
-- ─── KYUN ───────────────────────────────────────────────────────────────────
-- Balance sheet browser se ~25 sequential reads karta tha, aur har bank account ke liye
-- alag `bank_account_current_balance` RPC (N+1). P&L aur ledger poori table ki all-time
-- rows kheench kar JS me jodte the — aur Balance Sheet ka retained-earnings wala P&L
-- BOOKS_START (2000) se aaj tak ka hai, yaani har invoice aur har expense browser me.
-- PostgREST par max-rows cap lagte hi (PGRST_DB_MAX_ROWS) wo sum CHUP-CHAAP chhota ho
-- jaata — galat number, koi error nahi (AGENTS.md §2).
--
-- ─── BANTWARA: SQL jodta hai, niyam TS me hi rehte hain ────────────────────
-- Jo tables saal-dar-saal badhti hain (invoices, payments, expenses, bank_transactions…)
-- unka sum/group-by yahan. Jo niyam TS me tested hain aur chhoti inputs par chalte hain —
-- ITC eligibility (lib/gst/itc.ts), WDV depreciation (lib/accounting/depreciation.ts),
-- statutory dues (tds-deductor.ts), income-tax FY (tax-payments.ts), expense report,
-- project cost — unko yahan COPY nahi kiya: SQL unhe GROUPED rows deta hai (har group me
-- `n` = kitni asli rows), aur TS wahi function chalata hai. Ek niyam, ek jagah.
--
-- ─── NUMBERS BADALNE NAHI CHAHIYE ───────────────────────────────────────────
-- Filters, `??` fallbacks aur Math.round (floor(x + 0.5) — JS half-up hai, Postgres
-- round() half-away-from-zero) purane TS ki line-by-line nakal hain. Parity test:
-- tests/parity/reports-parity.test.ts (purana TS logic src/lib/accounting/reports-reference.ts
-- me oracle ke roop me). Purani galtiyan JAAN-BOOJH kar waise hi rakhi hain aur neeche naam
-- se likhi hain — parity todne wala fix alag, dikhne wala change ho.
--
-- ─── SURAKSHA ───────────────────────────────────────────────────────────────
-- Sab SECURITY INVOKER — RLS waise hi lagta hai jaise browser ke direct reads par. Upar se
-- explicit `tenant_id = current_tenant_id()`, aur tenant null ho to raise (L10: bina tenant
-- ke 0 lautana "sab theek, kuch nahi hai" jaisa dikhta hai). Paisa poore rupees (§1); sums bigint.

-- ════════════════════════════════════════════════════════════════════════════
-- Balance sheet — auto figures
-- ════════════════════════════════════════════════════════════════════════════
-- p_as_of: GST ka cumulative cut-off (≤ as_of), FY label/advance-tax ka FY, aur WDV ki
-- tareekh. Baaki stock figures "live abhi" ke hain — paid/pending status ka itihaas record
-- nahi hota, isliye beete din ka asli as-of receivable in tables se banta hi nahi. Jhootha
-- as-of dikhane se behtar hai saaf kehna: stock = aaj. (Purana TS bhi yahi karta tha.)
create or replace function public.report_balance_sheet(p_as_of date default null)
returns table (
  as_of                   date,
  fy_start_year           int,
  fy_label                text,
  cash_and_bank           bigint,
  credit_card_payable     bigint,
  receivables             bigint,
  advances_from_customers bigint,
  project_receivable      bigint,
  tds_receivable          bigint,
  employee_loans          bigint,
  prepaid_advances        bigint,
  emi_unregistered_cost   bigint,
  emi_loans_payable       bigint,
  business_loans_payable  bigint,
  payables                bigint,
  salary_payable          bigint,
  dues_salary_tds         bigint,
  dues_pf                 bigint,
  dues_esi                bigint,
  dues_vendor_tds         bigint,
  dues_paid               jsonb,
  reimbursements_payable  bigint,
  gst_output              bigint,
  bills_gst               bigint,
  itc_groups              jsonb,
  fixed_assets            jsonb,
  tax_payments            jsonb
)
language plpgsql
stable
security invoker
set search_path = public
as $function$
#variable_conflict use_column
declare
  v_tenant  uuid := public.current_tenant_id();
  v_to      date := coalesce(p_as_of, (now() at time zone 'Asia/Kolkata')::date);
  v_fy_year int;
  v_cash    bigint;
  v_card    bigint;
begin
  if v_tenant is null then
    raise exception 'Balance sheet nahi ban sakti: aapka login kisi workspace se juda nahi hai. Dobara sign in karein; phir bhi ho to owner se Settings → Team me aapko jodne ko kahein.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Indian FY: April se pehle ke mahine pichhle saal ke FY me.
  v_fy_year := case when extract(month from v_to) < 4 then extract(year from v_to)::int - 1
                    else extract(year from v_to)::int end;

  -- Cash & bank: har account = opening + sum(credit − debit), ek hi pass me (N+1 khatam).
  -- Credit card liability hai: negative = card par bakaya; positive (overpaid) = cash.
  select coalesce(sum(case when b.account_type = 'credit_card' and b.bal < 0 then 0 else b.bal end), 0),
         coalesce(sum(case when b.account_type = 'credit_card' and b.bal < 0 then -b.bal else 0 end), 0)
    into v_cash, v_card
    from (
      select a.account_type,
             a.opening_balance::bigint + coalesce((
               select sum(t.credit - t.debit)
                 from public.bank_transactions t
                where t.bank_account_id = a.id and t.tenant_id = v_tenant), 0) as bal
        from public.bank_accounts a
       where a.tenant_id = v_tenant
    ) b;

  return query
  select
    v_to,
    v_fy_year,
    'FY ' || v_fy_year || '-' || lpad(((v_fy_year + 1) % 100)::text, 2, '0'),
    v_cash,
    v_card,
    -- Trade receivables (accrual): pending/overdue, project-milestone invoices CHHOD kar
    -- (wo project_receivable me hain — dono me gine to double count). net_payable ?? amount.
    (select coalesce(sum(coalesce(i.net_payable, i.amount)), 0)::bigint
       from public.invoices i
      where i.tenant_id = v_tenant
        and i.status in ('pending', 'overdue')
        and not exists (select 1 from public.project_milestones pm
                         where pm.tenant_id = v_tenant and pm.invoice_id = i.id)),
    -- Customer advances: received payments jinke quote par abhi invoice nahi — liability.
    (select coalesce(sum(p.amount), 0)::bigint
       from public.payments p
       join public.quotes q on q.id = p.quote_id and q.tenant_id = v_tenant
      where p.tenant_id = v_tenant and p.status = 'received' and q.invoice_id is null),
    -- Project receivable: har active/completed project ka max(0, invoiced milestones − received).
    (select coalesce(sum(greatest(0,
              coalesce((select sum(pm.total_amount) from public.project_milestones pm
                         where pm.tenant_id = v_tenant and pm.project_id = ps.id and pm.invoice_id is not null), 0)
            - coalesce((select sum(pp.amount) from public.project_payments pp
                         where pp.tenant_id = v_tenant and pp.project_id = ps.id), 0))), 0)::bigint
       from public.project_sales ps
      where ps.tenant_id = v_tenant and ps.status in ('active', 'completed')),
    (select coalesce(sum(t.tds_amount), 0)::bigint
       from public.tds_receivable t
      where t.tenant_id = v_tenant and t.status in ('pending_cert', 'cert_received', 'verified_26as')),
    -- Employee loans: KUL principal − KUL repayments (per-loan max(0) nahi — purana TS bhi
    -- total par karta tha; parity ke liye waise hi).
    greatest(0,
      (select coalesce(sum(l.principal), 0) from public.employee_loans l where l.tenant_id = v_tenant)
    - (select coalesce(sum(r.amount), 0) from public.employee_loan_repayments r where r.tenant_id = v_tenant))::bigint,
    (select coalesce(sum(greatest(0, pa.total_amount - pa.consumed_amount)), 0)::bigint
       from public.prepaid_advances pa where pa.tenant_id = v_tenant),
    -- EMI purchase jo abhi fixed-asset register me nahi — cost par (register wale WDV par, TS me).
    (select coalesce(sum(ep.total_cost), 0)::bigint
       from public.emi_purchases ep
      where ep.tenant_id = v_tenant
        and not exists (select 1 from public.fixed_assets fa
                         where fa.tenant_id = v_tenant and fa.emi_purchase_id = ep.id)),
    greatest(0,
      (select coalesce(sum(ep.financed), 0) from public.emi_purchases ep where ep.tenant_id = v_tenant)
    - (select coalesce(sum(em.principal_part), 0) from public.emi_payments em where em.tenant_id = v_tenant))::bigint,
    greatest(0,
      (select coalesce(sum(bl.principal), 0) from public.business_loans bl where bl.tenant_id = v_tenant)
    - (select coalesce(sum(bp.principal_part), 0) from public.business_loan_payments bp where bp.tenant_id = v_tenant))::bigint,
    (select coalesce(sum(greatest(0, vb.total - vb.paid_amount)), 0)::bigint
       from public.vendor_bills vb where vb.tenant_id = v_tenant and vb.status <> 'paid'),
    (select coalesce(sum(greatest(0, s.net - s.paid_amount)), 0)::bigint
       from public.salary_payments s where s.tenant_id = v_tenant and s.paid_status <> 'paid'),
    -- Statutory dues ke hisse (har booked salary, paid ho ya nahi; employer share bhi) —
    -- statutoryDues() TS me jodta hai, taaki Payroll banner aur ye ek hi niyam rahein.
    (select coalesce(sum(s.tds), 0)::bigint from public.salary_payments s where s.tenant_id = v_tenant),
    (select coalesce(sum(s.pf + s.pf_employer), 0)::bigint from public.salary_payments s where s.tenant_id = v_tenant),
    (select coalesce(sum(s.esi + s.esi_employer), 0)::bigint from public.salary_payments s where s.tenant_id = v_tenant),
    (select coalesce(sum(e.tds_amount), 0)::bigint from public.expenses e where e.tenant_id = v_tenant and e.tds_amount > 0),
    (select coalesce(jsonb_agg(jsonb_build_object('kind', d.kind, 'amount', d.amount) order by d.kind), '[]'::jsonb)
       from (select sd.kind, sum(sd.amount)::bigint as amount
               from public.statutory_dues_payments sd where sd.tenant_id = v_tenant group by sd.kind) d),
    (select coalesce(sum(r.amount), 0)::bigint
       from public.reimbursements r where r.tenant_id = v_tenant and r.status = 'pending'),
    -- GST CUMULATIVE (≤ as_of): frozen tax_amount, purani row me amount se reverse-derive
    -- (rate ?? 18), phir credit note ghatao, debit note jodo.
    ((select coalesce(sum(coalesce(i.tax_amount,
               floor(i.amount::numeric * coalesce(i.tax_rate, 18) / (100 + coalesce(i.tax_rate, 18)) + 0.5)::bigint)), 0)
        from public.invoices i
       where i.tenant_id = v_tenant and i.invoice_date <= v_to and i.status in ('pending', 'paid', 'overdue'))
     - (select coalesce(sum(c.tax_amount), 0) from public.credit_notes c where c.tenant_id = v_tenant and c.credit_date <= v_to)
     + (select coalesce(sum(d.tax_amount), 0) from public.debit_notes d where d.tenant_id = v_tenant and d.debit_date <= v_to))::bigint,
    (select coalesce(sum(vb.cgst + vb.sgst + vb.igst), 0)::bigint
       from public.vendor_bills vb where vb.tenant_id = v_tenant and vb.bill_date <= v_to),
    -- ITC: expense GST ko (bill_type, category, vendor GSTIN) par group karke — eligibility
    -- splitItc() TS me hi tay karta hai. Sirf gst_paid > 0 rows (splitItc 0 ko chhod deta hai).
    (select coalesce(jsonb_agg(jsonb_build_object('bill_type', g.bill_type, 'category', g.category,
                                                  'vendorGstin', g.gstin, 'gst_paid', g.gst, 'n', g.n)), '[]'::jsonb)
       from (select e.bill_type, e.category, v.gstin, sum(e.gst_paid)::bigint as gst, count(*)::int as n
               from public.expenses e
               left join public.vendors v on v.id = e.vendor_id and v.tenant_id = v_tenant
              where e.tenant_id = v_tenant and e.expense_date <= v_to and e.gst_paid > 0
              group by e.bill_type, e.category, v.gstin) g),
    -- Fixed-asset register (chhoti table) — WDV bookValueNow() TS me.
    (select coalesce(jsonb_agg(jsonb_build_object('id', fa.id, 'name', fa.name, 'block', fa.block, 'cost', fa.cost,
                                                  'put_to_use', fa.put_to_use, 'disposed_on', fa.disposed_on,
                                                  'disposal_value', fa.disposal_value, 'emi_purchase_id', fa.emi_purchase_id)
                               order by fa.put_to_use, fa.id), '[]'::jsonb)
       from public.fixed_assets fa where fa.tenant_id = v_tenant),
    -- Tax challans (GST + income tax) — kind/period/fy par jode hue.
    (select coalesce(jsonb_agg(jsonb_build_object('kind', t.kind, 'amount', t.amount, 'period', t.period, 'fy', t.fy)), '[]'::jsonb)
       from (select tp.kind, tp.period, tp.fy, sum(tp.amount)::bigint as amount
               from public.tax_payments tp where tp.tenant_id = v_tenant group by tp.kind, tp.period, tp.fy) t);
end;
$function$;

-- ════════════════════════════════════════════════════════════════════════════
-- P&L — period aggregates
-- ════════════════════════════════════════════════════════════════════════════
-- Subscriptions, project_labour, employees, project_sales (master data, transactions nahi)
-- TS me hi padhe jaate hain — unka proration / project-cost logic wahin tested hai.
create or replace function public.report_pnl(p_from date, p_to date)
returns table (
  inv_taxable            bigint,
  inv_tax                bigint,
  revenue_count          int,
  cn_taxable             bigint,
  cn_tax                 bigint,
  dn_taxable             bigint,
  dn_tax                 bigint,
  revenue_by_project     jsonb,
  cogs                   bigint,
  cogs_count             int,
  bills_gst              bigint,
  expense_groups         jsonb,
  itc_groups             jsonb,
  unassigned_by_category jsonb,
  project_expenses       jsonb,
  commissions            bigint,
  commissions_count      int
)
language plpgsql
stable
security invoker
set search_path = public
as $function$
#variable_conflict use_column
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'P&L nahi ban sakta: aapka login kisi workspace se juda nahi hai. Dobara sign in karein; phir bhi ho to owner se Settings → Team me aapko jodne ko kahein.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'P&L ki tareekh galat hai (% se % tak). "From" tareekh "To" se pehle ya barabar honi chahiye — range dobara chunein.', p_from, p_to
      using errcode = 'invalid_parameter_value';
  end if;

  return query
  with inv as (
    -- Revenue = TAXABLE value (GST aamdani nahi). Purani row me taxable na ho to
    -- amount × 100 ÷ (100 + rate); tax = tax_amount ?? (amount − taxable).
    select i.id, i.amount::bigint as amount, i.tax_amount::bigint as tax_amount,
           coalesce(i.taxable_value::bigint,
             floor(i.amount::numeric * 100 / (100 + coalesce(i.tax_rate, 18)) + 0.5)::bigint) as taxable
      from public.invoices i
     where i.tenant_id = v_tenant and i.invoice_date between p_from and p_to
       and i.status in ('pending', 'paid', 'overdue')
  ), cn as (
    select c.invoice_id, c.taxable_value::bigint as taxable_value, c.tax_amount::bigint as tax_amount
      from public.credit_notes c where c.tenant_id = v_tenant and c.credit_date between p_from and p_to
  ), dn as (
    select d.invoice_id, d.taxable_value::bigint as taxable_value, d.tax_amount::bigint as tax_amount
      from public.debit_notes d where d.tenant_id = v_tenant and d.debit_date between p_from and p_to
  ), ms as (
    -- invoice → project (ek invoice ek hi milestone par hota hai; do hon to koi ek).
    select distinct on (pm.invoice_id) pm.invoice_id, pm.project_id
      from public.project_milestones pm
     where pm.tenant_id = v_tenant and pm.invoice_id is not null
     order by pm.invoice_id, pm.project_id
  ), proj_rev as (
    select ms.project_id, inv.taxable as rev from inv join ms on ms.invoice_id = inv.id
    union all
    select ms.project_id, dn.taxable_value from dn join ms on ms.invoice_id = dn.invoice_id
    union all
    select ms.project_id, -cn.taxable_value from cn join ms on ms.invoice_id = cn.invoice_id
  ), bills as (
    select vb.subtotal, vb.cgst, vb.sgst, vb.igst
      from public.vendor_bills vb
     where vb.tenant_id = v_tenant and vb.bill_date between p_from and p_to
       and vb.category like 'COGS-%'
  ), exps as (
    select e.amount::bigint as amount, e.gst_paid, e.category, e.vendor_name, e.expense_date, e.bill_type,
           e.project_id, e.description, v.gstin
      from public.expenses e
      left join public.vendors v on v.id = e.vendor_id and v.tenant_id = v_tenant
     where e.tenant_id = v_tenant and e.expense_date between p_from and p_to
  ), comms as (
    select rc.gross_commission
      from public.referral_commissions rc
     where rc.tenant_id = v_tenant and rc.earned_date between p_from and p_to
       and rc.status <> 'cancelled'
  )
  select
    (select coalesce(sum(inv.taxable), 0)::bigint from inv),
    (select coalesce(sum(coalesce(inv.tax_amount, inv.amount - inv.taxable)), 0)::bigint from inv),
    (select count(*)::int from inv),
    (select coalesce(sum(cn.taxable_value), 0)::bigint from cn),
    (select coalesce(sum(cn.tax_amount), 0)::bigint from cn),
    (select coalesce(sum(dn.taxable_value), 0)::bigint from dn),
    (select coalesce(sum(dn.tax_amount), 0)::bigint from dn),
    (select coalesce(jsonb_agg(jsonb_build_object('project_id', r.project_id, 'revenue', r.revenue) order by r.project_id), '[]'::jsonb)
       from (select pr.project_id, sum(pr.rev)::bigint as revenue from proj_rev pr group by pr.project_id) r),
    (select coalesce(sum(b.subtotal), 0)::bigint from bills b),
    (select count(*)::int from bills),
    (select coalesce(sum(b.cgst + b.sgst + b.igst), 0)::bigint from bills b),
    -- Expense report ke liye (category, vendor, mahina) ke groups, `n` = asli rows.
    (select coalesce(jsonb_agg(jsonb_build_object('category', g.category, 'vendor_name', g.vendor_name,
                                                  'month', g.month, 'amount', g.amount, 'n', g.n)), '[]'::jsonb)
       from (select x.category, x.vendor_name, to_char(x.expense_date, 'YYYY-MM') as month,
                    sum(x.amount)::bigint as amount, count(*)::int as n
               from exps x group by x.category, x.vendor_name, to_char(x.expense_date, 'YYYY-MM')) g),
    (select coalesce(jsonb_agg(jsonb_build_object('bill_type', g.bill_type, 'category', g.category,
                                                  'vendorGstin', g.gstin, 'gst_paid', g.gst, 'n', g.n)), '[]'::jsonb)
       from (select x.bill_type, x.category, x.gstin, sum(x.gst_paid)::bigint as gst, count(*)::int as n
               from exps x where x.gst_paid > 0 group by x.bill_type, x.category, x.gstin) g),
    -- Project se na jude expenses, category-war — project-cost ka salary pool isi se.
    (select coalesce(jsonb_agg(jsonb_build_object('category', g.category, 'amount', g.amount)), '[]'::jsonb)
       from (select x.category, sum(x.amount)::bigint as amount from exps x where x.project_id is null group by x.category) g),
    -- Project se jude expenses ek-ek (drill-down har line dikhata hai; ye ginti chhoti hai).
    (select coalesce(jsonb_agg(jsonb_build_object('project_id', x.project_id, 'amount', x.amount, 'category', x.category,
                                                  'expense_date', x.expense_date, 'vendor_name', x.vendor_name,
                                                  'description', x.description)
                               order by x.expense_date, x.amount desc), '[]'::jsonb)
       from exps x where x.project_id is not null),
    (select coalesce(sum(c.gross_commission), 0)::bigint from comms c),
    (select count(*)::int from comms);
end;
$function$;

-- P&L trend: mahine-war revenue (taxable) aur expenses. Purane trend jaisa hi — credit
-- notes yahan NAHI ghatte (headline me ghatte hain); wo alag sawaal hai, parity ke liye same.
create or replace function public.report_pnl_monthly(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_out jsonb;
begin
  if v_tenant is null then
    raise exception 'P&L trend nahi ban sakta: aapka login kisi workspace se juda nahi hai. Dobara sign in karein.'
      using errcode = 'insufficient_privilege';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('month', m.month, 'revenue', m.revenue, 'expenses', m.expenses)
                            order by m.month), '[]'::jsonb)
    into v_out
    from (
      select k.month, sum(k.rev)::bigint as revenue, sum(k.exp)::bigint as expenses
        from (
          select to_char(i.invoice_date, 'YYYY-MM') as month,
                 coalesce(i.taxable_value::bigint,
                   floor(i.amount::numeric * 100 / (100 + coalesce(i.tax_rate, 18)) + 0.5)::bigint) as rev,
                 0::bigint as exp
            from public.invoices i
           where i.tenant_id = v_tenant and i.invoice_date between p_from and p_to
             and i.status in ('pending', 'paid', 'overdue')
          union all
          select to_char(e.expense_date, 'YYYY-MM'), 0, e.amount::bigint
            from public.expenses e
           where e.tenant_id = v_tenant and e.expense_date between p_from and p_to
        ) k
       group by k.month
    ) m;
  return v_out;
end;
$function$;

-- ════════════════════════════════════════════════════════════════════════════
-- Ledger (khata) — opening balance + window ki entries
-- ════════════════════════════════════════════════════════════════════════════
-- Purana hook party ki POORI history laata tha taaki buildLedger opening nikaal sake.
-- Ab opening yahin jud jaata hai (window se pehle ka signed sum) aur sirf window ki entries
-- aati hain — opening zero hone ka khatra (ledger.ts ka header) waisa hi band hai.
--
-- Parity ke liye jaan-boojh kar: payment/refund ki tareekh received_at ka UTC din hai
-- (PostgREST timestamptz UTC me deta hai aur purana TS `.slice(0,10)` karta tha). 05:30 IST
-- se pehle ka payment pichhle din dikhta hai — IST trap (AGENTS.md §6). Alag fix, alag test.
create or replace function public.report_party_ledger(p_kind text, p_party text, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_cust   uuid;
  v_out jsonb;
begin
  if v_tenant is null then
    raise exception 'Ledger nahi ban sakta: aapka login kisi workspace se juda nahi hai. Dobara sign in karein.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_kind not in ('customer', 'vendor') then
    raise exception 'Ledger ka prakaar "%" samajh nahi aaya — sirf customer ya vendor chalta hai.', p_kind
      using errcode = 'invalid_parameter_value';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Ledger ki tareekh galat hai (% se % tak). Period dobara chunein.', p_from, p_to
      using errcode = 'invalid_parameter_value';
  end if;
  -- Customer id pehle hi uuid bana lo — query ke andar cast karte to vendor ke naam par
  -- bhi cast chal sakta (planner constant-fold karta hai) aur index bhi na lagta.
  if p_kind = 'customer' then
    begin
      v_cust := p_party::uuid;
    exception when invalid_text_representation then
      raise exception 'Customer id "%" sahi nahi hai. Customer list se dobara chunein.', p_party
        using errcode = 'invalid_parameter_value';
    end;
  end if;

  with e as (
    select * from (
      -- Customer: Sales (Dr), Receipt (Cr), Refund (Dr), Credit Note (Cr), Debit Note (Dr).
      select i.invoice_date as d, i.id as ref, 'Sales'::text as voucher, null::text as narr,
             i.amount::bigint as amt, true as up
        from public.invoices i
       where p_kind = 'customer' and i.tenant_id = v_tenant
         and i.customer_id = v_cust and i.status <> 'void'
      union all
      select (p.received_at at time zone 'UTC')::date, coalesce(p.receipt_voucher_no, p.id::text), 'Receipt',
             nullif(concat_ws(' · ', nullif(p.method, ''), nullif(p.reference, '')), ''),
             p.amount::bigint, false
        from public.payments p
       where p_kind = 'customer' and p.tenant_id = v_tenant and p.customer_id = v_cust
      union all
      select (p.refunded_at at time zone 'UTC')::date,
             coalesce(p.receipt_voucher_no, p.id::text) || ' · refunded', 'Refund',
             'Payment returned to the customer', p.amount::bigint, true
        from public.payments p
       where p_kind = 'customer' and p.tenant_id = v_tenant and p.customer_id = v_cust
         and p.status = 'refunded' and p.refunded_at is not null
      union all
      select c.credit_date, c.id, 'Credit Note',
             coalesce(c.reason, case when coalesce(c.invoice_id, '') <> '' then 'against ' || c.invoice_id end),
             c.amount::bigint, false
        from public.credit_notes c
       where p_kind = 'customer' and c.tenant_id = v_tenant and c.customer_id = v_cust
      union all
      select d.debit_date, d.id, 'Debit Note',
             coalesce(d.reason, case when coalesce(d.invoice_id, '') <> '' then 'against ' || d.invoice_id end),
             d.amount::bigint, true
        from public.debit_notes d
       where p_kind = 'customer' and d.tenant_id = v_tenant and d.customer_id = v_cust
      union all
      -- Vendor: expenses hi bill hain (vendor_name par — vendor_id zyaadatar khaali hai).
      select x.expense_date, coalesce(x.bill_no, x.id), 'Purchase', x.category, x.amount::bigint, true
        from public.expenses x
       where p_kind = 'vendor' and x.tenant_id = v_tenant and x.vendor_name = p_party
      union all
      select x.paid_date, coalesce(x.bill_no, x.id) || ' · paid', 'Payment', x.payment_method, x.amount::bigint, false
        from public.expenses x
       where p_kind = 'vendor' and x.tenant_id = v_tenant and x.vendor_name = p_party
         and x.paid and x.paid_date is not null
    ) u
    where u.d is not null
  )
  select jsonb_build_object(
    'opening', (select coalesce(sum(case when e.up then e.amt else -e.amt end), 0) from e where e.d < p_from),
    'entries', (select coalesce(jsonb_agg(jsonb_build_object(
                  'date', to_char(e.d, 'YYYY-MM-DD'), 'reference', e.ref, 'voucher', e.voucher,
                  'narration', e.narr, 'amount', e.amt, 'increasesLiability', e.up)
                  order by e.d, e.up desc, e.ref), '[]'::jsonb)
                  from e where e.d between p_from and p_to)
  ) into v_out;
  return v_out;
end;
$function$;

-- Ledger ka vendor picker: expenses ke distinct naam, total billed ke hisaab se.
-- Purana hook `.limit(2000)` lagata tha — 2000 bills ke baad picker chupke se adhoora.
create or replace function public.report_ledger_vendors()
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_out jsonb;
begin
  if v_tenant is null then
    raise exception 'Vendor list nahi ban sakti: aapka login kisi workspace se juda nahi hai. Dobara sign in karein.'
      using errcode = 'insufficient_privilege';
  end if;

  with r as (
    -- JS .trim() jaisa: dono taraf ka har whitespace hatao, sirf space nahi.
    select regexp_replace(e.vendor_name, '^\s+|\s+$', '', 'g') as name, e.amount::bigint as amount,
           regexp_replace(coalesce(e.category, ''), '^\s+|\s+$', '', 'g') as cat
      from public.expenses e
     where e.tenant_id = v_tenant and e.vendor_name is not null
  ), v as (
    select r.name, sum(r.amount)::bigint as billed, count(*)::int as bills from r where r.name <> '' group by r.name
  ), c as (
    select r.name, r.cat, sum(r.amount)::bigint as total from r where r.name <> '' and r.cat <> '' group by r.name, r.cat
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'name', v.name, 'billed', v.billed, 'bills', v.bills,
           'categories', coalesce((select jsonb_agg(c.cat order by c.total desc, c.cat)
                                     from c where c.name = v.name), '[]'::jsonb))
         order by v.billed desc, v.name), '[]'::jsonb)
    into v_out
    from v;
  return v_out;
end;
$function$;

-- ── Grants: sirf logged-in user; anon/public ko nahi ─────────────────────────
revoke all on function public.report_balance_sheet(date)                   from public, anon;
revoke all on function public.report_pnl(date, date)                       from public, anon;
revoke all on function public.report_pnl_monthly(date, date)               from public, anon;
revoke all on function public.report_party_ledger(text, text, date, date)  from public, anon;
revoke all on function public.report_ledger_vendors()                      from public, anon;
grant execute on function public.report_balance_sheet(date)                  to authenticated;
grant execute on function public.report_pnl(date, date)                      to authenticated;
grant execute on function public.report_pnl_monthly(date, date)              to authenticated;
grant execute on function public.report_party_ledger(text, text, date, date) to authenticated;
grant execute on function public.report_ledger_vendors()                     to authenticated;
