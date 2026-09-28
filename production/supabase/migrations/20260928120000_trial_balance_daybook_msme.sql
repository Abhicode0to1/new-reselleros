-- S33 — Day Book, 26AS match ka ek-call update, aur MSME 43B(h) payables aging.
--
-- ─── KYUN ───────────────────────────────────────────────────────────────────
-- CA sabse pehle Trial Balance aur Day Book maangta hai — app me dono ka 0 match tha.
-- TDS receivable ka "26AS par dikha" haath se ek-ek row tick hota tha. Aur MSME vendor ka
-- 45-din wala niyam (Income-tax Act s.43B(h), FY 2023-24 se) kahin track nahi hota tha:
-- micro/small vendor ka bill 45 din (likhit agreement na ho to 15) se zyada bakaya raha to
-- us saal wo kharcha deduction me nahi milta — tax badhta hai, aur kisi ko pata nahi chalta.
--
-- Trial Balance ke liye yahan ALAG function nahi hai, jaan-boojh kar: TB wahi aankde hain jo
-- report_balance_sheet + report_pnl (S17, migration 20260928110000) dete hain. Teesri SQL
-- copy ka matlab hota ek hi number ki teesri definition — aur teen reports jo aapas me nahi
-- milti. TB lib/accounting/trial-balance.ts un do RPCs se banata hai.
--
-- Suraksha: sab SECURITY INVOKER (RLS lagta hai) + explicit tenant filter + tenant null
-- par raise. Execute sirf authenticated ko. Paisa poore rupees (AGENTS.md §1).

-- ════════════════════════════════════════════════════════════════════════════
-- Day Book — tareekh-war har voucher
-- ════════════════════════════════════════════════════════════════════════════
-- Kya hai: Sales (invoice), Receipt (payment + project payment), Refund, Credit Note,
-- Debit Note, Purchase (expense + COGS vendor bill), Payment (paid expense).
-- Kya NAHI hai, aur kyun:
--   · salary_payments — har salary pehle se ek `expenses` row ban kar aati hai
--     (project-cost.ts: "Salaries are booked once, as expenses rows"); dono dikhate to
--     salary do baar.
--   · bank_transactions — ye statement ki lines hain, voucher nahi; wahi paisa upar ke
--     Receipt/Payment me hai.
--   · draft/void invoice — jaari hi nahi hua.
-- Tareekh: payment ka din IST me (received_at at time zone 'Asia/Kolkata') — Day Book naya
-- report hai, isme purani UTC galti (S17 ledger note) nahi dohrayi.
-- Range 366 din tak: ek din/mahina/saal ka Day Book dekha jaata hai; usse bada ek hi jawab
-- me bhejna browser ko wahi all-time rows dena hota jo S17 ne hataya.
create or replace function public.report_day_book(p_from date, p_to date)
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
    raise exception 'Day Book nahi ban sakti: aapka login kisi workspace se juda nahi hai. Dobara sign in karein; phir bhi ho to owner se Settings → Team me aapko jodne ko kahein.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Day Book ki tareekh galat hai (% se % tak). "From" tareekh "To" se pehle ya barabar honi chahiye.', p_from, p_to
      using errcode = 'invalid_parameter_value';
  end if;
  if p_to - p_from > 366 then
    raise exception 'Day Book ek baar me zyada se zyada 366 din ki banti hai (aapne % din chune). Chhota period chunein — mahina ya FY.', p_to - p_from + 1
      using errcode = 'invalid_parameter_value';
  end if;

  with v as (
    select i.invoice_date as d, 'Sales'::text as voucher, i.id as ref, i.customer_name as party,
           null::text as narr, i.amount::bigint as amt, 1 as ord
      from public.invoices i
     where i.tenant_id = v_tenant and i.invoice_date between p_from and p_to
       and i.status not in ('draft', 'void')
    union all
    select (p.received_at at time zone 'Asia/Kolkata')::date, 'Receipt',
           coalesce(p.receipt_voucher_no, p.id::text), c.name,
           nullif(concat_ws(' · ', nullif(p.method, ''), nullif(p.reference, '')), ''),
           p.amount::bigint, 2
      from public.payments p
      left join public.customers c on c.id = p.customer_id and c.tenant_id = v_tenant
     where p.tenant_id = v_tenant
       and (p.received_at at time zone 'Asia/Kolkata')::date between p_from and p_to
    union all
    select (p.refunded_at at time zone 'Asia/Kolkata')::date, 'Refund',
           coalesce(p.refund_voucher_no, coalesce(p.receipt_voucher_no, p.id::text) || ' · refunded'), c.name,
           p.refund_reason, p.amount::bigint, 3
      from public.payments p
      left join public.customers c on c.id = p.customer_id and c.tenant_id = v_tenant
     where p.tenant_id = v_tenant and p.status = 'refunded' and p.refunded_at is not null
       and (p.refunded_at at time zone 'Asia/Kolkata')::date between p_from and p_to
    union all
    select pp.received_at, 'Receipt', coalesce(nullif(pp.reference, ''), pp.id::text), ps.customer_name,
           'Project: ' || ps.title, pp.amount::bigint, 2
      from public.project_payments pp
      join public.project_sales ps on ps.id = pp.project_id and ps.tenant_id = v_tenant
     where pp.tenant_id = v_tenant and pp.received_at between p_from and p_to
    union all
    select cn.credit_date, 'Credit Note', cn.id, cn.customer_name,
           coalesce(cn.reason, 'against ' || cn.invoice_id), cn.amount::bigint, 4
      from public.credit_notes cn
     where cn.tenant_id = v_tenant and cn.credit_date between p_from and p_to
    union all
    select dn.debit_date, 'Debit Note', dn.id, dn.customer_name,
           coalesce(dn.reason, 'against ' || dn.invoice_id), dn.amount::bigint, 4
      from public.debit_notes dn
     where dn.tenant_id = v_tenant and dn.debit_date between p_from and p_to
    union all
    select e.expense_date, 'Purchase', coalesce(e.bill_no, e.id), e.vendor_name, e.category, e.amount::bigint, 5
      from public.expenses e
     where e.tenant_id = v_tenant and e.expense_date between p_from and p_to
    union all
    select vb.bill_date, 'Purchase', coalesce(vb.bill_no, vb.id), vb.vendor_name, vb.category, vb.total::bigint, 5
      from public.vendor_bills vb
     where vb.tenant_id = v_tenant and vb.bill_date between p_from and p_to
    union all
    select e.paid_date, 'Payment', coalesce(e.bill_no, e.id) || ' · paid', e.vendor_name,
           e.payment_method, e.amount::bigint, 6
      from public.expenses e
     where e.tenant_id = v_tenant and e.paid and e.paid_date between p_from and p_to
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'date', to_char(v.d, 'YYYY-MM-DD'), 'voucher', v.voucher, 'reference', v.ref,
           'party', v.party, 'narration', v.narr, 'amount', v.amt)
         order by v.d, v.ord, v.ref), '[]'::jsonb)
    into v_out
    from v;
  return v_out;
end;
$function$;

-- ════════════════════════════════════════════════════════════════════════════
-- 26AS / AIS match → TDS receivable "verified on 26AS", ek call me
-- ════════════════════════════════════════════════════════════════════════════
-- Match browser me hota hai (lib/accounting/tds-26as.ts — file kabhi server par nahi
-- jaati, usme deductor ke PAN/TAN hote hain). Yahan sirf wo rows jinko user ne match
-- screen par dekh kar confirm kiya. Sirf pending_cert / cert_received badalti hain —
-- claimed / written_off / disputed ko ek import chupke se wapas "verified" na kar de.
create or replace function public.tds_mark_26as_verified(p_ids text[], p_seen_on date)
returns int
language plpgsql
volatile
security invoker
set search_path = public
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_n int;
begin
  if v_tenant is null then
    raise exception 'TDS update nahi ho saka: aapka login kisi workspace se juda nahi hai. Dobara sign in karein.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_seen_on is null or p_seen_on > (now() at time zone 'Asia/Kolkata')::date then
    raise exception '26AS ki tareekh (%) galat hai — aaj ya usse pehle ki honi chahiye. File ki "as on" tareekh dekh kar dobara chunein.', p_seen_on
      using errcode = 'invalid_parameter_value';
  end if;

  update public.tds_receivable t
     set status = 'verified_26as',
         appears_in_26as = true,
         appears_in_26as_date = p_seen_on,
         updated_at = now()
   where t.tenant_id = v_tenant
     and t.id = any(p_ids)
     and t.status in ('pending_cert', 'cert_received');
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

-- ════════════════════════════════════════════════════════════════════════════
-- MSME (Udyam) on the vendor master
-- ════════════════════════════════════════════════════════════════════════════
-- udyam: Udyam Registration Number, format UDYAM-SS-00-0000000 (state, district, serial).
-- msme_category: 43B(h) sirf MICRO aur SMALL par lagta hai — medium par nahi. Isliye
-- sirf "Udyam hai" kaafi nahi; category ke bina hum maan lete hain ki niyam lagta hai
-- (galat "safe" batane se behtar), aur screen category bharne ko kehti hai.
alter table public.vendors add column if not exists udyam text;
alter table public.vendors add column if not exists msme_category text;
alter table public.vendors drop constraint if exists vendors_udyam_format;
alter table public.vendors add constraint vendors_udyam_format
  check (udyam is null or udyam ~ '^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$');
alter table public.vendors drop constraint if exists vendors_msme_category_check;
alter table public.vendors add constraint vendors_msme_category_check
  check (msme_category is null or msme_category in ('micro', 'small', 'medium'));
alter table public.vendors drop constraint if exists vendors_msme_category_needs_udyam;
alter table public.vendors add constraint vendors_msme_category_needs_udyam
  check (msme_category is null or udyam is not null);

comment on column public.vendors.udyam is 'Udyam Registration Number (UDYAM-SS-00-0000000). Set = MSME vendor; drives the 43B(h) 45-day payables flag.';
comment on column public.vendors.msme_category is 'micro | small | medium. s.43B(h) applies to micro and small only; null = unknown, treated as covered.';

-- ════════════════════════════════════════════════════════════════════════════
-- MSME payables aging — 43B(h) ka 45-din flag
-- ════════════════════════════════════════════════════════════════════════════
-- Har bakaya bill (vendor_bills ka total − paid, aur unpaid expenses) jiska vendor Udyam
-- wala micro/small (ya category-unknown) hai. Vendor ka link pehle vendor_id se, na ho to
-- naam se (case/space ignore) — expenses.vendor_id zyaadatar khaali hai (ledger.ts note);
-- sirf id par chalte to aadhe MSME bill dikhte hi nahi.
-- Limit 45 din bill date se (likhit agreement ho to max 45; na ho to 15 — screen batati hai).
create or replace function public.msme_payables_aging(p_as_of date default null)
returns table (
  vendor_id        uuid,
  vendor_name      text,
  udyam            text,
  msme_category    text,
  source           text,
  doc_id           text,
  bill_ref         text,
  bill_date        date,
  amount_due       bigint,
  days_outstanding int,
  deadline         date,
  over_limit       boolean
)
language plpgsql
stable
security invoker
set search_path = public
as $function$
#variable_conflict use_column
declare
  v_tenant uuid := public.current_tenant_id();
  v_as_of  date := coalesce(p_as_of, (now() at time zone 'Asia/Kolkata')::date);
begin
  if v_tenant is null then
    raise exception 'MSME payables nahi ban sakte: aapka login kisi workspace se juda nahi hai. Dobara sign in karein.'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  with msme as (
    select v.id, v.name, v.udyam, v.msme_category, lower(regexp_replace(btrim(v.name), '\s+', ' ', 'g')) as key
      from public.vendors v
     where v.tenant_id = v_tenant and v.udyam is not null
       and coalesce(v.msme_category, 'unknown') <> 'medium'
  ), docs as (
    select 'vendor_bill'::text as source, vb.id as doc_id, coalesce(vb.bill_no, vb.id) as bill_ref,
           vb.bill_date, greatest(0, vb.total - vb.paid_amount)::bigint as due,
           vb.vendor_id, lower(regexp_replace(btrim(vb.vendor_name), '\s+', ' ', 'g')) as key
      from public.vendor_bills vb
     where vb.tenant_id = v_tenant and vb.status <> 'paid' and vb.total > vb.paid_amount
       and vb.bill_date <= v_as_of
    union all
    select 'expense', e.id, coalesce(e.bill_no, e.id), e.expense_date, e.amount::bigint,
           e.vendor_id, lower(regexp_replace(btrim(coalesce(e.vendor_name, '')), '\s+', ' ', 'g'))
      from public.expenses e
     where e.tenant_id = v_tenant and not e.paid and e.amount > 0
       and e.expense_date <= v_as_of
  )
  select m.id, m.name, m.udyam, m.msme_category, d.source, d.doc_id, d.bill_ref, d.bill_date, d.due,
         (v_as_of - d.bill_date)::int,
         d.bill_date + 45,
         v_as_of > d.bill_date + 45
    from docs d
    join lateral (
      select mm.* from msme mm
       where (d.vendor_id is not null and mm.id = d.vendor_id)
          or (d.vendor_id is null and mm.key = d.key)
       order by mm.id
       limit 1
    ) m on true
   order by (v_as_of > d.bill_date + 45) desc, d.bill_date, d.doc_id;
end;
$function$;

-- ── Grants ───────────────────────────────────────────────────────────────────
revoke all on function public.report_day_book(date, date)             from public, anon;
revoke all on function public.tds_mark_26as_verified(text[], date)    from public, anon;
revoke all on function public.msme_payables_aging(date)               from public, anon;
grant execute on function public.report_day_book(date, date)          to authenticated;
grant execute on function public.tds_mark_26as_verified(text[], date) to authenticated;
grant execute on function public.msme_payables_aging(date)            to authenticated;
