


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE TYPE "public"."invoice_status" AS ENUM (
    'draft',
    'pending',
    'paid',
    'overdue',
    'void'
);


ALTER TYPE "public"."invoice_status" OWNER TO "postgres";


CREATE TYPE "public"."lead_stage" AS ENUM (
    'new',
    'contact',
    'demo',
    'trial',
    'quote',
    'won',
    'lost'
);


ALTER TYPE "public"."lead_stage" OWNER TO "postgres";


CREATE TYPE "public"."payment_status" AS ENUM (
    'none',
    'awaiting',
    'partial',
    'received',
    'invoiced'
);


ALTER TYPE "public"."payment_status" OWNER TO "postgres";


CREATE TYPE "public"."quote_status" AS ENUM (
    'draft',
    'sent',
    'viewed',
    'accepted',
    'rejected',
    'expired'
);


ALTER TYPE "public"."quote_status" OWNER TO "postgres";


CREATE TYPE "public"."renewal_state" AS ENUM (
    'pending',
    'notice_sent',
    'reminder_1',
    'reminder_2',
    'reminder_3',
    'reminder_4',
    'final_sent',
    'grace_period',
    'renewed',
    'suspended',
    'early_notice'
);


ALTER TYPE "public"."renewal_state" OWNER TO "postgres";


CREATE TYPE "public"."sub_status" AS ENUM (
    'active',
    'paused',
    'expired',
    'cancelled'
);


ALTER TYPE "public"."sub_status" OWNER TO "postgres";


CREATE TYPE "public"."task_kind" AS ENUM (
    'call',
    'email',
    'meeting',
    'followup',
    'custom'
);


ALTER TYPE "public"."task_kind" OWNER TO "postgres";


CREATE TYPE "public"."task_status" AS ENUM (
    'pending',
    'done',
    'snoozed',
    'cancelled'
);


ALTER TYPE "public"."task_status" OWNER TO "postgres";


CREATE TYPE "public"."user_role" AS ENUM (
    'owner',
    'sales',
    'accountant',
    'support',
    'sales_senior',
    'manager',
    'billing',
    'delivery',
    'partner_agent'
);


ALTER TYPE "public"."user_role" OWNER TO "postgres";


CREATE TYPE "public"."vault_category" AS ENUM (
    'google_admin',
    'm365_admin',
    'dns_registrar',
    'cpanel',
    'distributor',
    'other'
);


ALTER TYPE "public"."vault_category" OWNER TO "postgres";


CREATE TYPE "public"."vendor" AS ENUM (
    'google',
    'microsoft',
    'zoho',
    'other',
    'domain',
    'hosting',
    'support'
);


ALTER TYPE "public"."vendor" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."accept_project_quote"("p_project_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_status text;
  v_tenant uuid;
  v_cust   uuid;
  v_name   text;
begin
  select status, tenant_id, customer_id, customer_name
    into v_status, v_tenant, v_cust, v_name
    from public.project_sales where id = p_project_id;
  if not found then raise exception 'Quotation not found' using errcode = 'no_data_found'; end if;
  if v_status = 'active' then return 'already'; end if;
  if v_status <> 'quoted' then
    raise exception 'This quotation cannot be accepted (status %)', v_status using errcode = 'invalid_parameter_value';
  end if;

  if v_cust is null then
    select id into v_cust
      from public.customers
     where tenant_id = v_tenant and lower(name) = lower(trim(coalesce(v_name, '')))
     limit 1;
    if v_cust is null and length(trim(coalesce(v_name, ''))) > 0 then
      insert into public.customers (tenant_id, name, since, health)
      values (v_tenant, trim(v_name), current_date, 70)
      returning id into v_cust;
    end if;
  end if;

  update public.project_sales
     set status = 'active', accepted_at = now(), customer_id = v_cust, updated_at = now()
   where id = p_project_id;

  if v_cust is not null then
    update public.invoices i
       set customer_id = v_cust
      from public.project_milestones m
     where m.project_id = p_project_id
       and i.id = m.invoice_id
       and i.customer_id is null;
  end if;

  return 'accepted';
end;
$$;


ALTER FUNCTION "public"."accept_project_quote"("p_project_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."accept_quote"("p_quote_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_quote        record;
  v_caller       uuid;
  v_tenant       uuid;
  v_customer_id  uuid;
  v_lead         record;
  v_domain       text;
  v_converted    boolean := false;
begin
  select q.id, q.tenant_id, q.customer_id, q.customer_name, q.lead_id, q.status,
         q.domain, q.payment_status
    into v_quote
    from public.quotes q
   where q.id = p_quote_id
   for update;
  if not found then
    raise exception 'quote % not found', p_quote_id;
  end if;

  v_caller := public.current_tenant_id();
  if v_caller is not null and v_quote.tenant_id <> v_caller then
    raise exception 'quote % does not belong to your tenant', p_quote_id;
  end if;
  v_tenant := v_quote.tenant_id;

  if v_quote.status = 'rejected' or v_quote.status = 'expired' then
    raise exception 'cannot accept a % quote', v_quote.status;
  end if;

  v_customer_id := v_quote.customer_id;
  v_domain      := v_quote.domain;

  if v_customer_id is null and v_quote.lead_id is not null then
    select l.contact_name, l.contact_email, l.contact_phone, l.company, l.notes, l.domain,
           l.state_code, l.state, l.gstin
      into v_lead
      from public.leads l
     where l.id = v_quote.lead_id
       and l.tenant_id = v_tenant;
    if not found then
      raise exception 'lead % referenced by quote % not found', v_quote.lead_id, p_quote_id;
    end if;

    if v_domain is null then
      v_domain := v_lead.domain;
    end if;

    -- Dedup: reuse an existing customer with the same contact_email in this
    -- tenant instead of inserting a duplicate. (Prevents the duplicate-customer
    -- problem — same buyer accepting/paying must map to ONE customer record.)
    if v_lead.contact_email is not null and length(trim(v_lead.contact_email)) > 0 then
      select id into v_customer_id
        from public.customers
       where tenant_id = v_tenant
         and lower(contact_email) = lower(trim(v_lead.contact_email))
       limit 1;
    end if;

    if v_customer_id is null then
      insert into public.customers (
        tenant_id, name, contact_name, contact_email, contact_phone,
        domain, since, health, notes, state_code, state, gstin
      ) values (
        v_tenant, v_lead.company, v_lead.contact_name, v_lead.contact_email,
        v_lead.contact_phone, v_domain, current_date,
        70,
        v_lead.notes, v_lead.state_code, v_lead.state, v_lead.gstin
      )
      returning id into v_customer_id;
    end if;

    update public.leads
       set stage = 'won'
     where id = v_quote.lead_id
       and tenant_id = v_tenant;

    v_converted := true;
  end if;

  update public.quotes
     set status      = 'accepted',
         customer_id  = v_customer_id,
         payment_status = case
           when payment_status in ('partial', 'received', 'invoiced') then payment_status
           else 'awaiting'::payment_status
         end
   where id = p_quote_id
     and tenant_id = v_tenant;

  return jsonb_build_object(
    'quote_id',       p_quote_id,
    'customer_id',    v_customer_id,
    'converted_now',  v_converted,
    'quote_status',   'accepted',
    'awaits_payment', true
  );
end;
$$;


ALTER FUNCTION "public"."accept_quote"("p_quote_id" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."accept_quote"("p_quote_id" "text") IS 'Mark quote as accepted WITHOUT recording payment. Converts lead to customer if not already, links the customer to the quote. Used when customer commits verbally but pays later. Subscription is still created later via record_payment when the money actually lands.';



CREATE OR REPLACE FUNCTION "public"."add_reimbursement"("p_person" "text", "p_purpose" "text", "p_category" "text", "p_amount" integer, "p_gst" integer, "p_incurred_on" "date", "p_paid_via" "text", "p_employee_id" "uuid" DEFAULT NULL::"uuid", "p_receipt_path" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_cat    text := coalesce(nullif(trim(p_category), ''), 'Other');
  v_via    text := nullif(trim(coalesce(p_paid_via, '')), '');
  v_exp_id text;
  v_id     uuid;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than 0'; end if;
  if coalesce(trim(p_person), '') = '' then raise exception 'Who paid? — person name is required'; end if;
  if coalesce(trim(p_purpose), '') = '' then raise exception 'What was it for? — purpose is required'; end if;

  if p_employee_id is not null then
    perform 1 from public.employees where id = p_employee_id and tenant_id = v_tenant;
    if not found then raise exception 'Employee not found'; end if;
  end if;

  v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int));
  insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
  values (v_exp_id, v_tenant, v_cat, trim(p_person), coalesce(p_incurred_on, current_date), p_amount, greatest(coalesce(p_gst, 0), 0), 'reimbursement',
          'Reimbursement · ' || p_purpose || ' · paid by ' || trim(p_person) || coalesce(' (' || v_via || ')', ''));

  insert into public.reimbursements (tenant_id, person_name, purpose, category, amount, gst_paid, incurred_on, paid_via, employee_id, receipt_path, expense_id, created_by)
  values (v_tenant, trim(p_person), trim(p_purpose), v_cat, p_amount, greatest(coalesce(p_gst, 0), 0), coalesce(p_incurred_on, current_date), v_via,
          p_employee_id, nullif(trim(coalesce(p_receipt_path, '')), ''), v_exp_id, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;


ALTER FUNCTION "public"."add_reimbursement"("p_person" "text", "p_purpose" "text", "p_category" "text", "p_amount" integer, "p_gst" integer, "p_incurred_on" "date", "p_paid_via" "text", "p_employee_id" "uuid", "p_receipt_path" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."approve_expense_claim"("p_claim_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant      uuid := public.current_tenant_id();
  v_claim       public.expense_claims;
  v_loan        public.employee_loans;
  v_paid        integer;
  v_outstanding integer;
  v_exp_id      text;
begin
  select * into v_claim from public.expense_claims
    where id = p_claim_id and tenant_id = v_tenant;
  if not found then raise exception 'Claim not found'; end if;
  if v_claim.status <> 'pending' then raise exception 'This claim is already %', v_claim.status; end if;

  select * into v_loan from public.employee_loans
    where id = v_claim.loan_id and tenant_id = v_tenant;
  if not found then raise exception 'The advance for this claim no longer exists'; end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.employee_loan_repayments where loan_id = v_loan.id;
  v_outstanding := v_loan.principal - v_paid;
  if v_claim.amount > v_outstanding then
    raise exception 'Claim (%) now exceeds the remaining advance (%)', v_claim.amount, v_outstanding;
  end if;

  v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint))
                     || '-' || upper(to_hex((random() * 255)::int));
  insert into public.expenses
    (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
  values
    (v_exp_id, v_tenant, v_claim.category, v_loan.employee_name, v_claim.spent_on, v_claim.amount, 0, 'advance',
     coalesce(v_claim.purpose, 'Expense claim') || ' (claimed by ' || v_loan.employee_name || ')');

  insert into public.employee_loan_repayments
    (tenant_id, loan_id, amount, repaid_on, method, bank_account_id, expense_id, notes)
  values
    (v_tenant, v_loan.id, v_claim.amount, v_claim.spent_on, 'expense', null, v_exp_id, v_claim.purpose);

  update public.employee_loans
     set status     = case when (v_outstanding - v_claim.amount) <= 0 then 'closed' else 'active' end,
         updated_at = now()
   where id = v_loan.id;

  update public.expense_claims
     set status = 'approved', expense_id = v_exp_id, reviewed_at = now()
   where id = p_claim_id;
end;
$$;


ALTER FUNCTION "public"."approve_expense_claim"("p_claim_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assign_customer_number"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if new.customer_number is null or new.customer_number = '' then
    new.customer_number := public.next_customer_number(new.tenant_id);
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."assign_customer_number"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."auto_backup_if_stale"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_tenant uuid; v_role text; v_last timestamptz;
begin
  select tenant_id, role into v_tenant, v_role from public.users where id = auth.uid();
  if v_tenant is null or coalesce(v_role,'') <> 'owner' then return jsonb_build_object('created', false); end if;
  select max(created_at) into v_last from backup.snapshots where tenant_id = v_tenant;
  if v_last is not null and v_last > now() - interval '20 hours' then
    return jsonb_build_object('created', false);
  end if;
  perform backup._take(v_tenant, 'Auto (daily)', 'auto');
  return jsonb_build_object('created', true);
end $$;


ALTER FUNCTION "public"."auto_backup_if_stale"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."backup_all_tenants"("p_label" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  t          record;
  v_snap     jsonb;
  v_label    text := coalesce(nullif(btrim(p_label), ''),
                              'Automated Daily Backup - ' || to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD'));
  v_ok       int := 0;
  v_failed   int := 0;
  v_bytes    bigint := 0;
  v_results  jsonb := '[]'::jsonb;
begin
  for t in select id, name from public.tenants order by created_at loop
    /* Per-tenant exception handling on purpose: one tenant with a corrupt row
       must not cost every OTHER tenant its nightly backup. A sweep that aborts
       halfway is worse than one that reports a partial failure, because the
       tenants it never reached look protected and are not. */
    begin
      v_snap  := backup._take(t.id, v_label, 'auto');
      v_ok    := v_ok + 1;
      v_bytes := v_bytes + coalesce((v_snap->>'bytes')::bigint, 0);
      v_results := v_results || jsonb_build_object(
        'tenant', t.name, 'ok', true,
        'bytes', (v_snap->>'bytes')::bigint,
        'tables', (v_snap->>'table_count')::int);
    exception when others then
      v_failed  := v_failed + 1;
      v_results := v_results || jsonb_build_object('tenant', t.name, 'ok', false, 'error', sqlerrm);
    end;
  end loop;

  return jsonb_build_object(
    'label', v_label, 'ok', v_ok, 'failed', v_failed,
    'total_bytes', v_bytes, 'results', v_results);
end $$;


ALTER FUNCTION "public"."backup_all_tenants"("p_label" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."backup_all_tenants"("p_label" "text") IS 'Nightly sweep: one snapshot per tenant. service_role ONLY — it is the single backup function that is not scoped to the caller''s own tenant. A per-tenant failure is recorded and the sweep continues.';



CREATE OR REPLACE FUNCTION "public"."bank_account_current_balance"("p_account_id" "uuid") RETURNS integer
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce((
           select opening_balance
             from public.bank_accounts
            where id = p_account_id
              and tenant_id = public.current_tenant_id()
         ), 0)
       + coalesce((
           select sum(credit - debit)::int
             from public.bank_transactions
            where bank_account_id = p_account_id
              and tenant_id = public.current_tenant_id()
         ), 0);
$$;


ALTER FUNCTION "public"."bank_account_current_balance"("p_account_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."book_bank_advance"("p_txn_id" "uuid", "p_counterparty" "text", "p_kind" "text" DEFAULT 'given'::"text", "p_notes" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_txn     public.bank_transactions;
  v_amount  int;
  v_section text;
  v_label   text;
  v_party   text;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id and tenant_id = v_tenant;
  if not found then raise exception 'Bank transaction not found'; end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This line is already reconciled';
  end if;

  v_party := nullif(trim(coalesce(p_counterparty, '')), '');

  if p_kind = 'given' then
    v_section := 'asset';
    if coalesce(v_txn.debit, 0) > 0 then
      v_amount := v_txn.debit;
      v_label  := 'Advance/loan given' || coalesce(' · ' || v_party, '');
    elsif coalesce(v_txn.credit, 0) > 0 then
      v_amount := -v_txn.credit;
      v_label  := 'Advance/loan returned' || coalesce(' · ' || v_party, '');
    else
      raise exception 'Transaction has no amount';
    end if;
  elsif p_kind = 'received' then
    v_section := 'liability';
    if coalesce(v_txn.credit, 0) > 0 then
      v_amount := v_txn.credit;
      v_label  := 'Loan received' || coalesce(' · ' || v_party, '');
    elsif coalesce(v_txn.debit, 0) > 0 then
      v_amount := -v_txn.debit;
      v_label  := 'Loan repaid' || coalesce(' · ' || v_party, '');
    else
      raise exception 'Transaction has no amount';
    end if;
  else
    raise exception 'Unknown kind: %', p_kind;
  end if;

  insert into public.balance_sheet_items (tenant_id, section, label, amount, notes, bank_txn_id)
  values (v_tenant, v_section, v_label, v_amount, nullif(trim(coalesce(p_notes, '')), ''), p_txn_id);

  update public.bank_transactions
     set matched_to_type = 'manual', matched_to_id = null,
         matched_at = now(), matched_by = auth.uid(), match_confidence = 'manual',
         updated_at = now()
   where id = p_txn_id;
end;
$$;


ALTER FUNCTION "public"."book_bank_advance"("p_txn_id" "uuid", "p_counterparty" "text", "p_kind" "text", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."book_bank_credit"("p_txn_id" "uuid", "p_kind" "text", "p_label" "text", "p_notes" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_txn     public.bank_transactions;
  v_section text;
  v_label   text;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id and tenant_id = v_tenant;
  if not found then raise exception 'Bank transaction not found'; end if;
  if coalesce(v_txn.credit, 0) <= 0 then
    raise exception 'This is only for money-in (credit) lines';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This line is already reconciled';
  end if;

  v_section := case p_kind
                 when 'capital'       then 'equity'
                 when 'director_loan' then 'liability'
                 else null end;
  if v_section is null then raise exception 'Unknown kind: %', p_kind; end if;

  v_label := coalesce(nullif(trim(p_label), ''),
                      case p_kind when 'capital' then 'Owner''s capital' else 'Director''s loan' end);

  insert into public.balance_sheet_items (tenant_id, section, label, amount, notes, bank_txn_id)
  values (v_tenant, v_section, v_label, v_txn.credit, nullif(trim(coalesce(p_notes, '')), ''), p_txn_id);

  update public.bank_transactions
     set matched_to_type = 'manual', matched_to_id = null,
         matched_at = now(), matched_by = auth.uid(), match_confidence = 'manual',
         updated_at = now()
   where id = p_txn_id;
end;
$$;


ALTER FUNCTION "public"."book_bank_credit"("p_txn_id" "uuid", "p_kind" "text", "p_label" "text", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."book_bank_txn_as_expense"("p_txn_id" "uuid", "p_category" "text", "p_vendor" "text", "p_gst" integer, "p_notes" "text" DEFAULT NULL::"text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn    public.bank_transactions;
  v_exp_id text;
begin
  if trim(coalesce(p_category, '')) = '' then
    raise exception 'Please choose a category';
  end if;
  select * into v_txn from public.bank_transactions
    where id = p_txn_id and tenant_id = v_tenant;
  if not found then raise exception 'Transaction not found'; end if;
  if coalesce(v_txn.debit, 0) <= 0 then
    raise exception 'Only a money-out (debit) line can be booked as an expense';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This line is already reconciled';
  end if;
  v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint))
                     || '-' || upper(to_hex((random() * 255)::int));
  insert into public.expenses
    (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
  values
    (v_exp_id, v_tenant, trim(p_category), nullif(trim(coalesce(p_vendor, '')), ''),
     v_txn.txn_date, v_txn.debit, greatest(coalesce(p_gst, 0), 0), 'bank',
     coalesce(nullif(trim(coalesce(p_notes, '')), ''), v_txn.description));
  update public.bank_transactions
     set matched_to_type = 'expense', matched_to_id = v_exp_id, match_confidence = 'manual'
   where id = p_txn_id and tenant_id = v_tenant;
  return v_exp_id;
end;
$$;


ALTER FUNCTION "public"."book_bank_txn_as_expense"("p_txn_id" "uuid", "p_category" "text", "p_vendor" "text", "p_gst" integer, "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."book_bank_txn_as_statutory"("p_txn_id" "uuid", "p_kind" "text", "p_notes" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn public.bank_transactions;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  select * into v_txn from public.bank_transactions where id = p_txn_id and tenant_id = v_tenant;
  if not found then raise exception 'Bank transaction not found'; end if;
  if v_txn.matched_to_type is not null then raise exception 'This line is already reconciled'; end if;
  if coalesce(v_txn.debit,0) <= 0 then raise exception 'A statutory payment must be a money-out line'; end if;

  insert into public.statutory_dues_payments (tenant_id, kind, amount, paid_on, bank_account_id, notes, bank_txn_id)
  values (v_tenant, coalesce(nullif(p_kind,''),'mixed'), v_txn.debit, v_txn.txn_date, v_txn.bank_account_id,
          nullif(trim(coalesce(p_notes,'')),''), p_txn_id);

  update public.bank_transactions
     set matched_to_type='statutory', matched_to_id=null, match_confidence='manual',
         matched_at=now(), matched_by=auth.uid(), updated_at=now()
   where id = p_txn_id;
end; $$;


ALTER FUNCTION "public"."book_bank_txn_as_statutory"("p_txn_id" "uuid", "p_kind" "text", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."campaign_templates_touch"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin new.updated_at := now(); return new; end;
$$;


ALTER FUNCTION "public"."campaign_templates_touch"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."campaigns_touch_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin new.updated_at := now(); return new; end;
$$;


ALTER FUNCTION "public"."campaigns_touch_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."compute_advance_adjustment"("p_quote_id" "text") RETURNS TABLE("advances" "jsonb", "total_paid" integer, "first_at" timestamp with time zone)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'payment_id', p.id, 'voucher_no', p.receipt_voucher_no,
        'amount', p.amount, 'received_at', p.received_at, 'method', p.method
      ) order by p.received_at
    ), '[]'::jsonb)                  as advances,
    coalesce(sum(p.amount), 0)::integer as total_paid,
    min(p.received_at)               as first_at
  from public.payments p
  where p.quote_id = p_quote_id and p.status = 'received';
$$;


ALTER FUNCTION "public"."compute_advance_adjustment"("p_quote_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."consume_prepaid_advance"("p_advance_id" "uuid", "p_amount" integer, "p_date" "date" DEFAULT CURRENT_DATE, "p_note" "text" DEFAULT NULL::"text", "p_gst" integer DEFAULT 0, "p_attachment" "text" DEFAULT NULL::"text") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid;
  v_adv    public.prepaid_advances;
  v_exp_id text;
  v_new    int;
begin
  select tenant_id into v_tenant from public.users where id = auth.uid();
  if v_tenant is null then raise exception 'No tenant for caller'; end if;
  select * into v_adv from public.prepaid_advances where id = p_advance_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Advance not found'; end if;
  if p_amount <= 0 then raise exception 'Amount must be positive'; end if;
  if p_amount > (v_adv.total_amount - v_adv.consumed_amount) then raise exception 'Amount exceeds remaining balance'; end if;

  v_exp_id := 'EXP-' || upper(substr(md5(gen_random_uuid()::text), 1, 10));
  insert into public.expenses
    (id, tenant_id, category, vendor_name, vendor_id, amount, gst_paid, expense_date, paid, paid_date, bill_type, payment_method, description, notes, attachment_url, prepaid_advance_id)
  values
    (v_exp_id, v_tenant, v_adv.category, v_adv.vendor_name, v_adv.vendor_id, p_amount, greatest(0, coalesce(p_gst,0)), p_date, true, p_date,
     case when coalesce(p_gst,0) > 0 then 'gst' else 'none' end, 'advance',
     'Consumed from ' || v_adv.vendor_name || ' advance', p_note, p_attachment, p_advance_id);

  v_new := v_adv.consumed_amount + p_amount;
  update public.prepaid_advances set consumed_amount = v_new, updated_at = now() where id = p_advance_id;
  return v_adv.total_amount - v_new;
end $$;


ALTER FUNCTION "public"."consume_prepaid_advance"("p_advance_id" "uuid", "p_amount" integer, "p_date" "date", "p_note" "text", "p_gst" integer, "p_attachment" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."contacts_touch"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin new.updated_at := now(); return new; end;
$$;


ALTER FUNCTION "public"."contacts_touch"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."convert_inbound_email_to_lead"("p_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant  uuid := current_tenant_id();
  v_email   public.inbound_emails%rowtype;
  v_lead_id text;
  v_company text;
begin
  if v_tenant is null then
    raise exception 'No tenant context';
  end if;

  select * into v_email
  from public.inbound_emails
  where id = p_id and tenant_id = v_tenant
  for update;

  if not found then
    raise exception 'Inbound email not found';
  end if;

  if v_email.lead_id is not null then
    return v_email.lead_id;
  end if;

  v_company := coalesce(
    nullif(v_email.from_name, ''),
    nullif(split_part(coalesce(v_email.from_email, ''), '@', 2), ''),
    'Email lead'
  );

  v_lead_id := 'L-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000000)::bigint));

  insert into public.leads (id, tenant_id, company, contact_name, contact_email, stage, source, notes)
  values (
    v_lead_id,
    v_tenant,
    v_company,
    nullif(v_email.from_name, ''),
    v_email.from_email,
    'new',
    'email-inbound',
    concat_ws(E'\n',
      'Converted from inbound email.',
      'Subject: ' || coalesce(nullif(v_email.subject, ''), '—'),
      case
        when v_email.body_text is not null and v_email.body_text <> ''
        then E'\n--- original ---\n' || left(v_email.body_text, 2000)
      end
    )
  );

  update public.inbound_emails
  set status = 'lead_created', lead_id = v_lead_id
  where id = p_id and tenant_id = v_tenant;

  return v_lead_id;
end;
$$;


ALTER FUNCTION "public"."convert_inbound_email_to_lead"("p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."coupons_touch"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin new.updated_at := now(); return new; end;
$$;


ALTER FUNCTION "public"."coupons_touch"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_direct_invoice"("p_customer_id" "uuid", "p_line_items" "jsonb", "p_notes" "text" DEFAULT NULL::"text", "p_recurring" boolean DEFAULT false) RETURNS TABLE("invoice_id" "text", "quote_id" "text", "net_payable" integer, "tax_rate" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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

  v_qid := public.next_document_number('quote', v_tenant);
  if v_qid is null then raise exception 'Could not allocate a quote number'; end if;

  insert into public.quotes (
    id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, discount_pct,
    line_items, status, payment_status, is_one_off, created_date, notes
  ) values (
    v_qid, v_tenant, p_customer_id, v_cust.name, v_gross, v_subtotal, v_rate, 0,
    v_lines, 'accepted', 'awaiting', not p_recurring, current_date, p_notes
  );

  select gi.invoice_id, gi.net_payable into v_inv
    from public.generate_invoice(v_qid) gi;

  return query select v_inv.invoice_id, v_qid, v_inv.net_payable, v_rate;
end;
$$;


ALTER FUNCTION "public"."create_direct_invoice"("p_customer_id" "uuid", "p_line_items" "jsonb", "p_notes" "text", "p_recurring" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_project_direct_invoice"("p_customer_id" "uuid", "p_customer_name" "text", "p_title" "text", "p_description" "text", "p_line_items" "jsonb", "p_gst_rate" integer, "p_inter_state" boolean) RETURNS TABLE("invoice_id" "text", "project_id" "uuid")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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

  select id into v_msid from public.project_milestones where project_id = v_pid order by seq limit 1;
  if v_msid is null then raise exception 'Milestone was not created for project %', v_pid; end if;

  v_inv := public.raise_project_milestone_invoice(v_msid);

  return query select v_inv, v_pid;
end;
$$;


ALTER FUNCTION "public"."create_project_direct_invoice"("p_customer_id" "uuid", "p_customer_name" "text", "p_title" "text", "p_description" "text", "p_line_items" "jsonb", "p_gst_rate" integer, "p_inter_state" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_project_quote"("p_customer_id" "uuid", "p_customer_name" "text", "p_title" "text", "p_description" "text", "p_line_items" "jsonb", "p_gst_rate" integer, "p_inter_state" boolean, "p_milestones" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_taxable integer := 0;
  v_gst     integer;
  v_total   integer;
  v_id      uuid;
  v_li      jsonb;
  v_m       jsonb;
  v_seq     integer := 0;
begin
  if v_tenant is null then raise exception 'No tenant in context'; end if;

  for v_li in select * from jsonb_array_elements(coalesce(p_line_items, '[]'::jsonb)) loop
    v_taxable := v_taxable + greatest(coalesce((v_li->>'amount')::integer, 0), 0);
  end loop;
  if v_taxable <= 0 then raise exception 'Quotation needs at least one line item'; end if;

  v_gst   := round(v_taxable * coalesce(p_gst_rate, 18) / 100.0);
  v_total := v_taxable + v_gst;

  insert into public.project_sales
    (tenant_id, customer_id, customer_name, title, description, gst_rate, inter_state,
     taxable_amount, gst_amount, total_amount, status, line_items)
  values
    (v_tenant, p_customer_id, p_customer_name, p_title, nullif(trim(coalesce(p_description,'')),''),
     coalesce(p_gst_rate, 18), coalesce(p_inter_state, false),
     v_taxable, v_gst, v_total, 'quoted', coalesce(p_line_items, '[]'::jsonb))
  returning id into v_id;

  for v_m in select * from jsonb_array_elements(coalesce(p_milestones, '[]'::jsonb)) loop
    v_seq := v_seq + 1;
    insert into public.project_milestones (tenant_id, project_id, seq, label, total_amount, due_date)
    values (
      v_tenant, v_id, v_seq,
      coalesce(v_m->>'label', 'Milestone ' || v_seq),
      greatest(coalesce((v_m->>'total_amount')::integer, 0), 0),
      nullif(v_m->>'due_date','')::date
    );
  end loop;

  return v_id;
end;
$$;


ALTER FUNCTION "public"."create_project_quote"("p_customer_id" "uuid", "p_customer_name" "text", "p_title" "text", "p_description" "text", "p_line_items" "jsonb", "p_gst_rate" integer, "p_inter_state" boolean, "p_milestones" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_project_sale"("p_customer_id" "uuid", "p_customer_name" "text", "p_title" "text", "p_description" "text", "p_taxable" integer, "p_gst_rate" integer, "p_inter_state" boolean, "p_milestones" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_gst    integer;
  v_total  integer;
  v_id     uuid;
  v_cust   uuid := p_customer_id;
  v_m      jsonb;
  v_seq    integer := 0;
begin
  if v_tenant is null then raise exception 'No tenant in context'; end if;
  if coalesce(p_taxable, 0) <= 0 then raise exception 'Taxable amount must be > 0'; end if;

  if v_cust is null and length(trim(coalesce(p_customer_name, ''))) > 0 then
    select id into v_cust from public.customers
     where tenant_id = v_tenant and lower(name) = lower(trim(p_customer_name)) limit 1;
    if v_cust is null then
      insert into public.customers (tenant_id, name, since, health)
      values (v_tenant, trim(p_customer_name), current_date, 70)
      returning id into v_cust;
    end if;
  end if;

  v_gst   := round(p_taxable * coalesce(p_gst_rate, 18) / 100.0);
  v_total := p_taxable + v_gst;

  insert into public.project_sales
    (tenant_id, customer_id, customer_name, title, description, gst_rate, inter_state,
     taxable_amount, gst_amount, total_amount)
  values
    (v_tenant, v_cust, p_customer_name, p_title, nullif(trim(coalesce(p_description,'')),''),
     coalesce(p_gst_rate, 18), coalesce(p_inter_state, false), p_taxable, v_gst, v_total)
  returning id into v_id;

  for v_m in select * from jsonb_array_elements(coalesce(p_milestones, '[]'::jsonb))
  loop
    v_seq := v_seq + 1;
    insert into public.project_milestones (tenant_id, project_id, seq, label, total_amount, due_date)
    values (
      v_tenant, v_id, v_seq,
      coalesce(v_m->>'label', 'Milestone ' || v_seq),
      greatest(coalesce((v_m->>'total_amount')::integer, 0), 0),
      nullif(v_m->>'due_date','')::date
    );
  end loop;

  return v_id;
end;
$$;


ALTER FUNCTION "public"."create_project_sale"("p_customer_id" "uuid", "p_customer_name" "text", "p_title" "text", "p_description" "text", "p_taxable" integer, "p_gst_rate" integer, "p_inter_state" boolean, "p_milestones" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_site_promo"("p_tenant_id" "uuid", "p_headline" "text", "p_subheadline" "text", "p_badge_text" "text", "p_discount_type" "text", "p_discount_value" integer, "p_applies_to_tier" "text", "p_min_seats" integer, "p_max_seats" integer, "p_banner_style" "text", "p_valid_until" timestamp with time zone, "p_created_by" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_id text;
begin
  v_id := 'SP-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
  insert into site_promos (
    id, tenant_id, headline, subheadline, badge_text,
    discount_type, discount_value,
    applies_to_tier, min_seats, max_seats,
    banner_style, valid_until, created_by
  ) values (
    v_id, p_tenant_id, p_headline, p_subheadline, p_badge_text,
    p_discount_type, p_discount_value,
    p_applies_to_tier, coalesce(p_min_seats, 1), p_max_seats,
    coalesce(p_banner_style, 'amber'), p_valid_until, p_created_by
  );
  return v_id;
end;
$$;


ALTER FUNCTION "public"."create_site_promo"("p_tenant_id" "uuid", "p_headline" "text", "p_subheadline" "text", "p_badge_text" "text", "p_discount_type" "text", "p_discount_value" integer, "p_applies_to_tier" "text", "p_min_seats" integer, "p_max_seats" integer, "p_banner_style" "text", "p_valid_until" timestamp with time zone, "p_created_by" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_tenant_backup"("p_label" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_tenant uuid; v_role text;
begin
  select tenant_id, role into v_tenant, v_role from public.users where id = auth.uid();
  if v_tenant is null then raise exception 'No tenant for caller'; end if;
  if coalesce(v_role, '') <> 'owner' then raise exception 'Only the owner can take a backup'; end if;
  return backup._take(v_tenant, coalesce(p_label, 'Manual backup'), 'manual');
end $$;


ALTER FUNCTION "public"."create_tenant_backup"("p_label" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_customer_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select customer_id
  from public.customer_users
  where auth_user_id = auth.uid()
  limit 1
$$;


ALTER FUNCTION "public"."current_customer_id"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."current_customer_id"() IS 'Returns the customer_id for the logged-in auth user (customer-portal side). NULL for reseller users.';



CREATE OR REPLACE FUNCTION "public"."current_tenant_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select tenant_id from public.users where id = auth.uid() limit 1;
$$;


ALTER FUNCTION "public"."current_tenant_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."default_doc_prefix"("p_doc_type" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select case p_doc_type
    when 'invoice'         then 'INV'
    when 'receipt_voucher' then 'RV'
    when 'refund_voucher'  then 'RFV'
    when 'credit_note'     then 'CN'
    when 'debit_note'      then 'DN'
    when 'quote'           then 'Q'
    when 'purchase_order'  then 'PO'
    when 'campaign'        then 'CAMP'
    else upper(p_doc_type)
  end;
$$;


ALTER FUNCTION "public"."default_doc_prefix"("p_doc_type" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_bank_account"("p_account_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  perform 1 from public.bank_accounts
    where id = p_account_id and tenant_id = v_tenant;
  if not found then
    raise exception 'Bank account not found';
  end if;

  delete from public.bank_accounts
    where id = p_account_id and tenant_id = v_tenant;
end;
$$;


ALTER FUNCTION "public"."delete_bank_account"("p_account_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_business_loan"("p_loan_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_l      public.business_loans;
  v_pays   integer;
begin
  select * into v_l from public.business_loans where id = p_loan_id and tenant_id = v_tenant;
  if not found then raise exception 'Loan not found'; end if;

  select count(*) into v_pays from public.business_loan_payments where loan_id = p_loan_id;
  if v_pays > 0 then
    raise exception 'This loan has % EMI payment(s) recorded — delete those first', v_pays;
  end if;

  if v_l.deposit_account_id is not null then
    delete from public.bank_transactions
     where tenant_id = v_tenant
       and bank_account_id = v_l.deposit_account_id
       and txn_date = v_l.disbursed_on
       and credit = v_l.principal
       and description = 'Loan received: ' || v_l.lender;
  end if;

  delete from public.business_loans where id = p_loan_id;
end;
$$;


ALTER FUNCTION "public"."delete_business_loan"("p_loan_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_claim_public"("p_tenant_id" "uuid", "p_employee_id" "uuid", "p_pin" "text", "p_claim_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
declare v_emp public.employees; v_claim public.expense_claims;
begin
  select * into v_emp from public.employees where id = p_employee_id and tenant_id = p_tenant_id;
  if not found then raise exception 'Employee not found'; end if;
  if p_pin is null or v_emp.pin_hash is null or crypt(p_pin, v_emp.pin_hash) <> v_emp.pin_hash then raise exception 'Wrong PIN'; end if;
  select * into v_claim from public.expense_claims where id = p_claim_id and tenant_id = p_tenant_id and employee_id = p_employee_id;
  if not found then raise exception 'Claim not found'; end if;
  if v_claim.status <> 'pending' then raise exception 'This claim can no longer be removed'; end if;
  delete from public.expense_claims where id = p_claim_id;
end; $$;


ALTER FUNCTION "public"."delete_claim_public"("p_tenant_id" "uuid", "p_employee_id" "uuid", "p_pin" "text", "p_claim_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_customer"("p_customer_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant      uuid;
  v_caller      uuid;
  v_is_service  boolean;
  v_subs        integer;
  v_pays        integer;
  v_invs        integer;
  v_quotes      integer;
  v_projs       integer;
  v_name        text;
  v_parts       text[] := array[]::text[];
begin
  v_is_service := auth.role() = 'service_role';

  select tenant_id, name into v_tenant, v_name
    from public.customers where id = p_customer_id;
  if not found then
    raise exception 'customer % not found', p_customer_id;
  end if;

  if not v_is_service then
    v_caller := public.current_tenant_id();
    if v_caller is null or v_caller <> v_tenant then
      raise exception 'customer % does not belong to your tenant', p_customer_id;
    end if;
  end if;

  select count(*) into v_subs   from public.subscriptions where customer_id = p_customer_id;
  select count(*) into v_pays   from public.payments      where customer_id = p_customer_id;
  select count(*) into v_invs   from public.invoices      where customer_id = p_customer_id;
  select count(*) into v_quotes from public.quotes        where customer_id = p_customer_id;
  select count(*) into v_projs  from public.project_sales where customer_id = p_customer_id;

  if v_subs   > 0 then v_parts := v_parts || format('%s subscription(s)', v_subs); end if;
  if v_pays   > 0 then v_parts := v_parts || format('%s payment(s)',      v_pays);  end if;
  if v_invs   > 0 then v_parts := v_parts || format('%s invoice(s)',      v_invs);  end if;
  if v_quotes > 0 then v_parts := v_parts || format('%s quote(s)',        v_quotes);end if;
  if v_projs  > 0 then v_parts := v_parts || format('%s project(s)',      v_projs); end if;

  if array_length(v_parts, 1) is not null then
    raise exception
      'Cannot delete customer "%": has %. Delete those first, or archive the customer instead.',
      v_name, array_to_string(v_parts, ', ');
  end if;

  delete from public.customers where id = p_customer_id and tenant_id = v_tenant;

  return jsonb_build_object('deleted', true, 'customer_id', p_customer_id);
end;
$$;


ALTER FUNCTION "public"."delete_customer"("p_customer_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_employee_loan"("p_loan_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_loan   public.employee_loans;
  v_paid   integer;
begin
  select * into v_loan from public.employee_loans where id = p_loan_id and tenant_id = v_tenant;
  if not found then raise exception 'Loan not found'; end if;

  select coalesce(sum(amount), 0) into v_paid from public.employee_loan_repayments where loan_id = p_loan_id;
  if v_paid > 0 then
    raise exception 'This loan already has repayments/settlements - reverse those first before deleting.';
  end if;

  if v_loan.bank_account_id is not null then
    insert into public.bank_transactions
      (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
    values
      (v_tenant, v_loan.bank_account_id, (now() at time zone 'Asia/Kolkata')::date,
       'Correction: reversed loan/advance to ' || v_loan.employee_name, 0, v_loan.principal, 'manual', 'manual', 'manual');
  end if;

  delete from public.employee_loans where id = p_loan_id;
end;
$$;


ALTER FUNCTION "public"."delete_employee_loan"("p_loan_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_expense_claim"("p_claim_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_tenant uuid := public.current_tenant_id(); v_status text;
begin
  select status into v_status from public.expense_claims where id = p_claim_id and tenant_id = v_tenant;
  if not found then raise exception 'Claim not found'; end if;
  if v_status <> 'pending' then raise exception 'Only pending claims can be deleted'; end if;
  delete from public.expense_claims where id = p_claim_id and tenant_id = v_tenant;
end; $$;


ALTER FUNCTION "public"."delete_expense_claim"("p_claim_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_payment"("p_payment_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_pay      record;
  v_quote    record;
  v_remaining integer;
  v_expected  integer;
  v_new_status public.payment_status;
  v_subs_removed int := 0;
  v_pos_removed  int := 0;
  v_bank_cnt int;
  v_bad_po   int;
begin
  select * into v_pay from public.payments where id = p_payment_id;
  if not found then raise exception 'Payment not found'; end if;
  if v_tenant is not null and v_pay.tenant_id is distinct from v_tenant then
    raise exception 'Payment not in your tenant' using errcode = 'insufficient_privilege';
  end if;

  select id, tenant_id, amount, invoice_id, is_add_seats, lead_id, customer_id, customer_name, status
    into v_quote from public.quotes where id = v_pay.quote_id;

  if v_quote.invoice_id is not null then
    raise exception 'A GST invoice is already generated for this quote — cancel / credit-note that invoice before deleting the payment.'
      using errcode = 'invalid_parameter_value';
  end if;

  select count(*) into v_bank_cnt from public.bank_transactions
   where tenant_id = v_pay.tenant_id and matched_to_type = 'payment' and matched_to_id = v_pay.id::text;
  if v_bank_cnt > 0 then
    raise exception 'This payment is reconciled to a bank transaction — un-reconcile that bank line first, then delete.'
      using errcode = 'invalid_parameter_value';
  end if;

  if coalesce(v_quote.is_add_seats, false) then
    if exists (
      select 1 from public.subscriptions s
       where s.tenant_id = v_pay.tenant_id
         and ( (v_quote.customer_id is not null and s.customer_id = v_quote.customer_id)
            or (v_quote.customer_id is null and s.customer_name = v_quote.customer_name) )
    ) then
      raise exception 'This is an add-seats payment — adjust it from the subscription (reduce seats), not by deleting here.'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  delete from public.payments where id = p_payment_id;

  select coalesce(sum(amount), 0) into v_remaining
    from public.payments where quote_id = v_pay.quote_id and status = 'received';
  v_expected := coalesce(v_quote.amount, 0);

  v_new_status := case
    when v_remaining <= 0            then 'none'
    when v_remaining >= v_expected   then 'received'
    else                                  'partial' end::public.payment_status;

  update public.quotes
     set payment_status      = v_new_status,
         payment_amount      = v_remaining,
         payment_method      = case when v_remaining <= 0 then null else payment_method end,
         payment_reference   = case when v_remaining <= 0 then null else payment_reference end,
         payment_received_at = case when v_remaining <= 0 then null else payment_received_at end,
         payment_notes       = case when v_remaining <= 0 then null else payment_notes end,
         status              = case when v_remaining <= 0 and status = 'accepted'
                                    then 'sent'::public.quote_status else status end
   where id = v_pay.quote_id and tenant_id = v_pay.tenant_id;

  if v_remaining <= 0 then
    select count(*) into v_bad_po
      from public.purchase_orders po
      join public.subscriptions s on s.id = po.subscription_id
     where s.tenant_id = v_pay.tenant_id and s.quote_id = v_pay.quote_id and po.status <> 'draft';
    if v_bad_po > 0 then
      raise exception 'A purchase order from this sale is already processed — handle it manually before deleting the payment.'
        using errcode = 'invalid_parameter_value';
    end if;

    with subs as (
      select id from public.subscriptions where tenant_id = v_pay.tenant_id and quote_id = v_pay.quote_id
    )
    delete from public.purchase_orders po using subs where po.subscription_id = subs.id;
    get diagnostics v_pos_removed = row_count;

    delete from public.subscriptions where tenant_id = v_pay.tenant_id and quote_id = v_pay.quote_id;
    get diagnostics v_subs_removed = row_count;

    if v_quote.lead_id is not null then
      update public.leads set stage = 'quote', trial_converted_at = null
       where id = v_quote.lead_id and tenant_id = v_pay.tenant_id and stage = 'won';
    end if;
  else
    update public.subscriptions set outstanding_amount = greatest(0, v_expected - v_remaining)
     where tenant_id = v_pay.tenant_id and quote_id = v_pay.quote_id;
  end if;

  return jsonb_build_object(
    'deleted', true, 'quote_id', v_pay.quote_id, 'amount', v_pay.amount,
    'remaining', v_remaining, 'new_payment_status', v_new_status,
    'subscriptions_removed', v_subs_removed, 'purchase_orders_removed', v_pos_removed
  );
end;
$$;


ALTER FUNCTION "public"."delete_payment"("p_payment_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_project_invoice"("p_invoice_id" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_inv     public.invoices;
  v_ms_ids  uuid[];
begin
  select * into v_inv from public.invoices where id = p_invoice_id;
  if not found then raise exception 'Invoice not found'; end if;
  if v_tenant is not null and v_inv.tenant_id is distinct from v_tenant then
    raise exception 'Invoice not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  select array_agg(id) into v_ms_ids
    from public.project_milestones
   where invoice_id = p_invoice_id and tenant_id = v_inv.tenant_id;

  if v_ms_ids is null then
    raise exception 'Not a project invoice (nothing references it) — cannot delete here'
      using errcode = 'invalid_parameter_value';
  end if;

  update public.bank_transactions b
     set matched_to_type = null, matched_to_id = null, matched_at = null, match_confidence = null
   where b.tenant_id = v_inv.tenant_id
     and b.matched_to_type = 'project'
     and b.matched_to_id in (
       select p.id::text from public.project_payments p where p.milestone_id = any (v_ms_ids)
     );

  delete from public.project_payments where milestone_id = any (v_ms_ids);

  update public.project_milestones
     set invoice_id = null, status = 'pending'
   where id = any (v_ms_ids);

  delete from public.invoices where id = p_invoice_id;
end;
$$;


ALTER FUNCTION "public"."delete_project_invoice"("p_invoice_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_project_sale"("p_project_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_proj   public.project_sales;
begin
  select * into v_proj from public.project_sales where id = p_project_id;
  if not found then raise exception 'Project not found'; end if;
  if v_tenant is not null and v_proj.tenant_id is distinct from v_tenant then
    raise exception 'Not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.project_milestones where project_id = p_project_id and invoice_id is not null) then
    raise exception 'Can''t delete — a milestone is invoiced. Delete that invoice first.'
      using errcode = 'invalid_parameter_value';
  end if;

  update public.bank_transactions b
     set matched_to_type = null, matched_to_id = null, matched_at = null, match_confidence = null
   where b.tenant_id = v_proj.tenant_id and b.matched_to_type = 'project'
     and b.matched_to_id in (select p.id::text from public.project_payments p where p.project_id = p_project_id);

  delete from public.project_sales where id = p_project_id;
end;
$$;


ALTER FUNCTION "public"."delete_project_sale"("p_project_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_reimbursement"("p_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_r      public.reimbursements;
begin
  select * into v_r from public.reimbursements where id = p_id;
  if not found then raise exception 'Reimbursement not found'; end if;
  if v_tenant is not null and v_r.tenant_id is distinct from v_tenant then
    raise exception 'Not in your tenant' using errcode = 'insufficient_privilege';
  end if;
  delete from public.reimbursements where id = p_id;
  if v_r.expense_id is not null then
    delete from public.expenses where id = v_r.expense_id and tenant_id = v_r.tenant_id and reconciled_txn_id is null;
  end if;
end;
$$;


ALTER FUNCTION "public"."delete_reimbursement"("p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_salary_payment"("p_salary_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_sp     public.salary_payments;
begin
  select * into v_sp from public.salary_payments where id = p_salary_id;
  if not found then raise exception 'Salary payment not found'; end if;
  if v_tenant is not null and v_sp.tenant_id is distinct from v_tenant then
    raise exception 'Salary payment not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  if v_sp.paid_amount > 0 then
    raise exception 'This salary has % reconciled against it — un-reconcile that bank line first, then undo.', v_sp.paid_amount
      using errcode = 'invalid_parameter_value';
  end if;

  if v_sp.advance_recovered > 0 and v_sp.advance_loan_id is not null then
    delete from public.employee_loan_repayments
     where tenant_id = v_sp.tenant_id and loan_id = v_sp.advance_loan_id
       and method = 'salary_deduction' and amount = v_sp.advance_recovered
       and repaid_on = v_sp.pay_date and notes = 'Recovered from salary ' || v_sp.period;
    update public.employee_loans set status = 'active', updated_at = now()
     where id = v_sp.advance_loan_id;
  end if;

  delete from public.salary_payments where id = p_salary_id;

  if v_sp.expense_id is not null then
    delete from public.expenses where id = v_sp.expense_id and tenant_id = v_sp.tenant_id;
  end if;
end;
$$;


ALTER FUNCTION "public"."delete_salary_payment"("p_salary_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_subscription"("p_subscription_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_sub    record;
  v_paid_cnt int;
  v_bad_po   int;
  v_pos_removed int := 0;
begin
  select * into v_sub from public.subscriptions where id = p_subscription_id;
  if not found then raise exception 'Subscription not found'; end if;
  if v_tenant is not null and v_sub.tenant_id is distinct from v_tenant then
    raise exception 'Subscription not in your tenant' using errcode = 'insufficient_privilege';
  end if;

  if v_sub.quote_id is not null then
    select count(*) into v_paid_cnt from public.payments
     where tenant_id = v_sub.tenant_id and quote_id = v_sub.quote_id and status = 'received';
    if v_paid_cnt > 0 then
      raise exception 'This subscription came from a paid quote — delete that payment in Payments instead; it removes this subscription cleanly.'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  select count(*) into v_bad_po from public.purchase_orders
   where tenant_id = v_sub.tenant_id and subscription_id = p_subscription_id and status <> 'draft';
  if v_bad_po > 0 then
    raise exception 'A purchase order linked to this subscription is already processed — handle it manually first.'
      using errcode = 'invalid_parameter_value';
  end if;

  delete from public.purchase_orders
   where tenant_id = v_sub.tenant_id and subscription_id = p_subscription_id;
  get diagnostics v_pos_removed = row_count;

  delete from public.subscriptions where id = p_subscription_id;

  return jsonb_build_object('deleted', true, 'purchase_orders_removed', v_pos_removed);
end;
$$;


ALTER FUNCTION "public"."delete_subscription"("p_subscription_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_subscription_invoice"("p_invoice_id" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_inv    public.invoices;
  v_paid   integer;
  v_status payment_status;
begin
  select * into v_inv from public.invoices where id = p_invoice_id;
  if not found then raise exception 'Invoice not found'; end if;
  if v_tenant is not null and v_inv.tenant_id is distinct from v_tenant then
    raise exception 'Invoice not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  if exists (select 1 from public.project_milestones where invoice_id = p_invoice_id) then
    raise exception 'This is a project invoice — delete it from the project flow'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_inv.quote_id is not null then
    select coalesce(sum(amount), 0) into v_paid
      from public.payments
     where quote_id = v_inv.quote_id and status = 'received';

    v_status := (case
      when v_paid >= coalesce(v_inv.amount, 0) and v_paid > 0 then 'received'
      when v_paid > 0                                         then 'partial'
      else 'none'
    end)::payment_status;

    update public.quotes
       set invoice_id = null, payment_status = v_status
     where id = v_inv.quote_id and tenant_id = v_inv.tenant_id;
  end if;

  delete from public.invoices where id = p_invoice_id;
end;
$$;


ALTER FUNCTION "public"."delete_subscription_invoice"("p_invoice_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_tenant_backup"("p_id" "uuid") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  delete from backup.snapshots
  where id = p_id and tenant_id = (select tenant_id from public.users where id = auth.uid());
$$;


ALTER FUNCTION "public"."delete_tenant_backup"("p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."disburse_employee_loan"("p_employee_name" "text", "p_principal" integer, "p_disbursed_on" "date", "p_bank_account_id" "uuid", "p_kind" "text" DEFAULT 'loan'::"text", "p_notes" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_loan   uuid;
  v_acct   text;
  v_kind   text := coalesce(nullif(trim(p_kind), ''), 'loan');
begin
  if p_principal is null or p_principal <= 0 then
    raise exception 'Amount must be positive';
  end if;
  if trim(coalesce(p_employee_name, '')) = '' then
    raise exception 'Employee name is required';
  end if;
  if v_kind not in ('loan', 'salary_advance', 'expense_advance') then
    raise exception 'Invalid kind';
  end if;

  select name into v_acct from public.bank_accounts
    where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Source account not found'; end if;

  insert into public.employee_loans
    (tenant_id, employee_name, principal, disbursed_on, bank_account_id, kind, notes, created_by)
  values
    (v_tenant, trim(p_employee_name), p_principal, p_disbursed_on, p_bank_account_id, v_kind,
     nullif(trim(coalesce(p_notes, '')), ''), auth.uid())
  returning id into v_loan;

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
  values
    (v_tenant, p_bank_account_id, p_disbursed_on,
     case v_kind when 'expense_advance' then 'Expense advance to ' else 'Loan/advance to ' end || trim(p_employee_name),
     p_principal, 0, 'manual', 'manual', 'manual');

  return v_loan;
end;
$$;


ALTER FUNCTION "public"."disburse_employee_loan"("p_employee_name" "text", "p_principal" integer, "p_disbursed_on" "date", "p_bank_account_id" "uuid", "p_kind" "text", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."edit_claim_public"("p_tenant_id" "uuid", "p_employee_id" "uuid", "p_pin" "text", "p_claim_id" "uuid", "p_amount" integer, "p_category" "text", "p_purpose" "text", "p_spent_on" "date") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
declare
  v_emp public.employees; v_claim public.expense_claims; v_loan public.employee_loans;
  v_paid integer; v_pending integer; v_available integer;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be more than zero'; end if;
  if trim(coalesce(p_category, '')) = '' then raise exception 'Please choose a category'; end if;
  select * into v_emp from public.employees where id = p_employee_id and tenant_id = p_tenant_id;
  if not found then raise exception 'Employee not found'; end if;
  if p_pin is null or v_emp.pin_hash is null or crypt(p_pin, v_emp.pin_hash) <> v_emp.pin_hash then raise exception 'Wrong PIN'; end if;
  select * into v_claim from public.expense_claims where id = p_claim_id and tenant_id = p_tenant_id and employee_id = p_employee_id;
  if not found then raise exception 'Claim not found'; end if;
  if v_claim.status <> 'pending' then raise exception 'This claim can no longer be changed'; end if;
  select * into v_loan from public.employee_loans where id = v_claim.loan_id;
  select coalesce(sum(amount), 0) into v_paid from public.employee_loan_repayments where loan_id = v_loan.id;
  select coalesce(sum(amount), 0) into v_pending from public.expense_claims where loan_id = v_loan.id and status = 'pending' and id <> p_claim_id;
  v_available := v_loan.principal - v_paid - v_pending;
  if p_amount > v_available then raise exception 'Amount (%) is more than your remaining advance (%)', p_amount, v_available; end if;
  update public.expense_claims set amount = p_amount, category = trim(p_category),
     purpose = nullif(trim(coalesce(p_purpose, '')), ''), spent_on = coalesce(p_spent_on, spent_on)
   where id = p_claim_id;
end; $$;


ALTER FUNCTION "public"."edit_claim_public"("p_tenant_id" "uuid", "p_employee_id" "uuid", "p_pin" "text", "p_claim_id" "uuid", "p_amount" integer, "p_category" "text", "p_purpose" "text", "p_spent_on" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."edit_employee_loan"("p_loan_id" "uuid", "p_employee_name" "text", "p_principal" integer, "p_disbursed_on" "date", "p_bank_account_id" "uuid", "p_kind" "text", "p_notes" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_loan   public.employee_loans;
  v_paid   integer;
  v_kind   text := coalesce(nullif(trim(p_kind), ''), 'loan');
  v_name   text := trim(coalesce(p_employee_name, ''));
begin
  if p_principal is null or p_principal <= 0 then raise exception 'Amount must be positive'; end if;
  if v_name = '' then raise exception 'Employee name is required'; end if;
  if v_kind not in ('loan', 'salary_advance', 'expense_advance') then raise exception 'Invalid kind'; end if;

  select * into v_loan from public.employee_loans where id = p_loan_id and tenant_id = v_tenant;
  if not found then raise exception 'Loan not found'; end if;

  select coalesce(sum(amount), 0) into v_paid from public.employee_loan_repayments where loan_id = p_loan_id;
  if v_paid > 0 then
    raise exception 'This loan already has repayments/settlements - reverse those first before editing.';
  end if;

  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Source account not found'; end if;

  if p_principal <> v_loan.principal or p_bank_account_id is distinct from v_loan.bank_account_id then
    if v_loan.bank_account_id is not null then
      insert into public.bank_transactions
        (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
      values
        (v_tenant, v_loan.bank_account_id, (now() at time zone 'Asia/Kolkata')::date,
         'Correction: reversed loan/advance to ' || v_loan.employee_name, 0, v_loan.principal, 'manual', 'manual', 'manual');
    end if;
    insert into public.bank_transactions
      (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
    values
      (v_tenant, p_bank_account_id, p_disbursed_on,
       case v_kind when 'expense_advance' then 'Expense advance to ' else 'Loan/advance to ' end || v_name || ' (edited)',
       p_principal, 0, 'manual', 'manual', 'manual');
  end if;

  update public.employee_loans
     set employee_name   = v_name,
         principal       = p_principal,
         disbursed_on    = p_disbursed_on,
         bank_account_id = p_bank_account_id,
         kind            = v_kind,
         notes           = nullif(trim(coalesce(p_notes, '')), ''),
         updated_at      = now()
   where id = p_loan_id;
end;
$$;


ALTER FUNCTION "public"."edit_employee_loan"("p_loan_id" "uuid", "p_employee_name" "text", "p_principal" integer, "p_disbursed_on" "date", "p_bank_account_id" "uuid", "p_kind" "text", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."edit_expense_claim"("p_claim_id" "uuid", "p_amount" integer, "p_category" "text", "p_purpose" "text", "p_spent_on" "date") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_claim public.expense_claims; v_loan public.employee_loans;
  v_paid integer; v_pending integer; v_available integer;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be more than zero'; end if;
  if trim(coalesce(p_category, '')) = '' then raise exception 'Please choose a category'; end if;
  select * into v_claim from public.expense_claims where id = p_claim_id and tenant_id = v_tenant;
  if not found then raise exception 'Claim not found'; end if;
  if v_claim.status <> 'pending' then raise exception 'Only pending claims can be edited'; end if;
  select * into v_loan from public.employee_loans where id = v_claim.loan_id and tenant_id = v_tenant;
  if not found then raise exception 'The advance for this claim no longer exists'; end if;
  select coalesce(sum(amount), 0) into v_paid from public.employee_loan_repayments where loan_id = v_loan.id;
  select coalesce(sum(amount), 0) into v_pending from public.expense_claims where loan_id = v_loan.id and status = 'pending' and id <> p_claim_id;
  v_available := v_loan.principal - v_paid - v_pending;
  if p_amount > v_available then raise exception 'Amount (%) is more than what is still claimable (%)', p_amount, v_available; end if;
  update public.expense_claims set amount = p_amount, category = trim(p_category),
     purpose = nullif(trim(coalesce(p_purpose, '')), ''), spent_on = coalesce(p_spent_on, spent_on)
   where id = p_claim_id and tenant_id = v_tenant;
end; $$;


ALTER FUNCTION "public"."edit_expense_claim"("p_claim_id" "uuid", "p_amount" integer, "p_category" "text", "p_purpose" "text", "p_spent_on" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_accrue_referral_commission"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_agr     public.referral_agreements%rowtype;
  v_taxrate numeric;
  v_base    integer;
  v_rate    numeric;
  v_gross   integer;
  v_tds     integer;
  v_exists  boolean;
begin
  if new.status is distinct from 'received' or new.refunded_at is not null or new.customer_id is null then
    return new;
  end if;

  begin
    select * into v_agr
    from public.referral_agreements
    where tenant_id = new.tenant_id
      and customer_id = new.customer_id
      and status = 'active'
    limit 1;
    if not found then
      return new;
    end if;

    if v_agr.scope = 'one_time' then
      select exists(
        select 1 from public.referral_commissions
        where agreement_id = v_agr.id and status <> 'cancelled'
      ) into v_exists;
      if v_exists then
        return new;
      end if;
    end if;

    select q.tax_rate into v_taxrate from public.quotes q where q.id = new.quote_id;
    if v_taxrate is null then v_taxrate := 18; end if;
    v_base := round(new.amount::numeric * 100.0 / (100.0 + v_taxrate))::integer;

    if v_agr.basis = 'percent' then
      v_rate  := coalesce(v_agr.percent, 0);
      v_gross := round(v_base::numeric * v_rate / 100.0)::integer;
    else
      v_rate  := null;
      v_gross := coalesce(v_agr.fixed_amount, 0);
    end if;

    if v_gross <= 0 then
      return new;
    end if;

    if v_agr.deduct_tds then
      v_tds := round(v_gross::numeric * coalesce(v_agr.tds_rate, 5) / 100.0)::integer;
    else
      v_tds := 0;
    end if;

    insert into public.referral_commissions (
      tenant_id, agreement_id, partner_id, customer_id, payment_id,
      base_amount, basis, rate, gross_commission, tds_amount, net_payable,
      status, earned_date
    ) values (
      new.tenant_id, v_agr.id, v_agr.partner_id, new.customer_id, new.id,
      v_base, v_agr.basis, v_rate, v_gross, v_tds, v_gross - v_tds,
      'earned', current_date
    )
    on conflict (agreement_id, payment_id) where payment_id is not null do nothing;

  exception when others then
    raise warning 'referral commission accrual failed for payment %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;


ALTER FUNCTION "public"."fn_accrue_referral_commission"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."format_document_number"("p_prefix" "text", "p_fiscal_year" "text", "p_number" integer) RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select p_prefix || '-20' || substring(p_fiscal_year from 3 for 2)
       || '-' || substring(p_fiscal_year from 5 for 2)
       || '-' || lpad(p_number::text, 4, '0');
$$;


ALTER FUNCTION "public"."format_document_number"("p_prefix" "text", "p_fiscal_year" "text", "p_number" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_invoice"("p_quote_id" "text") RETURNS TABLE("invoice_id" "text", "net_payable" integer, "total_advances" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_quote     record;
  v_adv       jsonb;
  v_total     integer;
  v_first     timestamptz;
  v_id        text;
  v_gross     integer;
  v_net       integer;
  v_status    invoice_status;
  v_today     date := current_date;
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

  v_id := public.next_document_number('invoice', v_quote.tenant_id);
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
    v_today, v_today + coalesce(v_quote.payment_terms_days, 0), case when v_status = 'paid' then v_today else null end,
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
$$;


ALTER FUNCTION "public"."generate_invoice"("p_quote_id" "text") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."site_promos" (
    "id" "text" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "headline" "text" NOT NULL,
    "subheadline" "text",
    "badge_text" "text",
    "discount_type" "text" NOT NULL,
    "discount_value" integer NOT NULL,
    "applies_to_tier" "text",
    "applies_to_vendor" "text" DEFAULT 'google'::"text",
    "min_seats" integer DEFAULT 1 NOT NULL,
    "max_seats" integer,
    "banner_style" "text" DEFAULT 'amber'::"text" NOT NULL,
    "valid_from" timestamp with time zone DEFAULT "now"() NOT NULL,
    "valid_until" timestamp with time zone,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "site_promos_banner_style_check" CHECK (("banner_style" = ANY (ARRAY['amber'::"text", 'rose'::"text", 'emerald'::"text", 'indigo'::"text", 'ink'::"text"]))),
    CONSTRAINT "site_promos_check" CHECK ((("max_seats" IS NULL) OR ("max_seats" >= "min_seats"))),
    CONSTRAINT "site_promos_discount_type_check" CHECK (("discount_type" = ANY (ARRAY['percent'::"text", 'flat'::"text"]))),
    CONSTRAINT "site_promos_discount_value_check" CHECK (("discount_value" > 0)),
    CONSTRAINT "site_promos_min_seats_check" CHECK (("min_seats" > 0))
);


ALTER TABLE "public"."site_promos" OWNER TO "postgres";


COMMENT ON TABLE "public"."site_promos" IS 'Tenant-wide automatic discounts shown as a banner on /buy/* — applied without a code. Stacks below Google promo, above coupons.';



COMMENT ON COLUMN "public"."site_promos"."applies_to_tier" IS 'null = applies to all tiers; otherwise lowercase tier slug (starter|standard|plus|enterprise)';



COMMENT ON COLUMN "public"."site_promos"."banner_style" IS 'amber|rose|emerald|indigo|ink — controls banner gradient + accent';



CREATE OR REPLACE FUNCTION "public"."get_active_site_promo"("p_tenant_id" "uuid", "p_tier_id" "text" DEFAULT NULL::"text", "p_seats" integer DEFAULT NULL::integer) RETURNS "public"."site_promos"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_row site_promos;
begin
  select sp.*
  into v_row
  from site_promos sp
  where sp.tenant_id = p_tenant_id
    and sp.is_active = true
    and sp.valid_from <= now()
    and (sp.valid_until is null or sp.valid_until > now())
    and (sp.applies_to_tier is null or p_tier_id is null
         or lower(sp.applies_to_tier) = lower(p_tier_id))
    and (p_seats is null or p_seats >= sp.min_seats)
    and (sp.max_seats is null or p_seats is null or p_seats <= sp.max_seats)
  order by sp.updated_at desc
  limit 1;
  return v_row;
end;
$$;


ALTER FUNCTION "public"."get_active_site_promo"("p_tenant_id" "uuid", "p_tier_id" "text", "p_seats" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_my_tenant_with_parent"() RETURNS TABLE("id" "uuid", "name" "text", "tier" "text", "parent_tenant_id" "uuid", "parent_name" "text", "parent_tier" "text", "parent_gstin" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  with my as (
    select tenant_id from public.users where id = auth.uid() limit 1
  )
  select
    t.id, t.name, t.tier, t.parent_tenant_id,
    p.name, p.tier, p.gstin
  from public.tenants t
  left join public.tenants p on p.id = t.parent_tenant_id
  where t.id = (select tenant_id from my);
$$;


ALTER FUNCTION "public"."get_my_tenant_with_parent"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_partner_catalog"() RETURNS TABLE("id" "text", "tenant_id" "uuid", "name" "text", "vendor" "text", "kind" "text", "hsn" "text", "msrp" integer, "partner_price" integer, "prices" "jsonb", "is_active" boolean, "already_synced" boolean)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  with me as (
    select u.tenant_id as child_tenant, t.parent_tenant_id as parent_tenant
    from public.users u
    join public.tenants t on t.id = u.tenant_id
    where u.id = auth.uid()
    limit 1
  )
  select
    pi.id,
    pi.tenant_id,
    pi.name,
    pi.vendor::text,
    pi.kind::text,
    pi.hsn,
    pi.msrp,
    pi.partner_price,
    pi.prices,
    pi.is_active,
    exists (
      select 1
      from public.items ci
      where ci.tenant_id = (select child_tenant from me)
        and ci.synced_from_partner_id = pi.id
    ) as already_synced
  from public.items pi
  where pi.tenant_id = (select parent_tenant from me)
    and pi.is_partner_visible = true
    and pi.is_active = true
  order by pi.vendor, pi.kind, pi.name;
$$;


ALTER FUNCTION "public"."get_partner_catalog"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_partner_metrics"() RETURNS TABLE("tenant_id" "uuid", "tenant_name" "text", "tenant_gstin" "text", "active_subscriptions" integer, "total_seats_sold" integer, "mrr" integer, "invoiced_this_month" integer, "paid_this_month" integer, "renewals_due_30d" integer, "renewal_revenue_30d" integer, "last_invoice_date" "date")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  with caller as (
    select tenant_id from public.users where id = auth.uid() limit 1
  ),
  month_start as (
    select date_trunc('month', current_date)::date as d
  ),
  children as (
    select t.id, t.name, t.gstin
    from public.tenants t
    where t.parent_tenant_id = (select tenant_id from caller)
  )
  select
    c.id, c.name, c.gstin,
    coalesce((select count(*)::int from public.subscriptions s
      where s.tenant_id = c.id and s.status = 'active'), 0),
    coalesce((select sum(seats)::int from public.subscriptions s
      where s.tenant_id = c.id and s.status = 'active'), 0),
    coalesce((select sum(mrr)::int from public.subscriptions s
      where s.tenant_id = c.id and s.status = 'active'), 0),
    coalesce((select sum(amount)::int from public.invoices i
      where i.tenant_id = c.id and i.invoice_date >= (select d from month_start)), 0),
    coalesce((select sum(amount)::int from public.invoices i
      where i.tenant_id = c.id and i.status = 'paid' and i.paid_date is not null
        and i.paid_date >= (select d from month_start)), 0),
    coalesce((select count(*)::int from public.subscriptions s
      where s.tenant_id = c.id and s.status = 'active'
        and s.renewal_date is not null and s.renewal_date <= current_date + interval '30 days'), 0),
    coalesce((select sum(mrr * 12)::int from public.subscriptions s
      where s.tenant_id = c.id and s.status = 'active'
        and s.renewal_date is not null and s.renewal_date <= current_date + interval '30 days'), 0),
    (select max(invoice_date) from public.invoices i where i.tenant_id = c.id)
  from children c
  order by c.name;
$$;


ALTER FUNCTION "public"."get_partner_metrics"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_tenant_backup"("p_id" "uuid") RETURNS "jsonb"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select payload from backup.snapshots
  where id = p_id and tenant_id = (select tenant_id from public.users where id = auth.uid());
$$;


ALTER FUNCTION "public"."get_tenant_backup"("p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_quote_status_change"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  -- Newly accepted → kick off payment workflow
  if new.status = 'accepted' and (old.status is null or old.status != 'accepted') and new.payment_status = 'none' then
    new.payment_status := 'awaiting';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_quote_status_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_task_completion"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if new.status = 'done' and (old.status is distinct from 'done') then
    new.completed_at := now();
    new.completed_by := auth.uid();
  end if;
  if old.status = 'done' and new.status <> 'done' then
    new.completed_at := null;
    new.completed_by := null;
  end if;
  return new;
end $$;


ALTER FUNCTION "public"."handle_task_completion"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."indian_fiscal_year"("p_date" "date" DEFAULT CURRENT_DATE) RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select case
    when extract(month from p_date) >= 4
      then 'FY' || to_char(p_date, 'YY') || to_char(p_date + interval '1 year', 'YY')
    else 'FY' || to_char(p_date - interval '1 year', 'YY') || to_char(p_date, 'YY')
  end;
$$;


ALTER FUNCTION "public"."indian_fiscal_year"("p_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."issue_credit_note"("p_invoice_id" "text", "p_gross_amount" integer, "p_reason_code" "text" DEFAULT 'other'::"text", "p_reason" "text" DEFAULT NULL::"text", "p_notes" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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

  v_cn_id := public.next_document_number('credit_note', v_inv.tenant_id);
  if v_cn_id is null then raise exception 'Could not allocate a credit note number'; end if;

  insert into public.credit_notes (
    id, tenant_id, invoice_id, customer_id, customer_name, credit_date,
    reason_code, reason, amount, taxable_value, tax_amount, tax_rate, inter_state, notes, created_by
  ) values (
    v_cn_id, v_inv.tenant_id, p_invoice_id, v_inv.customer_id, v_inv.customer_name, current_date,
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
$$;


ALTER FUNCTION "public"."issue_credit_note"("p_invoice_id" "text", "p_gross_amount" integer, "p_reason_code" "text", "p_reason" "text", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."issue_debit_note"("p_invoice_id" "text", "p_gross_amount" integer, "p_reason_code" "text" DEFAULT 'other'::"text", "p_reason" "text" DEFAULT NULL::"text", "p_notes" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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

  v_dn_id := public.next_document_number('debit_note', v_inv.tenant_id);
  if v_dn_id is null then raise exception 'Could not allocate a debit note number'; end if;

  insert into public.debit_notes (
    id, tenant_id, invoice_id, customer_id, customer_name, debit_date,
    reason_code, reason, amount, taxable_value, tax_amount, tax_rate, inter_state, notes, created_by
  ) values (
    v_dn_id, v_inv.tenant_id, p_invoice_id, v_inv.customer_id, v_inv.customer_name, current_date,
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
$$;


ALTER FUNCTION "public"."issue_debit_note"("p_invoice_id" "text", "p_gross_amount" integer, "p_reason_code" "text", "p_reason" "text", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."leads_autolink_contact"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if new.contact_id is null then
    begin
      new.contact_id := public.resolve_or_create_contact(new.tenant_id, new.contact_email, new.contact_phone, new.contact_name, new.company);
    exception when others then new.contact_id := null; end;
  end if;
  return new;
end; $$;


ALTER FUNCTION "public"."leads_autolink_contact"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_stranded_auth_users"() RETURNS TABLE("email" "text", "full_name" "text", "created_at" timestamp with time zone, "last_sign_in_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
begin
  if not exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner') then
    raise exception 'Only a workspace owner can see this.' using errcode = '42501';
  end if;

  return query
    select au.email::text,
           coalesce(
             nullif(btrim(au.raw_user_meta_data ->> 'full_name'), ''),
             nullif(btrim(au.raw_user_meta_data ->> 'name'), ''),
             split_part(au.email, '@', 1)
           )::text,
           au.created_at,
           au.last_sign_in_at
      from auth.users au
     where not exists (select 1 from public.users u where u.id = au.id)
       and au.email is not null
     order by au.last_sign_in_at desc nulls last, au.created_at desc;
end;
$$;


ALTER FUNCTION "public"."list_stranded_auth_users"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."list_stranded_auth_users"() IS 'Owner-only. Auth accounts with no public.users row — people who can sign in and land nowhere. Exposes email and name only, never the auth row itself.';



CREATE OR REPLACE FUNCTION "public"."list_tenant_backups"() RETURNS TABLE("id" "uuid", "created_at" timestamp with time zone, "label" "text", "kind" "text", "table_count" integer, "bytes" integer)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select s.id, s.created_at, s.label, s.kind, s.table_count, length(s.payload::text)
  from backup.snapshots s
  where s.tenant_id = (select tenant_id from public.users where id = auth.uid())
  order by s.created_at desc;
$$;


ALTER FUNCTION "public"."list_tenant_backups"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_activity"("p_action" "text", "p_entity" "text" DEFAULT 'session'::"text", "p_entity_id" "text" DEFAULT NULL::"text", "p_label" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from public.users where id = auth.uid();
  if v_tenant is null then return; end if;
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label)
  values (v_tenant, auth.uid(), p_action, coalesce(p_entity, 'session'), p_entity_id, left(p_label, 120));
end $$;


ALTER FUNCTION "public"."log_activity"("p_action" "text", "p_entity" "text", "p_entity_id" "text", "p_label" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_lead_activity"("p_lead_id" "text", "p_kind" "text", "p_detail" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_tenant uuid := public.current_tenant_id(); v_id uuid;
begin
  perform 1 from public.leads where id = p_lead_id and tenant_id = v_tenant;
  if not found then raise exception 'Lead not found'; end if;
  insert into public.lead_activities (tenant_id, lead_id, kind, detail, created_by)
  values (v_tenant, p_lead_id, coalesce(nullif(trim(p_kind), ''), 'note'),
          nullif(trim(coalesce(p_detail, '')), ''), auth.uid())
  returning id into v_id;
  return v_id;
end; $$;


ALTER FUNCTION "public"."log_lead_activity"("p_lead_id" "text", "p_kind" "text", "p_detail" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_row_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_json jsonb; v_tenant uuid; v_id text; v_label text;
begin
  if auth.uid() is null then return null; end if;
  if tg_op = 'DELETE' then v_json := to_jsonb(old); else v_json := to_jsonb(new); end if;
  v_tenant := nullif(v_json->>'tenant_id', '')::uuid;
  if v_tenant is null then return null; end if;
  v_id := v_json->>'id';
  v_label := coalesce(
    v_json->>'full_name', v_json->>'name', v_json->>'company', v_json->>'company_name',
    v_json->>'invoice_no', v_json->>'quote_no', v_json->>'title', v_json->>'vendor_name', ''
  );
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label)
  values (v_tenant, auth.uid(), lower(tg_op), tg_table_name, v_id, left(v_label, 120));
  return null;
end $$;


ALTER FUNCTION "public"."log_row_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mark_attendance"("p_employee_id" "uuid", "p_pin" "text", "p_ip" "text" DEFAULT NULL::"text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_hash   text;
  v_active boolean;
  v_date   date := (now() at time zone 'Asia/Kolkata')::date;
  v_row    public.attendance;
begin
  select pin_hash, is_active into v_hash, v_active from public.employees
    where id = p_employee_id and tenant_id = v_tenant;
  if not found then raise exception 'Employee not found'; end if;
  if not coalesce(v_active, false) then raise exception 'Employee is inactive'; end if;
  if v_hash is null then raise exception 'No PIN set — ask the owner to set your PIN'; end if;
  if p_pin is null or crypt(p_pin, v_hash) <> v_hash then raise exception 'Wrong PIN'; end if;

  select * into v_row from public.attendance
    where tenant_id = v_tenant and employee_id = p_employee_id and work_date = v_date;

  if not found then
    insert into public.attendance (tenant_id, employee_id, work_date, check_in, source, marked_ip)
    values (v_tenant, p_employee_id, v_date, now(), 'kiosk', p_ip);
    return 'checked_in';
  elsif v_row.check_out is null then
    if now() - v_row.check_in < interval '90 seconds' then
      return 'too_soon';
    end if;
    update public.attendance set check_out = now(), marked_ip = coalesce(p_ip, marked_ip) where id = v_row.id;
    return 'checked_out';
  else
    return 'already_done';
  end if;
end;
$$;


ALTER FUNCTION "public"."mark_attendance"("p_employee_id" "uuid", "p_pin" "text", "p_ip" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mark_self_attendance"() RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_tenant uuid; v_emp uuid; v_date date; v_row public.attendance;
begin
  select tenant_id, employee_id into v_tenant, v_emp from public.users where id = auth.uid();
  if v_emp is null then raise exception 'Pehle apna employee link karo.'; end if;
  v_date := (now() at time zone 'Asia/Kolkata')::date;
  select * into v_row from public.attendance where tenant_id = v_tenant and employee_id = v_emp and work_date = v_date;
  if not found then
    insert into public.attendance (tenant_id, employee_id, work_date, check_in, source)
    values (v_tenant, v_emp, v_date, now(), 'self');
    return 'checked_in';
  elsif v_row.check_out is null then
    if now() - v_row.check_in < interval '90 seconds' then
      return 'too_soon';
    end if;
    update public.attendance set check_out = now() where id = v_row.id;
    return 'checked_out';
  else
    return 'already_done';
  end if;
end $$;


ALTER FUNCTION "public"."mark_self_attendance"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."merge_leads"("p_primary_id" "text", "p_duplicate_id" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant    uuid := current_tenant_id();
  v_primary   public.leads;
  v_duplicate public.leads;
begin
  if v_tenant is null then
    raise exception 'No tenant in context';
  end if;
  if p_primary_id = p_duplicate_id then
    raise exception 'Cannot merge a lead into itself';
  end if;

  select * into v_primary
  from public.leads
  where id = p_primary_id and tenant_id = v_tenant
  for update;
  if not found then
    raise exception 'Primary lead % not found in this tenant', p_primary_id;
  end if;

  select * into v_duplicate
  from public.leads
  where id = p_duplicate_id and tenant_id = v_tenant
  for update;
  if not found then
    raise exception 'Duplicate lead % not found in this tenant', p_duplicate_id;
  end if;

  update public.lead_activities   set lead_id = p_primary_id where lead_id = p_duplicate_id;
  update public.quotes            set lead_id = p_primary_id where lead_id = p_duplicate_id;
  update public.tasks             set lead_id = p_primary_id where lead_id = p_duplicate_id;
  update public.campaign_sends    set lead_id = p_primary_id where lead_id = p_duplicate_id;
  update public.coupon_redemptions set lead_id = p_primary_id where lead_id = p_duplicate_id;
  update public.contacts          set promoted_to_lead_id = p_primary_id where promoted_to_lead_id = p_duplicate_id;

  update public.leads set
    contact_name  = coalesce(contact_name,  v_duplicate.contact_name),
    contact_email = coalesce(contact_email, v_duplicate.contact_email),
    contact_phone = coalesce(contact_phone, v_duplicate.contact_phone),
    plan          = coalesce(plan,          v_duplicate.plan),
    seats         = coalesce(seats,         v_duplicate.seats),
    value         = nullif(greatest(coalesce(value, 0), coalesce(v_duplicate.value, 0)), 0),
    gstin         = coalesce(gstin,         v_duplicate.gstin),
    domain        = coalesce(domain,        v_duplicate.domain),
    state_code    = coalesce(state_code,    v_duplicate.state_code),
    state         = coalesce(state,         v_duplicate.state),
    owner_id      = coalesce(owner_id,      v_duplicate.owner_id),
    follow_up_date = coalesce(follow_up_date, v_duplicate.follow_up_date),
    notes         = case
                      when coalesce(v_duplicate.notes, '') = '' then notes
                      when coalesce(notes, '') = ''             then v_duplicate.notes
                      else notes || E'\n---\n(merged) ' || v_duplicate.notes
                    end,
    updated_at    = now()
  where id = p_primary_id and tenant_id = v_tenant;

  delete from public.leads where id = p_duplicate_id and tenant_id = v_tenant;
end;
$$;


ALTER FUNCTION "public"."merge_leads"("p_primary_id" "text", "p_duplicate_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."merge_stranded_user_into_tenant"("p_email" "text", "p_tenant_id" "uuid", "p_role" "public"."user_role" DEFAULT 'support'::"public"."user_role") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
declare
  v_email        text := lower(btrim(p_email));
  v_caller_tid   uuid;
  v_caller_role  public.user_role;
  v_dest_name    text;
  v_auth_id      uuid;
  v_auth_name    text;
  v_old_tid      uuid;
  v_old_name     text;
  v_old_users    int;
  v_sql          text;
  v_holdings     jsonb;
  v_rows         bigint;
  v_action       text;
  v_deleted      boolean := false;
begin
  -- ── 1. The caller must own the destination workspace ────────────────────
  select u.tenant_id, u.role
    into v_caller_tid, v_caller_role
    from public.users u
   where u.id = auth.uid();

  if v_caller_tid is null then
    raise exception
      'You are not signed in to a workspace, so there is nothing to claim this person into. Sign in again and reopen Team.'
      using errcode = '42501';
  end if;

  if v_caller_tid <> p_tenant_id or v_caller_role <> 'owner' then
    raise exception
      'Only the owner of a workspace can claim someone into it. Ask your workspace owner to open Team → Claim a colleague.'
      using errcode = '42501';
  end if;

  select t.name into v_dest_name from public.tenants t where t.id = p_tenant_id;

  -- ── 2. Do they have an account at all? ──────────────────────────────────
  select au.id,
         coalesce(
           nullif(btrim(au.raw_user_meta_data ->> 'full_name'), ''),
           nullif(btrim(au.raw_user_meta_data ->> 'name'), ''),
           split_part(au.email, '@', 1)
         )
    into v_auth_id, v_auth_name
    from auth.users au
   where lower(au.email) = v_email
   limit 1;

  if v_auth_id is null then
    raise exception
      'No account exists for %. Send them an invite from Team → Invite teammate using this exact address, ask them to sign in once, then claim them.',
      v_email
      using errcode = 'P0002';
  end if;

  -- ── 3. Where are they now? ──────────────────────────────────────────────
  select u.tenant_id into v_old_tid
    from public.users u
   where u.id = v_auth_id;

  -- 3a. Already here. Only the role may need correcting.
  if v_old_tid = p_tenant_id then
    update public.users set role = p_role where id = v_auth_id and role <> p_role;
    v_action := case when found then 'role_updated' else 'already_member' end;

  -- 3b. Truly stranded: an auth account with no profile anywhere. This is the
  --     thirteen. Nothing to move and nothing to delete — just give them a home.
  elsif v_old_tid is null then
    insert into public.users (id, tenant_id, email, full_name, initials, role, color)
    values (
      v_auth_id, p_tenant_id, v_email, v_auth_name,
      upper(left(regexp_replace(coalesce(v_auth_name, v_email), '[^A-Za-z]', '', 'g'), 2)),
      p_role, 'indigo'
    );
    v_action := 'attached';

  -- 3c. They are sitting in another tenant.
  else
    select t.name, (select count(*) from public.users u2 where u2.tenant_id = t.id)
      into v_old_name, v_old_users
      from public.tenants t where t.id = v_old_tid;

    -- A workspace with other people in it is somebody's real company, not a
    -- stray. Refuse before looking at data — this tool is for accidents.
    if v_old_users > 1 then
      raise exception
        'Cannot claim %: they belong to "%", which has % people in it. That is a separate company, not an accidental workspace. If it really should be merged, that is a platform-admin job.',
        v_email, v_old_name, v_old_users
        using errcode = '23505';
    end if;

    -- Count everything that is not bookkeeping. Fail-safe: unlisted table = data.
    select string_agg(
             format('select %L::text as tbl, count(*)::bigint as n from public.%I where tenant_id = %L',
                    c.table_name, c.table_name, v_old_tid),
             ' union all ')
      into v_sql
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema
       and t.table_name   = c.table_name
       and t.table_type   = 'BASE TABLE'
     where c.table_schema = 'public'
       and c.column_name  = 'tenant_id'
       and c.table_name not in (
             -- Bookkeeping only. None of these is a thing an operator would
             -- mourn, and all of them cascade with the tenant anyway.
             'users', 'activity_log', 'team_invites', 'tenant_secrets',
             'document_series', 'customer_number_seq', 'user_google_tokens',
             'tenant_domains', 'join_requests', 'email_log', 'api_keys'
           );

    execute format(
      'select coalesce(jsonb_object_agg(tbl, n) filter (where n > 0), ''{}''::jsonb),
              coalesce(sum(n), 0) from (%s) s', v_sql)
      into v_holdings, v_rows;

    if v_rows > 0 then
      raise exception
        'Cannot claim %: their workspace "%" still holds % records (%). Moving them out would leave that data with no one who can sign in and see it. Move or export the data first — this tool only clears empty workspaces.',
        v_email, v_old_name, v_rows, v_holdings::text
        using errcode = '23503';
    end if;

    update public.users
       set tenant_id = p_tenant_id,
           role      = p_role,
           email     = v_email
     where id = v_auth_id;

    -- Empty, and now nobody is in it. 78 of 80 tenant FKs cascade.
    delete from public.tenants where id = v_old_tid;
    v_deleted := true;
    v_action  := 'moved';
  end if;

  -- ── 4. Any open request from this person is now settled ─────────────────
  update public.join_requests
     set status = 'approved', decided_at = now(), decided_by = auth.uid()
   where tenant_id = p_tenant_id
     and lower(email) = v_email
     and status = 'pending_approval';

  -- ── 5. Visible in the destination workspace, not just in a server log ───
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label)
  values (
    p_tenant_id, auth.uid(), v_action, 'user', v_auth_id::text,
    format('Claimed %s into %s as %s%s',
           v_email, coalesce(v_dest_name, 'this workspace'), p_role,
           case when v_deleted then format(' (removed empty workspace "%s")', v_old_name) else '' end)
  );

  return jsonb_build_object(
    'action',          v_action,
    'email',           v_email,
    'full_name',       v_auth_name,
    'auth_user_id',    v_auth_id,
    'role',            p_role,
    'tenant_id',       p_tenant_id,
    'tenant_name',     v_dest_name,
    'old_tenant_name', v_old_name,
    'old_tenant_deleted', v_deleted
  );
end;
$$;


ALTER FUNCTION "public"."merge_stranded_user_into_tenant"("p_email" "text", "p_tenant_id" "uuid", "p_role" "public"."user_role") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."merge_stranded_user_into_tenant"("p_email" "text", "p_tenant_id" "uuid", "p_role" "public"."user_role") IS 'Owner-only. Attaches an auth account to the caller''s tenant and deletes the workspace it came from ONLY when that workspace is empty of business data. Refuses (does not partially apply) when the old workspace holds records or holds other people.';



CREATE OR REPLACE FUNCTION "public"."my_attendance_history"("p_days" integer DEFAULT 14) RETURNS TABLE("work_date" "date", "check_in" timestamp with time zone, "check_out" timestamp with time zone, "source" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_tenant uuid; v_emp uuid;
begin
  select tenant_id, employee_id into v_tenant, v_emp from public.users where id = auth.uid();
  if v_emp is null then return; end if;
  return query
    select a.work_date, a.check_in, a.check_out, a.source
    from public.attendance a
    where a.tenant_id = v_tenant and a.employee_id = v_emp
      and a.work_date >= ((now() at time zone 'Asia/Kolkata')::date - greatest(p_days, 1))
    order by a.work_date desc;
end $$;


ALTER FUNCTION "public"."my_attendance_history"("p_days" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_attendance_today"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_tenant uuid; v_emp uuid; v_name text; v_date date; v_row public.attendance;
        v_consent timestamptz; v_retention int; v_face timestamptz;
begin
  select tenant_id, employee_id into v_tenant, v_emp from public.users where id = auth.uid();
  if v_emp is null then return jsonb_build_object('linked', false); end if;
  select name, attendance_consent_at, face_enrolled_at into v_name, v_consent, v_face from public.employees where id = v_emp;
  select coalesce(selfie_retention_days, 180) into v_retention from public.attendance_settings where tenant_id = v_tenant;
  v_date := (now() at time zone 'Asia/Kolkata')::date;
  select * into v_row from public.attendance where tenant_id = v_tenant and employee_id = v_emp and work_date = v_date;
  return jsonb_build_object(
    'linked', true, 'employee_name', v_name, 'work_date', v_date,
    'check_in', v_row.check_in, 'check_out', v_row.check_out,
    'consent_at', v_consent, 'retention_days', coalesce(v_retention, 180),
    'face_enrolled', (v_face is not null)
  );
end $$;


ALTER FUNCTION "public"."my_attendance_today"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."next_customer_number"("p_tenant" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_caller uuid := public.current_tenant_id();
  v_n integer;
begin
  if v_caller is not null and p_tenant <> v_caller then
    raise exception 'Cannot allocate a customer number for another tenant'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.customer_number_seq (tenant_id, last_number)
  values (p_tenant, 1)
  on conflict (tenant_id)
    do update set last_number = customer_number_seq.last_number + 1
  returning last_number into v_n;
  return 'C-' || lpad(v_n::text, 5, '0');
end;
$$;


ALTER FUNCTION "public"."next_customer_number"("p_tenant" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."next_document_number"("p_doc_type" "text", "p_tenant_id" "uuid" DEFAULT NULL::"uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_caller      uuid := public.current_tenant_id();
  v_tenant_id   uuid;
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

  v_fy     := public.indian_fiscal_year();
  v_prefix := public.default_doc_prefix(p_doc_type);

  select doc_code into v_code from public.tenants where id = v_tenant_id;
  v_code := coalesce(nullif(trim(v_code), ''), upper(substring(replace(v_tenant_id::text, '-', '') from 1 for 4)));

  insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values (v_tenant_id, p_doc_type, v_fy, v_prefix, 1)
  on conflict (tenant_id, doc_type, fiscal_year)
  do update set
    last_number = document_series.last_number + 1,
    updated_at  = now()
  returning last_number into v_next_number;

  return public.format_document_number(v_prefix || '-' || v_code, v_fy, v_next_number);
end;
$$;


ALTER FUNCTION "public"."next_document_number"("p_doc_type" "text", "p_tenant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pay_referral_commission"("p_commission_id" "uuid", "p_bank_account_id" "uuid", "p_paid_on" "date" DEFAULT NULL::"date", "p_method" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_comm   public.referral_commissions;
  v_pname  text;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;

  select * into v_comm from public.referral_commissions
   where id = p_commission_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Commission not found'; end if;
  if v_comm.status = 'paid' then raise exception 'Commission already paid'; end if;
  if v_comm.status = 'cancelled' then raise exception 'Commission is cancelled'; end if;

  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Pay-from account not found'; end if;

  select name into v_pname from public.referral_partners where id = v_comm.partner_id;

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source,
     matched_to_type, matched_to_id, match_confidence, reference)
  values
    (v_tenant, p_bank_account_id, coalesce(p_paid_on, current_date),
     'Referral commission: ' || coalesce(v_pname, 'partner'), v_comm.net_payable, 0, 'manual',
     'referral_commission', p_commission_id::text, 'manual',
     nullif(trim(coalesce(p_method, '')), ''));

  update public.referral_commissions
     set status = 'paid', paid_date = coalesce(p_paid_on, current_date)
   where id = p_commission_id;
end;
$$;


ALTER FUNCTION "public"."pay_referral_commission"("p_commission_id" "uuid", "p_bank_account_id" "uuid", "p_paid_on" "date", "p_method" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pay_salary"("p_employee_id" "uuid", "p_period" "text", "p_pay_date" "date", "p_gross" integer, "p_lop_days" numeric, "p_lop_amount" integer, "p_advance_recovered" integer, "p_advance_loan_id" "uuid", "p_tds" integer, "p_pf" integer, "p_esi" integer, "p_other" integer, "p_bank_account_id" "uuid", "p_notes" "text" DEFAULT NULL::"text", "p_incentive" integer DEFAULT 0) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_emp public.employees;
  v_gross integer := greatest(coalesce(p_gross,0),0);
  v_lop_amt integer := greatest(coalesce(p_lop_amount,0),0);
  v_inc integer := greatest(coalesce(p_incentive,0),0);
  v_adv integer := greatest(coalesce(p_advance_recovered,0),0);
  v_tds integer := greatest(coalesce(p_tds,0),0);
  v_pf integer := greatest(coalesce(p_pf,0),0);
  v_esi integer := greatest(coalesce(p_esi,0),0);
  v_other integer := greatest(coalesce(p_other,0),0);
  v_earned integer; v_net integer; v_exp_id text; v_pay_id uuid;
  v_loan public.employee_loans; v_paid integer; v_outstd integer;
begin
  select * into v_emp from public.employees where id = p_employee_id and tenant_id = v_tenant;
  if not found then raise exception 'Employee not found'; end if;
  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Pay-out account not found'; end if;
  v_earned := greatest(v_gross - v_lop_amt, 0) + v_inc;
  v_net := v_earned - v_adv - v_tds - v_pf - v_esi - v_other;
  if v_net < 0 then raise exception 'Deductions (%) exceed earned pay (%)', v_adv+v_tds+v_pf+v_esi+v_other, v_earned; end if;
  if v_adv > 0 then
    if p_advance_loan_id is null then raise exception 'Pick which advance/loan the recovery reduces'; end if;
    select * into v_loan from public.employee_loans where id = p_advance_loan_id and tenant_id = v_tenant;
    if not found then raise exception 'Advance/loan not found'; end if;
    select coalesce(sum(amount),0) into v_paid from public.employee_loan_repayments where loan_id = p_advance_loan_id;
    v_outstd := v_loan.principal - v_paid;
    if v_adv > v_outstd then raise exception 'Advance recovery (%) exceeds its outstanding (%)', v_adv, v_outstd; end if;
  end if;
  v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int));
  insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
  values (v_exp_id, v_tenant, 'Salaries', v_emp.name, p_pay_date, v_earned, 0, 'payroll',
          'Salary ' || p_period || ' — ' || v_emp.name || case when v_inc > 0 then ' (incl. incentive)' else '' end);
  insert into public.salary_payments
    (tenant_id, employee_id, period, pay_date, gross, lop_days, lop_amount, incentive, advance_recovered, tds, pf, esi, other_deduction, net, bank_account_id, expense_id, advance_loan_id, notes, paid_status)
  values
    (v_tenant, p_employee_id, p_period, p_pay_date, v_gross, coalesce(p_lop_days,0), v_lop_amt, v_inc, v_adv, v_tds, v_pf, v_esi, v_other, v_net, p_bank_account_id, v_exp_id,
     case when v_adv > 0 then p_advance_loan_id else null end, nullif(trim(coalesce(p_notes,'')),''), 'unpaid')
  returning id into v_pay_id;
  if v_adv > 0 then
    insert into public.employee_loan_repayments (tenant_id, loan_id, amount, repaid_on, method, bank_account_id, notes)
    values (v_tenant, p_advance_loan_id, v_adv, p_pay_date, 'salary_deduction', null, 'Recovered from salary ' || p_period);
    update public.employee_loans set status = case when (v_outstd - v_adv) <= 0 then 'closed' else 'active' end, updated_at = now() where id = p_advance_loan_id;
  end if;
  return v_pay_id;
end; $$;


ALTER FUNCTION "public"."pay_salary"("p_employee_id" "uuid", "p_period" "text", "p_pay_date" "date", "p_gross" integer, "p_lop_days" numeric, "p_lop_amount" integer, "p_advance_recovered" integer, "p_advance_loan_id" "uuid", "p_tds" integer, "p_pf" integer, "p_esi" integer, "p_other" integer, "p_bank_account_id" "uuid", "p_notes" "text", "p_incentive" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pay_salary"("p_employee_id" "uuid", "p_period" "text", "p_pay_date" "date", "p_gross" integer, "p_lop_days" numeric, "p_lop_amount" integer, "p_advance_recovered" integer, "p_advance_loan_id" "uuid", "p_tds" integer, "p_pf" integer, "p_esi" integer, "p_other" integer, "p_bank_account_id" "uuid", "p_notes" "text" DEFAULT NULL::"text", "p_incentive" integer DEFAULT 0, "p_esi_employer" integer DEFAULT 0) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_emp public.employees;
  v_gross integer := greatest(coalesce(p_gross,0),0);
  v_lop_amt integer := greatest(coalesce(p_lop_amount,0),0);
  v_inc integer := greatest(coalesce(p_incentive,0),0);
  v_adv integer := greatest(coalesce(p_advance_recovered,0),0);
  v_tds integer := greatest(coalesce(p_tds,0),0);
  v_pf integer := greatest(coalesce(p_pf,0),0);
  v_esi integer := greatest(coalesce(p_esi,0),0);
  v_esi_emp integer := greatest(coalesce(p_esi_employer,0),0);
  v_other integer := greatest(coalesce(p_other,0),0);
  v_earned integer; v_net integer; v_exp_id text; v_esi_exp_id text; v_pay_id uuid;
  v_loan public.employee_loans; v_paid integer; v_outstd integer;
begin
  select * into v_emp from public.employees where id = p_employee_id and tenant_id = v_tenant;
  if not found then raise exception 'Employee not found'; end if;
  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Pay-out account not found'; end if;
  v_earned := greatest(v_gross - v_lop_amt, 0) + v_inc;
  v_net := v_earned - v_adv - v_tds - v_pf - v_esi - v_other;
  if v_net < 0 then raise exception 'Deductions (%) exceed earned pay (%)', v_adv+v_tds+v_pf+v_esi+v_other, v_earned; end if;
  if v_adv > 0 then
    if p_advance_loan_id is null then raise exception 'Pick which advance/loan the recovery reduces'; end if;
    select * into v_loan from public.employee_loans where id = p_advance_loan_id and tenant_id = v_tenant;
    if not found then raise exception 'Advance/loan not found'; end if;
    select coalesce(sum(amount),0) into v_paid from public.employee_loan_repayments where loan_id = p_advance_loan_id;
    v_outstd := v_loan.principal - v_paid;
    if v_adv > v_outstd then raise exception 'Advance recovery (%) exceeds its outstanding (%)', v_adv, v_outstd; end if;
  end if;

  v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int));
  insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
  values (v_exp_id, v_tenant, 'Salaries', v_emp.name, p_pay_date, v_earned, 0, 'payroll',
          'Salary ' || p_period || ' — ' || v_emp.name || case when v_inc > 0 then ' (incl. incentive)' else '' end);

  if v_esi_emp > 0 then
    v_esi_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int)) || 'E';
    insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
    values (v_esi_exp_id, v_tenant, 'ESI — Employer', v_emp.name, p_pay_date, v_esi_emp, 0, 'statutory',
            'ESI employer contribution ' || p_period || ' — ' || v_emp.name);
  end if;

  insert into public.salary_payments
    (tenant_id, employee_id, period, pay_date, gross, lop_days, lop_amount, incentive, advance_recovered,
     tds, pf, esi, esi_employer, other_deduction, net, bank_account_id, expense_id, advance_loan_id, notes, paid_status)
  values
    (v_tenant, p_employee_id, p_period, p_pay_date, v_gross, coalesce(p_lop_days,0), v_lop_amt, v_inc, v_adv,
     v_tds, v_pf, v_esi, v_esi_emp, v_other, v_net, p_bank_account_id, v_exp_id,
     case when v_adv > 0 then p_advance_loan_id else null end, nullif(trim(coalesce(p_notes,'')),''), 'unpaid')
  returning id into v_pay_id;

  if v_adv > 0 then
    insert into public.employee_loan_repayments (tenant_id, loan_id, amount, repaid_on, method, bank_account_id, notes)
    values (v_tenant, p_advance_loan_id, v_adv, p_pay_date, 'salary_deduction', null, 'Recovered from salary ' || p_period);
    update public.employee_loans set status = case when (v_outstd - v_adv) <= 0 then 'closed' else 'active' end, updated_at = now() where id = p_advance_loan_id;
  end if;
  return v_pay_id;
end; $$;


ALTER FUNCTION "public"."pay_salary"("p_employee_id" "uuid", "p_period" "text", "p_pay_date" "date", "p_gross" integer, "p_lop_days" numeric, "p_lop_amount" integer, "p_advance_recovered" integer, "p_advance_loan_id" "uuid", "p_tds" integer, "p_pf" integer, "p_esi" integer, "p_other" integer, "p_bank_account_id" "uuid", "p_notes" "text", "p_incentive" integer, "p_esi_employer" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pay_salary"("p_employee_id" "uuid", "p_period" "text", "p_pay_date" "date", "p_gross" integer, "p_lop_days" numeric, "p_lop_amount" integer, "p_advance_recovered" integer, "p_advance_loan_id" "uuid", "p_tds" integer, "p_pf" integer, "p_esi" integer, "p_other" integer, "p_bank_account_id" "uuid", "p_notes" "text" DEFAULT NULL::"text", "p_incentive" integer DEFAULT 0, "p_esi_employer" integer DEFAULT 0, "p_pf_employer" integer DEFAULT 0) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_emp public.employees;
  v_gross integer := greatest(coalesce(p_gross,0),0);
  v_lop_amt integer := greatest(coalesce(p_lop_amount,0),0);
  v_inc integer := greatest(coalesce(p_incentive,0),0);
  v_adv integer := greatest(coalesce(p_advance_recovered,0),0);
  v_tds integer := greatest(coalesce(p_tds,0),0);
  v_pf integer := greatest(coalesce(p_pf,0),0);
  v_esi integer := greatest(coalesce(p_esi,0),0);
  v_esi_emp integer := greatest(coalesce(p_esi_employer,0),0);
  v_pf_emp integer := greatest(coalesce(p_pf_employer,0),0);
  v_other integer := greatest(coalesce(p_other,0),0);
  v_earned integer; v_net integer; v_exp_id text; v_esi_exp_id text; v_pf_exp_id text; v_pay_id uuid;
  v_loan public.employee_loans; v_paid integer; v_outstd integer;
begin
  select * into v_emp from public.employees where id = p_employee_id and tenant_id = v_tenant;
  if not found then raise exception 'Employee not found'; end if;
  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Pay-out account not found'; end if;
  v_earned := greatest(v_gross - v_lop_amt, 0) + v_inc;
  v_net := v_earned - v_adv - v_tds - v_pf - v_esi - v_other;
  if v_net < 0 then raise exception 'Deductions (%) exceed earned pay (%)', v_adv+v_tds+v_pf+v_esi+v_other, v_earned; end if;
  if v_adv > 0 then
    if p_advance_loan_id is null then raise exception 'Pick which advance/loan the recovery reduces'; end if;
    select * into v_loan from public.employee_loans where id = p_advance_loan_id and tenant_id = v_tenant;
    if not found then raise exception 'Advance/loan not found'; end if;
    select coalesce(sum(amount),0) into v_paid from public.employee_loan_repayments where loan_id = p_advance_loan_id;
    v_outstd := v_loan.principal - v_paid;
    if v_adv > v_outstd then raise exception 'Advance recovery (%) exceeds its outstanding (%)', v_adv, v_outstd; end if;
  end if;

  v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int));
  insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
  values (v_exp_id, v_tenant, 'Salaries', v_emp.name, p_pay_date, v_earned, 0, 'payroll',
          'Salary ' || p_period || ' — ' || v_emp.name || case when v_inc > 0 then ' (incl. incentive)' else '' end);

  if v_esi_emp > 0 then
    v_esi_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int)) || 'E';
    insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
    values (v_esi_exp_id, v_tenant, 'ESI — Employer', v_emp.name, p_pay_date, v_esi_emp, 0, 'statutory',
            'ESI employer contribution ' || p_period || ' — ' || v_emp.name);
  end if;

  if v_pf_emp > 0 then
    v_pf_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int)) || 'P';
    insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
    values (v_pf_exp_id, v_tenant, 'PF — Employer', v_emp.name, p_pay_date, v_pf_emp, 0, 'statutory',
            'PF employer contribution ' || p_period || ' — ' || v_emp.name);
  end if;

  insert into public.salary_payments
    (tenant_id, employee_id, period, pay_date, gross, lop_days, lop_amount, incentive, advance_recovered,
     tds, pf, esi, esi_employer, pf_employer, other_deduction, net, bank_account_id, expense_id, advance_loan_id, notes, paid_status)
  values
    (v_tenant, p_employee_id, p_period, p_pay_date, v_gross, coalesce(p_lop_days,0), v_lop_amt, v_inc, v_adv,
     v_tds, v_pf, v_esi, v_esi_emp, v_pf_emp, v_other, v_net, p_bank_account_id, v_exp_id,
     case when v_adv > 0 then p_advance_loan_id else null end, nullif(trim(coalesce(p_notes,'')),''), 'unpaid')
  returning id into v_pay_id;

  if v_adv > 0 then
    insert into public.employee_loan_repayments (tenant_id, loan_id, amount, repaid_on, method, bank_account_id, notes)
    values (v_tenant, p_advance_loan_id, v_adv, p_pay_date, 'salary_deduction', null, 'Recovered from salary ' || p_period);
    update public.employee_loans set status = case when (v_outstd - v_adv) <= 0 then 'closed' else 'active' end, updated_at = now() where id = p_advance_loan_id;
  end if;
  return v_pay_id;
end; $$;


ALTER FUNCTION "public"."pay_salary"("p_employee_id" "uuid", "p_period" "text", "p_pay_date" "date", "p_gross" integer, "p_lop_days" numeric, "p_lop_amount" integer, "p_advance_recovered" integer, "p_advance_loan_id" "uuid", "p_tds" integer, "p_pf" integer, "p_esi" integer, "p_other" integer, "p_bank_account_id" "uuid", "p_notes" "text", "p_incentive" integer, "p_esi_employer" integer, "p_pf_employer" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pay_statutory_dues"("p_amount" integer, "p_kind" "text", "p_paid_on" "date", "p_bank_account_id" "uuid", "p_notes" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_acct   text;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be positive';
  end if;
  select name into v_acct from public.bank_accounts
    where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Account not found'; end if;

  insert into public.statutory_dues_payments (tenant_id, kind, amount, paid_on, bank_account_id, notes)
  values (v_tenant, coalesce(nullif(p_kind, ''), 'mixed'), p_amount, p_paid_on, p_bank_account_id,
          nullif(trim(coalesce(p_notes, '')), ''));

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
  values
    (v_tenant, p_bank_account_id, p_paid_on,
     'Statutory dues paid (' || coalesce(nullif(p_kind, ''), 'mixed') || ')', p_amount, 0, 'manual', 'manual', 'manual');
end;
$$;


ALTER FUNCTION "public"."pay_statutory_dues"("p_amount" integer, "p_kind" "text", "p_paid_on" "date", "p_bank_account_id" "uuid", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pay_vendor_bill"("p_bill_id" "text", "p_amount" integer, "p_paid_on" "date", "p_bank_account_id" "uuid", "p_method" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant      uuid := public.current_tenant_id();
  v_bill        public.vendor_bills;
  v_outstanding integer;
  v_new_paid    integer;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than 0'; end if;

  select * into v_bill from public.vendor_bills where id = p_bill_id and tenant_id = v_tenant;
  if not found then raise exception 'Bill not found'; end if;

  v_outstanding := coalesce(v_bill.total, 0) - coalesce(v_bill.paid_amount, 0);
  if p_amount > v_outstanding then
    raise exception 'Payment (%) exceeds the outstanding (%)', p_amount, v_outstanding;
  end if;

  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Pay-from account not found'; end if;

  v_new_paid := coalesce(v_bill.paid_amount, 0) + p_amount;
  update public.vendor_bills
     set paid_amount = v_new_paid,
         status      = case when v_new_paid >= coalesce(total, 0) then 'paid' else 'partial' end,
         updated_at  = now()
   where id = p_bill_id;

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, matched_to_id, match_confidence, reference)
  values
    (v_tenant, p_bank_account_id, coalesce(p_paid_on, current_date),
     'Bill payment: ' || v_bill.vendor_name, p_amount, 0, 'manual', 'vendor_bill', p_bill_id, 'manual',
     nullif(trim(coalesce(p_method, '')), ''));
end;
$$;


ALTER FUNCTION "public"."pay_vendor_bill"("p_bill_id" "text", "p_amount" integer, "p_paid_on" "date", "p_bank_account_id" "uuid", "p_method" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."plan_key"("p_name" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE PARALLEL SAFE
    SET "search_path" TO ''
    AS $$
  select coalesce(
    (select string_agg(w, ' ' order by ord)
       from unnest(
         regexp_split_to_array(
           regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', ' ', 'g'),
           ' '
         )
       ) with ordinality as t(w, ord)
      where w <> '' and w <> 'business'),
    ''
  );
$$;


ALTER FUNCTION "public"."plan_key"("p_name" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."plan_key"("p_name" "text") IS 'Comparable key for a product name (lowercase, punctuation stripped, filler word "business" dropped). Twin of planKey() in lib/subscriptions/plan-match.ts — change both together.';



CREATE OR REPLACE FUNCTION "public"."portal_customer_exists"("p_email" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists(
    select 1 from public.customers
     where p_email is not null
       and length(trim(p_email)) > 0
       and lower(contact_email) = lower(trim(p_email))
  );
$$;


ALTER FUNCTION "public"."portal_customer_exists"("p_email" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."portal_ensure_customer_link"() RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_uid          uuid := auth.uid();
  v_email        text;
  v_customer_id  uuid;
  v_tenant_id    uuid;
begin
  if v_uid is null then
    return 'no_auth';
  end if;

  select email into v_email from auth.users where id = v_uid;
  if v_email is null or length(trim(v_email)) = 0 then
    return 'no_auth';
  end if;

  if exists (select 1 from public.customer_users where auth_user_id = v_uid) then
    update public.customer_users set last_login_at = now() where auth_user_id = v_uid;
    return 'already';
  end if;

  select id, tenant_id into v_customer_id, v_tenant_id
    from public.customers
   where lower(contact_email) = lower(trim(v_email))
   limit 1;

  if v_customer_id is null then
    return 'no_customer';
  end if;

  insert into public.customer_users
    (tenant_id, customer_id, auth_user_id, email, role, last_login_at)
  values
    (v_tenant_id, v_customer_id, v_uid, v_email, 'admin', now());

  return 'linked';
end;
$$;


ALTER FUNCTION "public"."portal_ensure_customer_link"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."portal_list_products"() RETURNS TABLE("id" "text", "name" "text", "vendor" "text", "price_per_seat_month" integer, "hsn" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select
    i.id,
    i.name,
    i.vendor::text,
    coalesce(
      nullif((i.prices->'annual'->>'msrp'), '')::int,
      i.msrp
    ) as price_per_seat_month,
    i.hsn
  from public.items i
  where i.is_active = true
    and i.kind = 'main'
    and i.tenant_id = (
      select cu.tenant_id from public.customer_users cu
      where cu.auth_user_id = auth.uid()
      limit 1
    )
  order by coalesce(nullif((i.prices->'annual'->>'msrp'),'')::int, i.msrp) asc, i.name asc;
$$;


ALTER FUNCTION "public"."portal_list_products"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."portal_request_quote"("p_item_id" "text", "p_seats" integer, "p_note" "text" DEFAULT NULL::"text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_uid       uuid := auth.uid();
  v_customer  record;
  v_item      record;
  v_seats     int;
  v_rate      int;
  v_value     int;
  v_lead_id   text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  select c.id as customer_id, c.tenant_id, c.name, c.contact_email,
         c.contact_phone, c.gstin, c.state, c.state_code
    into v_customer
  from public.customer_users cu
  join public.customers c on c.id = cu.customer_id
  where cu.auth_user_id = v_uid
  limit 1;

  if v_customer.customer_id is null then
    raise exception 'no customer account' using errcode = 'no_data_found';
  end if;

  select i.id, i.name,
         coalesce(nullif((i.prices->'annual'->>'msrp'),'')::int, i.msrp) as rate
    into v_item
  from public.items i
  where i.id = p_item_id
    and i.tenant_id = v_customer.tenant_id
    and i.is_active = true
    and i.kind = 'main'
  limit 1;

  if v_item.id is null then
    raise exception 'product not available' using errcode = 'no_data_found';
  end if;

  v_seats := greatest(1, least(coalesce(p_seats, 1), 100000));
  v_rate  := coalesce(v_item.rate, 0);
  v_value := v_seats * v_rate * 12;

  v_lead_id := 'L-' || upper(substr(md5(gen_random_uuid()::text), 1, 10));

  insert into public.leads (
    id, tenant_id, company, contact_name, contact_email, contact_phone,
    plan, seats, value, stage, source, priority, gstin, state, state_code, notes
  ) values (
    v_lead_id,
    v_customer.tenant_id,
    v_customer.name,
    v_customer.name,
    v_customer.contact_email,
    v_customer.contact_phone,
    v_item.name,
    v_seats,
    v_value,
    'new',
    'Customer Portal',
    'high',
    v_customer.gstin,
    v_customer.state,
    v_customer.state_code,
    'Portal upsell request from existing customer "' || v_customer.name ||
      '" for ' || v_item.name || ' × ' || v_seats || ' seats.' ||
      case when p_note is not null and length(trim(p_note)) > 0
           then ' Note: ' || left(trim(p_note), 500) else '' end
  );

  return v_lead_id;
end;
$$;


ALTER FUNCTION "public"."portal_request_quote"("p_item_id" "text", "p_seats" integer, "p_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."portal_touch_login"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  update public.customer_users
     set last_login_at = now()
   where auth_user_id = auth.uid();
end;
$$;


ALTER FUNCTION "public"."portal_touch_login"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."purchase_orders_touch_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."purchase_orders_touch_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."queue_support_sync"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_customer record;
  v_plan     text;
begin
  -- No-op update (something unrelated to plan/status/renewal changed) — skip.
  if tg_op = 'UPDATE'
     and old.plan          is not distinct from new.plan
     and old.status        is not distinct from new.status
     and old.renewal_date  is not distinct from new.renewal_date then
    return new;
  end if;

  select name, contact_name, contact_email, domain, customer_number
    into v_customer
    from public.customers
   where id = new.customer_id;

  -- DSP keys the sync on email (or billing_customer_id) — nothing to send
  -- without one.
  if v_customer.contact_email is null then
    return new;
  end if;

  -- A cancelled subscription must downgrade DSP's tier, not just carry a
  -- 'plan_status' field DSP's upsertCustomer never reads for existing
  -- customers.
  v_plan := case when new.status = 'cancelled' then 'free' else new.plan end;

  insert into public.support_sync_outbox (tenant_id, subscription_id, customer_id, payload)
  values (
    new.tenant_id, new.id, new.customer_id,
    jsonb_build_object(
      'event_type', 'subscription.updated',
      'data', jsonb_build_object(
        'billing_customer_id', coalesce(v_customer.customer_number, new.customer_id::text),
        'name',         coalesce(v_customer.contact_name, v_customer.name),
        'email',        v_customer.contact_email,
        'domain',       coalesce(new.domain, v_customer.domain),
        'plan',         v_plan,
        'plan_status',  new.status,
        'plan_expiry',  new.renewal_date
      )
    )
  );

  return new;
end;
$$;


ALTER FUNCTION "public"."queue_support_sync"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."queue_support_sync_on_customer_status"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_sub    record;
  v_plan   text;
  v_status text;
begin
  if old.is_active is not distinct from new.is_active then
    return new;
  end if;
  if new.contact_email is null then
    return new;
  end if;

  for v_sub in
    select id, tenant_id, plan, status, renewal_date, domain
      from public.subscriptions
     where customer_id = new.id and vendor = 'support'
  loop
    if new.is_active then
      -- Reactivated — resync whatever the subscription's own state actually is.
      v_plan   := v_sub.plan;
      v_status := v_sub.status;
    else
      -- Archived — the customer is no longer a support customer regardless
      -- of what the underlying subscription row still says.
      v_plan   := 'free';
      v_status := 'cancelled';
    end if;

    insert into public.support_sync_outbox (tenant_id, subscription_id, customer_id, payload)
    values (
      v_sub.tenant_id, v_sub.id, new.id,
      jsonb_build_object(
        'event_type', 'subscription.updated',
        'data', jsonb_build_object(
          'billing_customer_id', coalesce(new.customer_number, new.id::text),
          'name',         coalesce(new.contact_name, new.name),
          'email',        new.contact_email,
          'domain',       coalesce(v_sub.domain, new.domain),
          'plan',         v_plan,
          'plan_status',  v_status,
          'plan_expiry',  v_sub.renewal_date
        )
      )
    );
  end loop;

  return new;
end;
$$;


ALTER FUNCTION "public"."queue_support_sync_on_customer_status"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."raise_project_milestone_invoice"("p_milestone_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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
  v_full     := v_paid >= v_ms.total_amount;
  v_inv_date := case when v_full and v_pay_date is not null then v_pay_date else current_date end;

  v_rate    := coalesce(v_proj.gst_rate, 18);
  v_taxable := round(v_ms.total_amount * 100.0 / (100 + v_rate));
  v_tax     := v_ms.total_amount - v_taxable;

  v_id := public.next_document_number('invoice', v_ms.tenant_id);
  if v_id is null then raise exception 'Could not allocate invoice number'; end if;

  insert into public.invoices
    (id, tenant_id, customer_id, customer_name, amount, status,
     invoice_date, due_date, paid_date, adjusted_advances, net_payable, quote_id,
     taxable_value, tax_amount, tax_rate, inter_state)
  values
    (v_id, v_ms.tenant_id, v_proj.customer_id, v_proj.customer_name, v_ms.total_amount,
     (case when v_full then 'paid' else 'pending' end)::invoice_status,
     v_inv_date, greatest(coalesce(v_ms.due_date, v_inv_date), v_inv_date),
     case when v_full then v_inv_date else null end,
     '[]'::jsonb,
     case when v_full then 0 else v_ms.total_amount end,
     null,
     v_taxable, v_tax, v_rate, coalesce(v_proj.inter_state, false));

  update public.project_milestones
     set invoice_id = v_id,
         status = case when v_full then 'paid' else 'invoiced' end
   where id = p_milestone_id;

  return v_id;
end;
$$;


ALTER FUNCTION "public"."raise_project_milestone_invoice"("p_milestone_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reconcile_expenses_to_bank_txn"("p_bank_txn_id" "uuid", "p_expense_ids" "text"[]) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn    public.bank_transactions;
  v_sum    integer;
  v_cnt    integer;
  v_want   integer := coalesce(array_length(p_expense_ids, 1), 0);
begin
  select * into v_txn from public.bank_transactions where id = p_bank_txn_id;
  if not found then raise exception 'Bank transaction not found'; end if;
  if v_tenant is not null and v_txn.tenant_id is distinct from v_tenant then
    raise exception 'Not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  if v_txn.debit <= 0 then
    raise exception 'Only a money-out (debit) line can be matched to expenses' using errcode = 'invalid_parameter_value';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This line is already reconciled — un-reconcile it first' using errcode = 'invalid_parameter_value';
  end if;
  if v_want < 1 then raise exception 'Pick at least one expense to match'; end if;

  select coalesce(sum(amount), 0), count(*) into v_sum, v_cnt
  from public.expenses
  where id = any (p_expense_ids) and tenant_id = v_txn.tenant_id and reconciled_txn_id is null;

  if v_cnt <> v_want then
    raise exception 'Some selected expenses are missing or already reconciled — refresh and try again'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_sum <> v_txn.debit then
    raise exception 'Selected expenses total % but this bank line is % — they must add up exactly', v_sum, v_txn.debit
      using errcode = 'invalid_parameter_value';
  end if;

  update public.expenses set reconciled_txn_id = p_bank_txn_id
   where id = any (p_expense_ids) and tenant_id = v_txn.tenant_id;

  update public.salary_payments sp
     set paid_status = 'paid', paid_amount = sp.net, reconciled_txn_id = p_bank_txn_id
   where sp.tenant_id = v_txn.tenant_id and sp.expense_id = any (p_expense_ids) and sp.paid_status <> 'paid';

  update public.bank_transactions
     set matched_to_type = 'split', matched_to_id = null,
         matched_at = now(), matched_by = auth.uid(), match_confidence = 'manual'
   where id = p_bank_txn_id;
end;
$$;


ALTER FUNCTION "public"."reconcile_expenses_to_bank_txn"("p_bank_txn_id" "uuid", "p_expense_ids" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reconcile_salaries_to_bank_txn"("p_bank_txn_id" "uuid", "p_salary_ids" "uuid"[]) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn    public.bank_transactions;
  v_sum    integer;
  v_cnt    integer;
  v_want   integer := coalesce(array_length(p_salary_ids, 1), 0);
begin
  select * into v_txn from public.bank_transactions where id = p_bank_txn_id;
  if not found then raise exception 'Bank transaction not found'; end if;
  if v_tenant is not null and v_txn.tenant_id is distinct from v_tenant then
    raise exception 'Not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  if v_txn.debit <= 0 then
    raise exception 'Only a money-out (debit) line can be matched to salaries' using errcode = 'invalid_parameter_value';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This line is already reconciled — un-reconcile it first' using errcode = 'invalid_parameter_value';
  end if;
  if v_want < 1 then raise exception 'Pick at least one salary to match'; end if;

  select coalesce(sum(net), 0), count(*) into v_sum, v_cnt
  from public.salary_payments
  where id = any (p_salary_ids) and tenant_id = v_txn.tenant_id
    and paid_status = 'unpaid' and reconciled_txn_id is null;

  if v_cnt <> v_want then
    raise exception 'Some selected salaries are missing or already paid — refresh and try again'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_sum <> v_txn.debit then
    raise exception 'Selected salaries total % but this bank line is % — they must add up exactly', v_sum, v_txn.debit
      using errcode = 'invalid_parameter_value';
  end if;

  update public.salary_payments
     set paid_status = 'paid', reconciled_txn_id = p_bank_txn_id
   where id = any (p_salary_ids) and tenant_id = v_txn.tenant_id;

  update public.bank_transactions
     set matched_to_type = 'split', matched_to_id = null,
         matched_at = now(), matched_by = auth.uid(), match_confidence = 'manual'
   where id = p_bank_txn_id;
end;
$$;


ALTER FUNCTION "public"."reconcile_salaries_to_bank_txn"("p_bank_txn_id" "uuid", "p_salary_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reconcile_salary_advance_split"("p_txn_id" "uuid", "p_salary_id" "uuid", "p_advance_amount" integer, "p_employee_name" "text", "p_notes" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn public.bank_transactions%rowtype;
  v_sal public.salary_payments%rowtype;
  v_salary_portion integer;
begin
  select * into v_txn from public.bank_transactions where id = p_txn_id and tenant_id = v_tenant;
  if not found then raise exception 'Bank line not found'; end if;
  if v_txn.matched_to_type is not null then raise exception 'This line is already reconciled'; end if;
  if coalesce(v_txn.debit, 0) <= 0 then raise exception 'Only a money-out line can be split into salary + advance'; end if;

  select * into v_sal from public.salary_payments where id = p_salary_id and tenant_id = v_tenant;
  if not found then raise exception 'Salary not found'; end if;

  if p_advance_amount is null or p_advance_amount <= 0 then raise exception 'Advance amount must be positive'; end if;
  v_salary_portion := v_txn.debit - p_advance_amount;
  if v_salary_portion <= 0 then raise exception 'Salary portion must be positive'; end if;
  if v_salary_portion > (v_sal.net - v_sal.paid_amount) then
    raise exception 'Salary portion (%) is more than the % still due on this salary',
      v_salary_portion, (v_sal.net - v_sal.paid_amount);
  end if;

  update public.salary_payments
     set paid_amount = paid_amount + v_salary_portion,
         paid_status = case
           when paid_amount + v_salary_portion >= net then 'paid'
           when paid_amount + v_salary_portion <= 0   then 'unpaid'
           else 'partial' end,
         reconciled_txn_id = p_txn_id
   where id = p_salary_id;

  insert into public.employee_loans
    (tenant_id, employee_name, principal, disbursed_on, bank_account_id, kind, notes, created_by)
  values
    (v_tenant, trim(coalesce(p_employee_name, 'Employee')), p_advance_amount, v_txn.txn_date, v_txn.bank_account_id,
     'salary_advance', coalesce(nullif(trim(p_notes), ''), 'Salary overpaid — excess booked as recoverable advance'), auth.uid());

  update public.bank_transactions
     set matched_to_type = 'split', matched_to_id = null,
         match_confidence = 'manual', matched_at = now(), matched_by = auth.uid()
   where id = p_txn_id;
end;
$$;


ALTER FUNCTION "public"."reconcile_salary_advance_split"("p_txn_id" "uuid", "p_salary_id" "uuid", "p_advance_amount" integer, "p_employee_name" "text", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_account_transfer"("p_from_account" "uuid", "p_to_account" "uuid", "p_amount" integer, "p_txn_date" "date", "p_note" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_from_name text;
  v_to_name   text;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Transfer amount must be positive';
  end if;
  if p_from_account = p_to_account then
    raise exception 'Cannot transfer to the same account';
  end if;

  select name into v_from_name from public.bank_accounts
    where id = p_from_account and tenant_id = v_tenant;
  if not found then raise exception 'Source account not found'; end if;

  select name into v_to_name from public.bank_accounts
    where id = p_to_account and tenant_id = v_tenant;
  if not found then raise exception 'Destination account not found'; end if;

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
  values
    (v_tenant, p_from_account, p_txn_date,
     coalesce(nullif(p_note, ''), 'Transfer to ' || v_to_name),
     p_amount, 0, 'manual', 'transfer', 'manual');

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
  values
    (v_tenant, p_to_account, p_txn_date,
     coalesce(nullif(p_note, ''), 'Transfer from ' || v_from_name),
     0, p_amount, 'manual', 'transfer', 'manual');
end;
$$;


ALTER FUNCTION "public"."record_account_transfer"("p_from_account" "uuid", "p_to_account" "uuid", "p_amount" integer, "p_txn_date" "date", "p_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_attendance_consent"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_emp uuid;
begin
  select employee_id into v_emp from public.users where id = auth.uid();
  if v_emp is null then raise exception 'Pehle apna employee link karo.'; end if;
  update public.employees
    set attendance_consent_at = now(), attendance_consent_source = 'self'
    where id = v_emp;
end $$;


ALTER FUNCTION "public"."record_attendance_consent"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_business_loan"("p_lender" "text", "p_purpose" "text", "p_principal" integer, "p_interest_rate" numeric, "p_tenure_months" integer, "p_emi_amount" integer, "p_disbursed_on" "date", "p_deposit_account" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_id     uuid;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_principal is null or p_principal <= 0 then raise exception 'Loan amount must be positive'; end if;
  if trim(coalesce(p_lender, '')) = '' then raise exception 'Lender is required'; end if;
  if p_deposit_account is null then raise exception 'Pick the account the money was received into'; end if;
  perform 1 from public.bank_accounts where id = p_deposit_account and tenant_id = v_tenant;
  if not found then raise exception 'Deposit account not found'; end if;

  insert into public.business_loans
    (tenant_id, lender, purpose, principal, interest_rate, tenure_months, emi_amount, disbursed_on, deposit_account_id, status, created_by)
  values
    (v_tenant, trim(p_lender), nullif(trim(coalesce(p_purpose,'')),''), p_principal,
     p_interest_rate, nullif(greatest(coalesce(p_tenure_months,0),0),0), nullif(greatest(coalesce(p_emi_amount,0),0),0),
     p_disbursed_on, p_deposit_account, 'active', auth.uid())
  returning id into v_id;

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
  values
    (v_tenant, p_deposit_account, p_disbursed_on, 'Loan received: ' || trim(p_lender), 0, p_principal, 'manual', 'manual', 'manual');

  return v_id;
end;
$$;


ALTER FUNCTION "public"."record_business_loan"("p_lender" "text", "p_purpose" "text", "p_principal" integer, "p_interest_rate" numeric, "p_tenure_months" integer, "p_emi_amount" integer, "p_disbursed_on" "date", "p_deposit_account" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_emi_payment"("p_purchase_id" "uuid", "p_amount" integer, "p_interest" integer, "p_paid_on" "date", "p_bank_account_id" "uuid", "p_notes" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_p        public.emi_purchases;
  v_paidprin integer;
  v_outstd   integer;
  v_int      integer := greatest(coalesce(p_interest, 0), 0);
  v_prin     integer;
  v_exp_id   text;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'EMI amount must be positive'; end if;
  v_prin := p_amount - v_int;
  if v_prin < 0 then raise exception 'Interest cannot exceed the EMI amount'; end if;

  select * into v_p from public.emi_purchases where id = p_purchase_id and tenant_id = v_tenant;
  if not found then raise exception 'Purchase not found'; end if;

  select coalesce(sum(principal_part), 0) into v_paidprin from public.emi_payments where purchase_id = p_purchase_id;
  v_outstd := v_p.financed - v_paidprin;
  if v_prin > v_outstd then raise exception 'Principal part (%) exceeds outstanding loan (%)', v_prin, v_outstd; end if;

  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Pay-from account not found'; end if;

  if v_int > 0 then
    v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int));
    insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
    values (v_exp_id, v_tenant, 'Interest', coalesce(v_p.lender, v_p.name), p_paid_on, v_int, 0, 'emi', 'EMI interest - ' || v_p.name);
  end if;

  insert into public.emi_payments
    (tenant_id, purchase_id, amount, principal_part, interest_part, paid_on, bank_account_id, expense_id, notes)
  values
    (v_tenant, p_purchase_id, p_amount, v_prin, v_int, p_paid_on, p_bank_account_id, v_exp_id, nullif(trim(coalesce(p_notes,'')),''));

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
  values
    (v_tenant, p_bank_account_id, p_paid_on, 'EMI: ' || v_p.name, p_amount, 0, 'manual', 'manual', 'manual');

  update public.emi_purchases
     set status = case when (v_outstd - v_prin) <= 0 then 'closed' else 'active' end, updated_at = now()
   where id = p_purchase_id;
end;
$$;


ALTER FUNCTION "public"."record_emi_payment"("p_purchase_id" "uuid", "p_amount" integer, "p_interest" integer, "p_paid_on" "date", "p_bank_account_id" "uuid", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_emi_purchase"("p_name" "text", "p_category" "text", "p_total_cost" integer, "p_down_payment" integer, "p_emi_count" integer, "p_emi_amount" integer, "p_purchased_on" "date", "p_down_account" "uuid", "p_lender" "text" DEFAULT NULL::"text", "p_notes" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_id     uuid;
  v_down   integer := greatest(coalesce(p_down_payment, 0), 0);
  v_cat    text := coalesce(nullif(trim(p_category), ''), 'other');
  v_fin    integer;
begin
  if p_total_cost is null or p_total_cost <= 0 then raise exception 'Total cost must be positive'; end if;
  if trim(coalesce(p_name, '')) = '' then raise exception 'Name is required'; end if;
  if v_down > p_total_cost then raise exception 'Down payment cannot exceed total cost'; end if;
  v_fin := p_total_cost - v_down;

  if v_down > 0 then
    if p_down_account is null then raise exception 'Pick the account the down payment came from'; end if;
    perform 1 from public.bank_accounts where id = p_down_account and tenant_id = v_tenant;
    if not found then raise exception 'Down-payment account not found'; end if;
  end if;

  insert into public.emi_purchases
    (tenant_id, name, category, total_cost, down_payment, financed, emi_count, emi_amount, purchased_on, down_account_id, lender, notes, status, created_by)
  values
    (v_tenant, trim(p_name), v_cat, p_total_cost, v_down, v_fin,
     greatest(coalesce(p_emi_count,0),0), greatest(coalesce(p_emi_amount,0),0), p_purchased_on, p_down_account,
     nullif(trim(coalesce(p_lender,'')),''), nullif(trim(coalesce(p_notes,'')),''),
     case when v_fin <= 0 then 'closed' else 'active' end, auth.uid())
  returning id into v_id;

  if v_down > 0 then
    insert into public.bank_transactions
      (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
    values
      (v_tenant, p_down_account, p_purchased_on, 'Purchase: ' || trim(p_name) || ' (down payment)', v_down, 0, 'manual', 'manual', 'manual');
  end if;

  return v_id;
end;
$$;


ALTER FUNCTION "public"."record_emi_purchase"("p_name" "text", "p_category" "text", "p_total_cost" integer, "p_down_payment" integer, "p_emi_count" integer, "p_emi_amount" integer, "p_purchased_on" "date", "p_down_account" "uuid", "p_lender" "text", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_employee_loan_repayment"("p_loan_id" "uuid", "p_amount" integer, "p_repaid_on" "date", "p_method" "text", "p_bank_account_id" "uuid" DEFAULT NULL::"uuid", "p_notes" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant      uuid := public.current_tenant_id();
  v_loan        public.employee_loans;
  v_paid        integer;
  v_outstanding integer;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Repayment amount must be positive';
  end if;
  if p_method not in ('cash', 'bank', 'salary_deduction') then
    raise exception 'Invalid repayment method';
  end if;

  select * into v_loan from public.employee_loans
    where id = p_loan_id and tenant_id = v_tenant;
  if not found then raise exception 'Loan not found'; end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.employee_loan_repayments where loan_id = p_loan_id;
  v_outstanding := v_loan.principal - v_paid;

  if p_amount > v_outstanding then
    raise exception 'Repayment (%) exceeds outstanding (%)', p_amount, v_outstanding;
  end if;

  if p_method in ('cash', 'bank') then
    if p_bank_account_id is null then
      raise exception 'A receiving account is required for a % repayment', p_method;
    end if;
    perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
    if not found then raise exception 'Receiving account not found'; end if;
  end if;

  insert into public.employee_loan_repayments
    (tenant_id, loan_id, amount, repaid_on, method, bank_account_id, notes)
  values
    (v_tenant, p_loan_id, p_amount, p_repaid_on, p_method,
     case when p_method = 'salary_deduction' then null else p_bank_account_id end,
     nullif(trim(coalesce(p_notes, '')), ''));

  if p_method in ('cash', 'bank') then
    insert into public.bank_transactions
      (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
    values
      (v_tenant, p_bank_account_id, p_repaid_on,
       'Loan repayment — ' || v_loan.employee_name, 0, p_amount, 'manual', 'manual', 'manual');
  end if;

  update public.employee_loans
     set status     = case when v_outstanding - p_amount <= 0 then 'closed' else 'active' end,
         updated_at = now()
   where id = p_loan_id;
end;
$$;


ALTER FUNCTION "public"."record_employee_loan_repayment"("p_loan_id" "uuid", "p_amount" integer, "p_repaid_on" "date", "p_method" "text", "p_bank_account_id" "uuid", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_loan_emi"("p_loan_id" "uuid", "p_amount" integer, "p_interest" integer, "p_paid_on" "date", "p_bank_account_id" "uuid", "p_notes" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_l        public.business_loans;
  v_paidprin integer;
  v_outstd   integer;
  v_int      integer := greatest(coalesce(p_interest, 0), 0);
  v_prin     integer;
  v_exp_id   text;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'EMI amount must be positive'; end if;
  v_prin := p_amount - v_int;
  if v_prin < 0 then raise exception 'Interest cannot exceed the EMI amount'; end if;

  select * into v_l from public.business_loans where id = p_loan_id and tenant_id = v_tenant;
  if not found then raise exception 'Loan not found'; end if;

  select coalesce(sum(principal_part), 0) into v_paidprin from public.business_loan_payments where loan_id = p_loan_id;
  v_outstd := v_l.principal - v_paidprin;
  if v_prin > v_outstd then raise exception 'Principal part (%) exceeds outstanding loan (%)', v_prin, v_outstd; end if;

  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Pay-from account not found'; end if;

  if v_int > 0 then
    v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int));
    insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
    values (v_exp_id, v_tenant, 'Interest', v_l.lender, p_paid_on, v_int, 0, 'emi', 'Loan interest — ' || v_l.lender);
  end if;

  insert into public.business_loan_payments
    (tenant_id, loan_id, amount, principal_part, interest_part, paid_on, bank_account_id, expense_id, notes)
  values
    (v_tenant, p_loan_id, p_amount, v_prin, v_int, p_paid_on, p_bank_account_id, v_exp_id, nullif(trim(coalesce(p_notes,'')),''));

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
  values
    (v_tenant, p_bank_account_id, p_paid_on, 'Loan EMI: ' || v_l.lender, p_amount, 0, 'manual', 'manual', 'manual');

  update public.business_loans
     set status = case when (v_outstd - v_prin) <= 0 then 'closed' else 'active' end, updated_at = now()
   where id = p_loan_id;
end;
$$;


ALTER FUNCTION "public"."record_loan_emi"("p_loan_id" "uuid", "p_amount" integer, "p_interest" integer, "p_paid_on" "date", "p_bank_account_id" "uuid", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_payment"("p_quote_id" "text", "p_amount" integer, "p_method" "text", "p_reference" "text", "p_notes" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_quote                 record;
  v_tenant_id             uuid;
  v_caller_tenant         uuid;
  v_is_service_role       boolean;
  v_has_existing_invoice  boolean;
  v_receipt_voucher_no    text := null;
  v_payment_id            uuid;
  v_prior_received        integer;
  v_total_received        integer;
  v_expected              integer;
  v_outstanding           integer;
  v_is_first_payment      boolean;
  v_is_fully_paid         boolean;
  v_new_payment_status    public.payment_status;
  v_customer_id           uuid;
  v_converted_now         boolean := false;
  v_lead                  record;
  v_domain                text;
  v_subscription_created  boolean := false;
  v_new_sub_id            uuid;
  v_first_line            jsonb;
  v_commitment            text;
  v_is_annual             boolean;
  v_plan_name             text;
  v_plan_lower            text;
  v_vendor                public.vendor;
  v_seats                 integer;
  v_is_renewal_quote      boolean := false;
  v_renewal_sub           record;
  v_renewal_rolled_forward boolean := false;
  v_extension_months      integer;
  v_new_mrr               integer;
  v_invoice               record;
  v_already_adjusted      integer;
  v_post_invoice_received integer;
  v_net_due               integer;
  v_invoice_paid          boolean := false;
  v_po_id                 text := null;
  v_po_created            boolean := false;
  v_unit_wholesale_pm     integer;
  v_total_wholesale       integer;
  v_po_seats              integer;
  v_po_months             integer;
  v_po_plan               text;
  v_po_vendor             public.vendor;
  v_po_sub_id             uuid;
  v_was_trial             boolean := false;
  v_existing_payment      record;
  v_is_add_seats          boolean := false;
  v_has_bulk              boolean := false;
  v_bulk_total_seats      integer;
  v_bulk_pool             integer;
  v_running_mrr           integer;
  v_dom_mrr               integer;
  v_dom_seats             integer;
  v_dom                   text;
  v_idx                   integer;
  v_n                     integer;
  v_d                     jsonb;
  v_bulk_count            integer := 0;
  v_start                 date;
  -- 0172: multi-line-item support
  v_line_idx              integer;
  v_line_amount           integer;
  v_first_sub_in_quote    boolean := true;
  -- Only domain/Workspace-type products are meaningfully tied to a single
  -- domain; a quote mixing e.g. a support plan + a hosting plan has no
  -- per-line domain of its own, so both would otherwise fall back to the
  -- SAME customer domain and collide against
  -- subscriptions_tenant_quote_domain_unique (tenant_id, quote_id,
  -- lower(domain)). Track domains already used THIS call and null out any
  -- repeat instead of erroring or silently dropping the subscription.
  v_used_domains          text[] := array[]::text[];
  v_sub_domain            text;
begin
  v_is_service_role := auth.role() = 'service_role';
  if not v_is_service_role then
    v_caller_tenant := public.current_tenant_id();
    if v_caller_tenant is null then
      raise exception 'No tenant context';
    end if;
  end if;

  if p_amount is null or p_amount <= 0 then raise exception 'amount must be > 0'; end if;
  if p_method is null or p_method not in ('upi','razorpay','bank_transfer','cheque','cash','other')
    then raise exception 'invalid payment method: %', p_method; end if;
  if p_reference is null or length(trim(p_reference)) = 0 then raise exception 'reference required'; end if;

  select q.id, q.tenant_id, q.customer_id, q.customer_name, q.lead_id,
         q.amount, q.line_items, q.invoice_id, q.payment_status,
         q.domain, q.extension_months, q.is_add_seats, q.subtotal,
         q.prospect_state_code, q.prospect_state, q.prospect_country
    into v_quote
    from public.quotes q
   where q.id = p_quote_id for update;
  if not found then raise exception 'quote % not found', p_quote_id; end if;
  if not v_is_service_role and v_quote.tenant_id <> v_caller_tenant then
    raise exception 'quote % does not belong to your tenant', p_quote_id;
  end if;

  select p.id, p.receipt_voucher_no, p.customer_id
    into v_existing_payment
    from public.payments p
   where p.tenant_id = v_quote.tenant_id
     and p.quote_id  = p_quote_id
     and p.reference = p_reference
     and p.status    = 'received'
   limit 1;
  if found then
    select coalesce(sum(amount), 0) into v_total_received
      from public.payments where quote_id = p_quote_id and status = 'received';
    v_expected    := coalesce(v_quote.amount, 0);
    v_outstanding := greatest(0, v_expected - v_total_received);
    return jsonb_build_object(
      'payment_id', v_existing_payment.id,
      'receipt_voucher_no', v_existing_payment.receipt_voucher_no,
      'customer_id', v_existing_payment.customer_id,
      'total_received', v_total_received,
      'expected', v_expected,
      'outstanding', v_outstanding,
      'is_first_payment', false,
      'is_fully_paid', v_total_received >= v_expected,
      'idempotent_replay', true,
      'already_recorded', true
    );
  end if;

  v_tenant_id            := v_quote.tenant_id;
  v_has_existing_invoice := v_quote.invoice_id is not null;
  v_expected             := coalesce(v_quote.amount, 0);
  v_domain               := v_quote.domain;
  v_extension_months     := coalesce(v_quote.extension_months, 12);
  v_is_add_seats         := coalesce(v_quote.is_add_seats, false);
  v_has_bulk := exists (
    select 1
      from jsonb_array_elements(case when jsonb_typeof(v_quote.line_items) = 'array' then v_quote.line_items else '[]'::jsonb end) li
     where coalesce((li->>'bulk')::boolean, false)
  );

  select s.id, s.renewal_date, s.seats, s.mrr, s.plan, s.renewal_state, s.vendor, s.customer_id, s.customer_name, s.domain as sub_domain
    into v_renewal_sub
    from public.subscriptions s
   where s.tenant_id = v_tenant_id
     and s.renewal_quote_id = p_quote_id
   for update limit 1;
  v_is_renewal_quote := found;

  select coalesce(sum(amount), 0) into v_prior_received
    from public.payments where quote_id = p_quote_id and status = 'received';
  v_is_first_payment := (v_prior_received = 0);

  v_customer_id := v_quote.customer_id;
  if v_is_first_payment and v_quote.lead_id is not null and v_quote.customer_id is null then
    select l.contact_name, l.contact_email, l.contact_phone, l.company, l.notes, l.domain, l.stage,
           l.state_code, l.state, l.gstin
      into v_lead from public.leads l
     where l.id = v_quote.lead_id and l.tenant_id = v_tenant_id;
    if not found then raise exception 'lead % not found', v_quote.lead_id; end if;
    if v_domain is null then v_domain := v_lead.domain; end if;
    v_was_trial := (v_lead.stage = 'trial');

    insert into public.customers (tenant_id, name, contact_name, contact_email, contact_phone, domain, since, health, notes, state_code, state, gstin)
    values (v_tenant_id, v_lead.company, v_lead.contact_name, v_lead.contact_email, v_lead.contact_phone, v_domain, current_date,
            case when p_amount >= v_expected then 85 else 75 end, v_lead.notes, v_lead.state_code, v_lead.state, v_lead.gstin)
    returning id into v_customer_id;

    update public.leads
       set stage              = 'won',
           trial_converted_at = case when v_was_trial then now() else trial_converted_at end
     where id = v_quote.lead_id and tenant_id = v_tenant_id;
    v_converted_now := true;
  elsif v_is_first_payment and v_quote.customer_id is null and v_quote.lead_id is null then
    insert into public.customers (tenant_id, name, domain, since, health, state_code, state, country)
    values (v_tenant_id, coalesce(nullif(trim(v_quote.customer_name), ''), 'Customer'),
            v_domain, current_date, case when p_amount >= v_expected then 85 else 75 end,
            v_quote.prospect_state_code, v_quote.prospect_state,
            coalesce(nullif(trim(v_quote.prospect_country), ''), 'India'))
    returning id into v_customer_id;
    v_converted_now := true;
  elsif v_quote.lead_id is not null then
    select l.stage into v_lead from public.leads l where l.id = v_quote.lead_id and l.tenant_id = v_tenant_id;
    if v_is_first_payment then
      update public.leads
         set trial_converted_at = case when stage = 'won' and trial_started_at is not null and trial_converted_at is null then now() else trial_converted_at end
       where id = v_quote.lead_id and tenant_id = v_tenant_id;
    end if;
  end if;

  if not v_has_existing_invoice then
    v_receipt_voucher_no := public.next_document_number('receipt_voucher', v_tenant_id);
  end if;

  begin
    insert into public.payments (tenant_id, quote_id, customer_id, amount, method, reference, notes,
      status, received_at, receipt_voucher_no, recorded_by)
    values (v_tenant_id, p_quote_id, v_customer_id, p_amount, p_method, p_reference,
            nullif(trim(coalesce(p_notes, '')), ''), 'received', now(), v_receipt_voucher_no, auth.uid())
    returning id into v_payment_id;
  exception when unique_violation then
    select p.id, p.receipt_voucher_no, p.customer_id into v_existing_payment
      from public.payments p
     where p.tenant_id = v_tenant_id and p.quote_id = p_quote_id
       and p.reference = p_reference and p.status = 'received' limit 1;
    select coalesce(sum(amount), 0) into v_total_received
      from public.payments where quote_id = p_quote_id and status = 'received';
    v_outstanding := greatest(0, v_expected - v_total_received);
    return jsonb_build_object(
      'payment_id', v_existing_payment.id,
      'receipt_voucher_no', v_existing_payment.receipt_voucher_no,
      'customer_id', v_existing_payment.customer_id,
      'total_received', v_total_received,
      'expected', v_expected,
      'outstanding', v_outstanding,
      'is_first_payment', false,
      'is_fully_paid', v_total_received >= v_expected,
      'idempotent_replay', true,
      'already_recorded', true
    );
  end;

  v_total_received := v_prior_received + p_amount;
  v_outstanding    := greatest(0, v_expected - v_total_received);
  v_is_fully_paid  := v_total_received >= v_expected;
  v_new_payment_status := case
    when v_has_existing_invoice then 'invoiced'
    when v_is_fully_paid        then 'received'
    else                             'partial' end::public.payment_status;

  if v_is_first_payment and not v_is_renewal_quote and not v_is_add_seats then
    if jsonb_typeof(v_quote.line_items) = 'array' and jsonb_array_length(v_quote.line_items) > 0 then
      for v_line_idx in 0 .. jsonb_array_length(v_quote.line_items) - 1 loop
        v_first_line := v_quote.line_items -> v_line_idx;
        v_commitment := v_first_line->>'commitment';
        v_plan_name  := coalesce(v_first_line->>'name', 'Annual subscription');
        v_is_annual  := v_commitment is distinct from 'monthly' and v_commitment is not null;
        v_po_sub_id  := null;

        if v_is_annual and v_customer_id is not null then
          -- 0172: exact vendor via the catalog item itself; name-guess only
          -- for lines with no item_id (hand-typed, no catalog link).
          v_vendor := null;
          if v_first_line->>'item_id' is not null then
            select i.vendor into v_vendor from public.items i
             where i.id = v_first_line->>'item_id' and i.tenant_id = v_tenant_id;
          end if;
          if v_vendor is null then
            v_plan_lower := lower(v_plan_name);
            v_vendor := case
              when v_plan_lower like '%google%'    then 'google'::public.vendor
              when v_plan_lower like '%m365%'      then 'microsoft'::public.vendor
              when v_plan_lower like '%microsoft%' then 'microsoft'::public.vendor
              when v_plan_lower like '%365%'       then 'microsoft'::public.vendor
              when v_plan_lower like '%zoho%'      then 'zoho'::public.vendor
              else 'other'::public.vendor end;
          end if;

          v_start := coalesce(nullif(v_first_line->>'start_date', '')::date, current_date);
          v_line_amount := round(
            coalesce((v_first_line->>'qty')::numeric, 0) * coalesce((v_first_line->>'rate')::numeric, 0)
              * (1 - coalesce((v_first_line->>'discount_pct')::numeric, 0) / 100)
          )::int;

          if coalesce((v_first_line->>'bulk')::boolean, false)
             and jsonb_typeof(v_first_line->'domains') = 'array'
             and jsonb_array_length(v_first_line->'domains') > 0 then
            select coalesce(sum((e->>'seats')::int), 0) into v_bulk_total_seats
              from jsonb_array_elements(v_first_line->'domains') e;
            if v_bulk_total_seats <= 0 then
              raise exception 'bulk line has zero total seats (quote %)', p_quote_id;
            end if;
            v_bulk_pool := greatest(0, round(coalesce(v_line_amount, v_expected) / 12.0))::int;
            v_running_mrr := 0;
            v_idx := 0;
            v_n := jsonb_array_length(v_first_line->'domains');
            for v_d in select e from jsonb_array_elements(v_first_line->'domains') e loop
              v_idx := v_idx + 1;
              v_dom := lower(trim(v_d->>'domain'));
              v_dom_seats := coalesce((v_d->>'seats')::int, 0);
              if v_dom = '' then continue; end if;
              if v_idx < v_n then
                v_dom_mrr := floor(v_bulk_pool::numeric * v_dom_seats / v_bulk_total_seats)::int;
              else
                v_dom_mrr := v_bulk_pool - v_running_mrr;
              end if;
              v_running_mrr := v_running_mrr + v_dom_mrr;

              insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                start_date, renewal_date, status, outstanding_amount, domain, quote_id)
              values (v_tenant_id, v_customer_id, v_quote.customer_name, v_plan_name, v_vendor, v_dom_seats, v_dom_mrr,
                v_start, (v_start + interval '1 year')::date, 'active', 0, v_dom, p_quote_id)
              on conflict (tenant_id, quote_id, lower(domain)) where quote_id is not null and domain is not null
                do nothing
              returning id into v_new_sub_id;

              insert into public.customer_domains (tenant_id, customer_id, domain)
              values (v_tenant_id, v_customer_id, v_dom)
              on conflict (tenant_id, lower(domain)) do nothing;

              v_bulk_count := v_bulk_count + 1;
              v_used_domains := array_append(v_used_domains, v_dom);
            end loop;
            v_subscription_created := true;
            v_first_sub_in_quote := false;
            v_po_seats := v_bulk_total_seats; v_po_months := 12; v_po_plan := v_plan_name;
            v_po_vendor := v_vendor; v_po_sub_id := v_new_sub_id;
          else
            v_seats := coalesce((v_first_line->>'qty')::int, 0);
            -- 0172: prefer THIS line's own domain (the quote builder now lets
            -- staff type a distinct domain per product line) over the
            -- whole-quote/customer fallback below, which was the only source
            -- before per-line domains existed.
            v_sub_domain := nullif(lower(trim(v_first_line->>'domain')), '');
            if v_sub_domain is null then
              if v_domain is null and v_customer_id is not null then
                select domain into v_domain from public.customers where id = v_customer_id;
              end if;
              v_sub_domain := v_domain;
            end if;
            if v_sub_domain is not null and lower(v_sub_domain) = any(v_used_domains) then
              v_sub_domain := null;
            end if;
            insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
              start_date, renewal_date, status, outstanding_amount, domain, quote_id)
            values (v_tenant_id, v_customer_id, v_quote.customer_name, v_plan_name, v_vendor, v_seats,
              greatest(0, round(v_line_amount / 12.0))::int, v_start,
              (v_start + interval '1 year')::date, 'active',
              case when v_first_sub_in_quote then v_outstanding else 0 end,
              v_sub_domain, p_quote_id)
            returning id into v_new_sub_id;
            if v_sub_domain is not null then
              v_used_domains := array_append(v_used_domains, lower(v_sub_domain));
            end if;
            v_subscription_created := true;
            v_first_sub_in_quote := false;
            v_po_seats := v_seats; v_po_months := 12; v_po_plan := v_plan_name;
            v_po_vendor := v_vendor; v_po_sub_id := v_new_sub_id;
          end if;

          if v_po_sub_id is not null then
            select coalesce(nullif((prices->'annual'->>'wholesale')::int, 0), nullif(wholesale, 0))
              into v_unit_wholesale_pm from public.items
             where tenant_id = v_tenant_id and lower(name) = lower(v_po_plan) limit 1;
            if v_unit_wholesale_pm is null or v_unit_wholesale_pm <= 0 then
              v_unit_wholesale_pm := greatest(0, round(coalesce(v_line_amount, v_expected)::numeric * 0.83 / greatest(v_po_seats * v_po_months, 1)))::int;
            end if;
            v_total_wholesale := v_unit_wholesale_pm * v_po_seats * v_po_months;
            v_po_id := public.next_document_number('purchase_order', v_tenant_id);
            insert into public.purchase_orders (
              id, tenant_id, subscription_id, customer_id, customer_name, domain,
              vendor, plan, seats, term_months, unit_cost_pm, total_cost, status, notes, created_by
            ) values (
              v_po_id, v_tenant_id, v_po_sub_id, v_customer_id, v_quote.customer_name, v_domain,
              v_po_vendor, v_po_plan, v_po_seats, v_po_months, v_unit_wholesale_pm, v_total_wholesale, 'draft',
              'Auto-created from quote ' || p_quote_id ||
              case when coalesce((v_first_line->>'bulk')::boolean, false) then ' (bulk order - ' || v_bulk_count || ' domains)'
                   else ' (new sub)' end,
              auth.uid()
            );
            v_po_created := true;
          end if;
        end if;
      end loop;
    end if;
    v_po_sub_id := null;
  elsif v_customer_id is not null and not v_is_renewal_quote and not v_is_add_seats and not v_has_bulk then
    update public.subscriptions set outstanding_amount = v_outstanding
     where tenant_id = v_tenant_id and customer_id = v_customer_id and quote_id = p_quote_id and outstanding_amount > 0;
  end if;

  if v_is_renewal_quote and v_is_fully_paid then
    v_first_line := case
      when jsonb_typeof(v_quote.line_items) = 'array' and jsonb_array_length(v_quote.line_items) > 0
        then v_quote.line_items->0 else null end;
    if v_first_line is not null then
      v_plan_name := coalesce(v_first_line->>'name', v_renewal_sub.plan);
      v_seats     := coalesce((v_first_line->>'qty')::int, v_renewal_sub.seats);
    else
      v_plan_name := v_renewal_sub.plan; v_seats := v_renewal_sub.seats;
    end if;
    v_new_mrr := greatest(0, round(coalesce(v_quote.subtotal, v_expected)::numeric / greatest(v_extension_months, 1)))::int;
    update public.subscriptions
       set renewal_state = case when v_extension_months >= 12 then 'renewed' else renewal_state end,
           renewal_date  = (v_renewal_sub.renewal_date + (v_extension_months || ' months')::interval)::date,
           seats = v_seats, plan = v_plan_name,
           mrr   = case when v_new_mrr > 0 then v_new_mrr else mrr end,
           outstanding_amount = 0, renewal_quote_id = null,
           reminder_count = 0, last_reminder_sent_at_v2 = null, status = 'active'
     where id = v_renewal_sub.id and tenant_id = v_tenant_id;
    v_renewal_rolled_forward := true;
    v_po_seats := v_seats; v_po_months := v_extension_months;
    v_po_plan := v_plan_name; v_po_vendor := v_renewal_sub.vendor; v_po_sub_id := v_renewal_sub.id;
  end if;

  if v_po_sub_id is not null then
    select coalesce(nullif((prices->'annual'->>'wholesale')::int, 0), nullif(wholesale, 0))
      into v_unit_wholesale_pm from public.items
     where tenant_id = v_tenant_id and lower(name) = lower(v_po_plan) limit 1;
    if v_unit_wholesale_pm is null or v_unit_wholesale_pm <= 0 then
      v_unit_wholesale_pm := greatest(0, round(v_expected::numeric * 0.83 / greatest(v_po_seats * v_po_months, 1)))::int;
    end if;
    v_total_wholesale := v_unit_wholesale_pm * v_po_seats * v_po_months;
    v_po_id := public.next_document_number('purchase_order', v_tenant_id);
    insert into public.purchase_orders (
      id, tenant_id, subscription_id, customer_id, customer_name, domain,
      vendor, plan, seats, term_months, unit_cost_pm, total_cost, status, notes, created_by
    ) values (
      v_po_id, v_tenant_id, v_po_sub_id, v_customer_id, v_quote.customer_name, v_domain,
      v_po_vendor, v_po_plan, v_po_seats, v_po_months, v_unit_wholesale_pm, v_total_wholesale, 'draft',
      'Auto-created from quote ' || p_quote_id ||
      case when v_is_renewal_quote then ' (renewal/extension)'
           when v_bulk_count > 0    then ' (bulk order - ' || v_bulk_count || ' domains)'
           else ' (new sub)' end,
      auth.uid()
    );
    v_po_created := true;
  end if;

  update public.quotes
     set payment_status = v_new_payment_status,
         payment_amount = v_total_received,
         payment_method = p_method,
         payment_reference = p_reference,
         payment_received_at = now(),
         payment_notes = nullif(trim(coalesce(p_notes, '')), ''),
         customer_id = v_customer_id,
         status = case
           when v_is_fully_paid and status in ('draft', 'sent', 'viewed') then 'accepted'::public.quote_status
           else status
         end
   where id = p_quote_id and tenant_id = v_tenant_id;

  if v_has_existing_invoice then
    select i.amount, i.net_payable, i.status, i.adjusted_advances into v_invoice
      from public.invoices i where i.id = v_quote.invoice_id and i.tenant_id = v_tenant_id;
    if found and v_invoice.status <> 'paid' then
      v_already_adjusted := coalesce((select sum((adv->>'amount')::int) from jsonb_array_elements(v_invoice.adjusted_advances) adv), 0);
      v_post_invoice_received := v_total_received - v_already_adjusted;
      v_net_due := coalesce(v_invoice.net_payable, v_invoice.amount);
      if v_post_invoice_received >= v_net_due then
        update public.invoices set status = 'paid', paid_date = current_date
         where id = v_quote.invoice_id and tenant_id = v_tenant_id;
        v_invoice_paid := true;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'payment_id', v_payment_id,
    'receipt_voucher_no', v_receipt_voucher_no,
    'customer_id', v_customer_id,
    'total_received', v_total_received,
    'expected', v_expected,
    'outstanding', v_outstanding,
    'is_first_payment', v_is_first_payment,
    'is_fully_paid', v_is_fully_paid,
    'converted_now', v_converted_now,
    'subscription_created', v_subscription_created,
    'bulk_domains_created', v_bulk_count,
    'invoice_paid', v_invoice_paid,
    'has_existing_invoice', v_has_existing_invoice,
    'is_renewal_quote', v_is_renewal_quote,
    'renewal_rolled_forward', v_renewal_rolled_forward,
    'extension_months', v_extension_months,
    'domain', v_domain,
    'po_id', v_po_id,
    'po_created', v_po_created,
    'was_trial', v_was_trial,
    'is_add_seats', v_is_add_seats,
    'idempotent_replay', false
  );
end;
$$;


ALTER FUNCTION "public"."record_payment"("p_quote_id" "text", "p_amount" integer, "p_method" "text", "p_reference" "text", "p_notes" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."record_payment"("p_quote_id" "text", "p_amount" integer, "p_method" "text", "p_reference" "text", "p_notes" "text") IS 'Atomically records a payment against a quote: issues RV (if pre-invoice), inserts payment ledger row, converts prospect→customer on first payment, promotes lead, creates annual subscription, updates outstanding, marks invoice paid, and ROLLS RENEWAL SUBSCRIPTIONS FORWARD when a renewal quote is fully paid. Single transaction — all or nothing.';



CREATE OR REPLACE FUNCTION "public"."record_payment_with_tds"("p_quote_id" "text", "p_amount" integer, "p_method" "text", "p_reference" "text", "p_notes" "text" DEFAULT NULL::"text", "p_tds_amount" integer DEFAULT 0, "p_tds_gross" integer DEFAULT 0, "p_tds_net_paid" integer DEFAULT 0, "p_tds_section" "text" DEFAULT NULL::"text", "p_tds_rate_pct" numeric DEFAULT NULL::numeric, "p_customer_tan" "text" DEFAULT NULL::"text", "p_invoice_id" "text" DEFAULT NULL::"text", "p_fiscal_year" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_result    jsonb;
  v_replay    boolean;
  v_pay_id    uuid;
  v_tenant    uuid;
  v_cust      uuid;
  v_cust_name text;
  v_tds_saved boolean := false;
begin
  v_result := public.record_payment(p_quote_id, p_amount, p_method, p_reference, p_notes);

  v_replay := coalesce((v_result->>'already_recorded')::boolean, false)
           or coalesce((v_result->>'idempotent_replay')::boolean, false);
  v_pay_id := nullif(v_result->>'payment_id', '')::uuid;

  if not v_replay and coalesce(p_tds_amount, 0) > 0 then
    select tenant_id, customer_name into v_tenant, v_cust_name
      from public.quotes where id = p_quote_id;
    v_cust := nullif(v_result->>'customer_id', '')::uuid;

    insert into public.tds_receivable (
      id, tenant_id, invoice_id, payment_id, customer_id, customer_name,
      customer_tan, section, rate_pct, gross_amount, tds_amount, net_paid,
      fiscal_year, payment_received_date, status, notes
    ) values (
      'TDS-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 10)),
      v_tenant, p_invoice_id, v_pay_id, v_cust, coalesce(v_cust_name, ''),
      nullif(trim(p_customer_tan), ''), coalesce(p_tds_section, '194J'), p_tds_rate_pct,
      p_tds_gross, p_tds_amount, p_tds_net_paid,
      coalesce(p_fiscal_year, public.indian_fiscal_year(current_date)),
      current_date, 'pending_cert',
      'Auto-created atomically with payment ' || coalesce(v_pay_id::text, '?') || ' on quote ' || p_quote_id
    );
    v_tds_saved := true;
  end if;

  return v_result || jsonb_build_object('tds_saved', v_tds_saved);
end;
$$;


ALTER FUNCTION "public"."record_payment_with_tds"("p_quote_id" "text", "p_amount" integer, "p_method" "text", "p_reference" "text", "p_notes" "text", "p_tds_amount" integer, "p_tds_gross" integer, "p_tds_net_paid" integer, "p_tds_section" "text", "p_tds_rate_pct" numeric, "p_customer_tan" "text", "p_invoice_id" "text", "p_fiscal_year" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_project_payment"("p_milestone_id" "uuid", "p_amount" integer, "p_method" "text", "p_reference" "text", "p_received_at" "date", "p_bank_txn_id" "uuid" DEFAULT NULL::"uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_ms       record;
  v_pay_id   uuid;
  v_paid     integer;
begin
  select * into v_ms from public.project_milestones where id = p_milestone_id for update;
  if not found then raise exception 'Milestone not found'; end if;
  if v_tenant is not null and v_ms.tenant_id is distinct from v_tenant then
    raise exception 'Milestone not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Amount must be > 0'; end if;

  insert into public.project_payments
    (tenant_id, project_id, milestone_id, amount, method, reference, received_at, bank_txn_id)
  values
    (v_ms.tenant_id, v_ms.project_id, p_milestone_id, p_amount,
     nullif(trim(coalesce(p_method,'')),''), nullif(trim(coalesce(p_reference,'')),''),
     coalesce(p_received_at, current_date), p_bank_txn_id)
  returning id into v_pay_id;

  select coalesce(sum(amount), 0) into v_paid
    from public.project_payments where milestone_id = p_milestone_id;
  if v_paid >= v_ms.total_amount then
    update public.project_milestones set status = 'paid' where id = p_milestone_id;
    if v_ms.invoice_id is not null then
      update public.invoices set status = 'paid'::invoice_status, paid_date = coalesce(p_received_at, current_date)
       where id = v_ms.invoice_id;
    end if;
  end if;

  if p_bank_txn_id is not null then
    update public.bank_transactions
       set matched_to_type = 'project', matched_to_id = v_pay_id::text,
           matched_at = now(), match_confidence = 'manual'
     where id = p_bank_txn_id and tenant_id = v_ms.tenant_id;
  end if;

  return v_pay_id;
end;
$$;


ALTER FUNCTION "public"."record_project_payment"("p_milestone_id" "uuid", "p_amount" integer, "p_method" "text", "p_reference" "text", "p_received_at" "date", "p_bank_txn_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."redeem_coupon"("p_code" "text", "p_tenant_id" "uuid", "p_tier_id" "text", "p_seats" integer, "p_gross_amount" integer, "p_quote_id" "text" DEFAULT NULL::"text", "p_lead_id" "text" DEFAULT NULL::"text", "p_email" "text" DEFAULT NULL::"text", "p_name" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_coupon       record;
  v_discount     integer;
  v_now          timestamptz := now();
begin
  select * into v_coupon
  from public.coupons
  where code = upper(trim(p_code)) and tenant_id = p_tenant_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'invalid_code');
  end if;

  if not v_coupon.is_active then
    return jsonb_build_object('ok', false, 'reason', 'inactive');
  end if;
  if v_coupon.valid_from > v_now then
    return jsonb_build_object('ok', false, 'reason', 'not_started');
  end if;
  if v_coupon.valid_until is not null and v_coupon.valid_until < v_now then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if v_coupon.max_redemptions is not null
     and v_coupon.redemption_count >= v_coupon.max_redemptions then
    return jsonb_build_object('ok', false, 'reason', 'maxed_out');
  end if;
  if v_coupon.applies_to_tier is not null
     and lower(v_coupon.applies_to_tier) <> lower(coalesce(p_tier_id, '')) then
    return jsonb_build_object('ok', false, 'reason', 'wrong_tier',
      'required_tier', v_coupon.applies_to_tier);
  end if;
  if p_seats < v_coupon.min_seats then
    return jsonb_build_object('ok', false, 'reason', 'min_seats_not_met',
      'min_seats', v_coupon.min_seats);
  end if;
  if v_coupon.max_seats is not null and p_seats > v_coupon.max_seats then
    return jsonb_build_object('ok', false, 'reason', 'max_seats_exceeded',
      'max_seats', v_coupon.max_seats);
  end if;

  if v_coupon.discount_type = 'percent' then
    v_discount := round(p_gross_amount * v_coupon.discount_value / 100.0);
  else
    v_discount := v_coupon.discount_value;
  end if;
  v_discount := least(v_discount, p_gross_amount);

  insert into public.coupon_redemptions (
    coupon_code, tenant_id, quote_id, lead_id, contact_email, contact_name,
    tier_id, seats, amount_saved
  ) values (
    v_coupon.code, p_tenant_id, p_quote_id, p_lead_id, p_email, p_name,
    p_tier_id, p_seats, v_discount
  );

  update public.coupons
    set redemption_count = redemption_count + 1
    where code = v_coupon.code;

  return jsonb_build_object(
    'ok',             true,
    'discount',       v_discount,
    'discount_type',  v_coupon.discount_type,
    'discount_value', v_coupon.discount_value,
    'code',           v_coupon.code
  );
end;
$$;


ALTER FUNCTION "public"."redeem_coupon"("p_code" "text", "p_tenant_id" "uuid", "p_tier_id" "text", "p_seats" integer, "p_gross_amount" integer, "p_quote_id" "text", "p_lead_id" "text", "p_email" "text", "p_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."redeem_customer_credits"("p_customer_id" "uuid", "p_amount" integer, "p_note" "text" DEFAULT NULL::"text") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant    uuid    := public.current_tenant_id();
  v_remaining integer := greatest(0, coalesce(p_amount, 0));
  v_consumed  integer := 0;
  v_take      integer;
  v_row       record;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if v_remaining <= 0 then return 0; end if;

  for v_row in
    select id, amount from public.customer_credits
     where tenant_id = v_tenant and customer_id = p_customer_id and status = 'open'
     order by created_at asc
     for update
  loop
    exit when v_remaining <= 0;
    v_take := least(v_row.amount, v_remaining);
    if v_take >= v_row.amount then
      update public.customer_credits set status = 'used' where id = v_row.id;
    else
      update public.customer_credits set amount = amount - v_take where id = v_row.id;
      insert into public.customer_credits (tenant_id, customer_id, amount, source, note, status)
      values (v_tenant, p_customer_id, v_take, 'redeemed_split',
              coalesce(nullif(trim(p_note), ''), 'Partial advance credit applied'), 'used');
    end if;
    v_consumed  := v_consumed + v_take;
    v_remaining := v_remaining - v_take;
  end loop;

  return v_consumed;
end; $$;


ALTER FUNCTION "public"."redeem_customer_credits"("p_customer_id" "uuid", "p_amount" integer, "p_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reject_expense_claim"("p_claim_id" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_status text;
begin
  select status into v_status from public.expense_claims
    where id = p_claim_id and tenant_id = v_tenant;
  if not found then raise exception 'Claim not found'; end if;
  if v_status <> 'pending' then raise exception 'This claim is already %', v_status; end if;

  update public.expense_claims
     set status = 'rejected', reject_reason = nullif(trim(coalesce(p_reason, '')), ''), reviewed_at = now()
   where id = p_claim_id and tenant_id = v_tenant;
end;
$$;


ALTER FUNCTION "public"."reject_expense_claim"("p_claim_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reopen_quote"("p_quote_id" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_quote record;
begin
  select id, tenant_id, status, payment_status, invoice_id
    into v_quote
    from public.quotes where id = p_quote_id
    for update;
  if not found then
    raise exception 'Quote % not found', p_quote_id using errcode = 'no_data_found';
  end if;

  if public.current_tenant_id() is not null
     and v_quote.tenant_id is distinct from public.current_tenant_id() then
    raise exception 'Quote % is not in the caller''s tenant', p_quote_id
      using errcode = 'insufficient_privilege';
  end if;

  if v_quote.status <> 'accepted' then
    raise exception 'Only an accepted quote can be reopened (this one is %)', v_quote.status
      using errcode = 'check_violation';
  end if;

  -- Money guard — never reopen once a payment or invoice exists.
  if v_quote.invoice_id is not null
     or v_quote.payment_status in ('received', 'partial', 'invoiced')
     or exists (select 1 from public.payments p where p.quote_id = p_quote_id and p.status = 'received') then
    raise exception 'Can''t reopen — this quote has a payment or invoice. Reverse those first.'
      using errcode = 'check_violation';
  end if;

  update public.quotes
     set status = 'sent', payment_status = 'none'::payment_status
   where id = p_quote_id;
end;
$$;


ALTER FUNCTION "public"."reopen_quote"("p_quote_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reset_tenant_selected_tables"("p_tables" "text"[], "p_label" "text", "p_confirm_statutory" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_tenant   uuid;
  v_role     text;
  v_backup   jsonb;
  v_bad      text[];
  v_stat     text[];
  r          record;
  v_deleted  jsonb := '{}'::jsonb;
  n          bigint;
begin
  select tenant_id, role into v_tenant, v_role from public.users where id = auth.uid();
  if v_tenant is null then
    raise exception 'No tenant for caller';
  end if;
  if coalesce(v_role, '') <> 'owner' then
    raise exception 'Only the owner can reset data. Ask the account owner to do this.';
  end if;

  if p_tables is null or cardinality(p_tables) = 0 then
    raise exception 'Nothing selected. Tick at least one section to reset.';
  end if;

  select array_agg(t) into v_bad
  from unnest(p_tables) t
  where t not in (select key from backup._resettable());

  if v_bad is not null then
    raise exception 'Not resettable: %. Allowed: %',
      array_to_string(v_bad, ', '),
      (select string_agg(distinct key, ', ' order by key) from backup._resettable());
  end if;

  select array_agg(distinct key) into v_stat
  from backup._resettable()
  where statutory and key = any(p_tables);

  if v_stat is not null and not p_confirm_statutory then
    raise exception
      'Refusing to reset % — these are statutory records (GST invoice series must have no gaps; attendance backs payroll). Re-run with the statutory confirmation if you are certain.',
      array_to_string(v_stat, ', ');
  end if;

  v_backup := backup._take(v_tenant, 'Pre-Reset Safeguard Snapshot - ' || coalesce(p_label, 'unlabelled'), 'pre_reset');

  if v_backup is null
     or coalesce((v_backup->>'bytes')::bigint, 0) = 0
     or coalesce((v_backup->>'table_count')::int, 0) = 0 then
    raise exception 'Pre-reset backup produced an empty snapshot — refusing to delete anything. Nothing has been changed.';
  end if;

  for r in
    select tbl from backup._resettable() where key = any(p_tables)
  loop
    if to_regclass('public.' || quote_ident(r.tbl)) is null then
      raise exception 'Reset allowlist is stale: table public.% does not exist. Nothing has been changed.', r.tbl;
    end if;
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = r.tbl and column_name = 'tenant_id'
    ) then
      raise exception 'Refusing to reset public.% — it has no tenant_id, so the delete could not be scoped to one tenant. Nothing has been changed.', r.tbl;
    end if;

    execute format('delete from public.%I where tenant_id = $1', r.tbl) using v_tenant;
    get diagnostics n = row_count;
    v_deleted := v_deleted || jsonb_build_object(r.tbl, n);
  end loop;

  return jsonb_build_object(
    'backup_id',  v_backup->>'id',
    'backup_bytes', (v_backup->>'bytes')::bigint,
    'deleted',    v_deleted,
    'label',      p_label
  );
end $_$;


ALTER FUNCTION "public"."reset_tenant_selected_tables"("p_tables" "text"[], "p_label" "text", "p_confirm_statutory" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."reset_tenant_selected_tables"("p_tables" "text"[], "p_label" "text", "p_confirm_statutory" boolean) IS 'Owner-only selective reset. Takes a pre_reset snapshot FIRST and aborts if it is empty; backup and deletes share one transaction, so the only outcomes are both or neither.';



CREATE OR REPLACE FUNCTION "public"."resolve_or_create_contact"("p_tenant" "uuid", "p_email" "text", "p_phone" "text", "p_name" "text", "p_company" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email   text := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_digits  text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_phone10 text;
  v_id      text;
begin
  if length(v_digits) >= 10 then v_phone10 := right(v_digits, 10); else v_phone10 := null; end if;
  if v_email is not null and position('@' in v_email) = 0 then v_email := null; end if;
  if v_email is null and v_phone10 is null then return null; end if;

  select c.id into v_id from public.contacts c
  where c.tenant_id = p_tenant and (
    (v_email is not null and exists (select 1 from jsonb_array_elements(c.emails) e where lower(trim(e->>'value')) = v_email))
    or (v_phone10 is not null and exists (select 1 from jsonb_array_elements(c.phones) ph where right(regexp_replace(coalesce(ph->>'value',''),'\D','','g'),10) = v_phone10))
  ) order by c.created_at asc limit 1;

  if v_id is not null then
    if v_email is not null and not exists (select 1 from jsonb_array_elements((select emails from public.contacts where id=v_id)) e where lower(trim(e->>'value'))=v_email) then
      update public.contacts set emails = emails || jsonb_build_array(jsonb_build_object('value',trim(p_email),'label','other')), email = coalesce(nullif(email,''),trim(p_email)) where id=v_id;
    end if;
    if v_phone10 is not null and not exists (select 1 from jsonb_array_elements((select phones from public.contacts where id=v_id)) ph where right(regexp_replace(coalesce(ph->>'value',''),'\D','','g'),10)=v_phone10) then
      update public.contacts set phones = phones || jsonb_build_array(jsonb_build_object('value',trim(p_phone),'label','mobile')), phone = coalesce(nullif(phone,''),trim(p_phone)) where id=v_id;
    end if;
    return v_id;
  end if;

  v_id := 'C-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,12));
  insert into public.contacts (id, tenant_id, full_name, company, email, phone, emails, phones, source, status)
  values (v_id, p_tenant,
    coalesce(nullif(trim(coalesce(p_name,'')),''), nullif(trim(coalesce(p_company,'')),''), v_email, 'Unknown'),
    nullif(trim(coalesce(p_company,'')),''), v_email, nullif(trim(coalesce(p_phone,'')),''),
    case when v_email is not null then jsonb_build_array(jsonb_build_object('value',trim(p_email),'label','other')) else '[]'::jsonb end,
    case when v_phone10 is not null then jsonb_build_array(jsonb_build_object('value',trim(p_phone),'label','mobile')) else '[]'::jsonb end,
    'enquiry','engaged');
  return v_id;
end; $$;


ALTER FUNCTION "public"."resolve_or_create_contact"("p_tenant" "uuid", "p_email" "text", "p_phone" "text", "p_name" "text", "p_company" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."restore_tenant_backup"("p_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_tenant uuid; v_role text; v_payload jsonb; r record; col_list text; has_identity bool; n int := 0;
begin
  select tenant_id, role into v_tenant, v_role from public.users where id = auth.uid();
  if v_tenant is null then raise exception 'No tenant for caller'; end if;
  if coalesce(v_role, '') <> 'owner' then raise exception 'Only the owner can restore'; end if;
  select payload into v_payload from backup.snapshots where id = p_id and tenant_id = v_tenant;
  if v_payload is null then raise exception 'Restore point not found'; end if;

  perform backup._take(v_tenant, 'Before restore ' || to_char(now(), 'DD Mon HH24:MI'), 'auto');

  set local session_replication_role = replica;

  for r in
    select c.table_name from information_schema.columns c
    join pg_tables pt on pt.schemaname='public' and pt.tablename=c.table_name
    where c.table_schema='public' and c.column_name='tenant_id' and c.table_name not in ('tenant_secrets','users')
    group by c.table_name order by c.table_name
  loop
    if not (v_payload ? r.table_name) then continue; end if;
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position), bool_or(is_identity = 'YES')
      into col_list, has_identity
    from information_schema.columns
    where table_schema='public' and table_name = r.table_name and is_generated <> 'ALWAYS';
    execute format('delete from public.%I where tenant_id = $1', r.table_name) using v_tenant;
    execute format(
      'insert into public.%I (%s) %s select %s from jsonb_populate_recordset(null::public.%I, $1)',
      r.table_name, col_list, case when has_identity then 'overriding system value' else '' end, col_list, r.table_name
    ) using (v_payload -> r.table_name);
    n := n + 1;
  end loop;

  set local session_replication_role = origin;
  return jsonb_build_object('restored_tables', n, 'restored_at', now());
end $_$;


ALTER FUNCTION "public"."restore_tenant_backup"("p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_document_series_start"("p_doc_type" "text", "p_fiscal_year" "text", "p_start_number" integer, "p_prefix" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant_id uuid;
  v_is_owner  boolean;
  v_prefix    text;
begin
  v_tenant_id := public.current_tenant_id();
  if v_tenant_id is null then raise exception 'No tenant context'; end if;

  select exists (
    select 1 from public.users
    where id = auth.uid() and tenant_id = v_tenant_id and role = 'owner'
  ) into v_is_owner;

  if not v_is_owner then
    raise exception 'Only tenant owners can modify document sequence';
  end if;

  v_prefix := coalesce(p_prefix, public.default_doc_prefix(p_doc_type));

  insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values (v_tenant_id, p_doc_type, p_fiscal_year, v_prefix, p_start_number)
  on conflict (tenant_id, doc_type, fiscal_year)
  do update set last_number = excluded.last_number, prefix = excluded.prefix, updated_at = now();
end;
$$;


ALTER FUNCTION "public"."set_document_series_start"("p_doc_type" "text", "p_fiscal_year" "text", "p_start_number" integer, "p_prefix" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_employee_pin"("p_employee_id" "uuid", "p_pin" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $_$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then
    raise exception 'PIN must be 4 to 6 digits';
  end if;
  update public.employees
     set pin_hash = crypt(p_pin, gen_salt('bf')), updated_at = now()
   where id = p_employee_id and tenant_id = v_tenant;
  if not found then raise exception 'Employee not found'; end if;
end;
$_$;


ALTER FUNCTION "public"."set_employee_pin"("p_employee_id" "uuid", "p_pin" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_my_employee"("p_employee_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_tenant uuid; v_user_email text; v_emp_email text;
begin
  select tenant_id, email into v_tenant, v_user_email from public.users where id = auth.uid();
  if v_tenant is null then raise exception 'No tenant for caller'; end if;
  if not exists (select 1 from public.employees where id = p_employee_id and tenant_id = v_tenant) then
    raise exception 'Employee not in your workspace';
  end if;
  if exists (select 1 from public.users where employee_id = p_employee_id and id <> auth.uid()) then
    raise exception 'Ye employee record kisi aur user se already linked hai — owner se kaho.';
  end if;
  select email into v_emp_email from public.employees where id = p_employee_id;
  if v_emp_email is not null and lower(v_emp_email) <> lower(coalesce(v_user_email, '')) then
    raise exception 'Aapka login email is employee se match nahi karta — owner se kaho ki Employees me aapko link kare.';
  end if;
  update public.users set employee_id = p_employee_id where id = auth.uid();
end $$;


ALTER FUNCTION "public"."set_my_employee"("p_employee_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_subscription_auto_renew"("p_sub_id" "uuid", "p_value" boolean) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_cust    uuid := public.current_customer_id();
  v_updated integer;
begin
  if v_cust is null then
    raise exception 'No customer context' using errcode = 'insufficient_privilege';
  end if;

  update public.subscriptions
     set auto_renew = coalesce(p_value, false)
   where id = p_sub_id
     and customer_id = v_cust;
  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    raise exception 'Subscription % not found for this customer', p_sub_id
      using errcode = 'no_data_found';
  end if;

  return coalesce(p_value, false);
end;
$$;


ALTER FUNCTION "public"."set_subscription_auto_renew"("p_sub_id" "uuid", "p_value" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ begin new.updated_at := now(); return new; end $$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."settle_expense_advance"("p_loan_id" "uuid", "p_spent_amount" integer, "p_category" "text", "p_return_amount" integer, "p_return_account" "uuid", "p_date" "date", "p_notes" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant      uuid := public.current_tenant_id();
  v_loan        public.employee_loans;
  v_paid        integer;
  v_outstanding integer;
  v_exp_id      text;
  v_ret_method  text;
begin
  p_spent_amount  := coalesce(p_spent_amount, 0);
  p_return_amount := coalesce(p_return_amount, 0);

  if p_spent_amount < 0 or p_return_amount < 0 then
    raise exception 'Amounts cannot be negative';
  end if;
  if p_spent_amount + p_return_amount <= 0 then
    raise exception 'Nothing to settle';
  end if;

  select * into v_loan from public.employee_loans
    where id = p_loan_id and tenant_id = v_tenant;
  if not found then raise exception 'Advance not found'; end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.employee_loan_repayments where loan_id = p_loan_id;
  v_outstanding := v_loan.principal - v_paid;

  if p_spent_amount + p_return_amount > v_outstanding then
    raise exception 'Settlement (%) exceeds outstanding (%)', p_spent_amount + p_return_amount, v_outstanding;
  end if;

  if p_spent_amount > 0 then
    if trim(coalesce(p_category, '')) = '' then
      raise exception 'An expense category is required for the spent amount';
    end if;
    v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint))
                       || '-' || upper(to_hex((random() * 255)::int));
    insert into public.expenses
      (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
    values
      (v_exp_id, v_tenant, trim(p_category), v_loan.employee_name, p_date, p_spent_amount, 0, 'advance',
       'Settled from expense advance to ' || v_loan.employee_name);

    insert into public.employee_loan_repayments
      (tenant_id, loan_id, amount, repaid_on, method, bank_account_id, expense_id, notes)
    values
      (v_tenant, p_loan_id, p_spent_amount, p_date, 'expense', null, v_exp_id,
       nullif(trim(coalesce(p_notes, '')), ''));
  end if;

  if p_return_amount > 0 then
    if p_return_account is null then
      raise exception 'A receiving account is required for the returned cash';
    end if;
    select case when account_type = 'cash' then 'cash' else 'bank' end
      into v_ret_method
      from public.bank_accounts where id = p_return_account and tenant_id = v_tenant;
    if not found then raise exception 'Receiving account not found'; end if;

    insert into public.employee_loan_repayments
      (tenant_id, loan_id, amount, repaid_on, method, bank_account_id, notes)
    values
      (v_tenant, p_loan_id, p_return_amount, p_date, v_ret_method, p_return_account,
       nullif(trim(coalesce(p_notes, '')), ''));

    insert into public.bank_transactions
      (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
    values
      (v_tenant, p_return_account, p_date,
       'Advance returned — ' || v_loan.employee_name, 0, p_return_amount, 'manual', 'manual', 'manual');
  end if;

  update public.employee_loans
     set status     = case when v_outstanding - (p_spent_amount + p_return_amount) <= 0 then 'closed' else 'active' end,
         updated_at = now()
   where id = p_loan_id;
end;
$$;


ALTER FUNCTION "public"."settle_expense_advance"("p_loan_id" "uuid", "p_spent_amount" integer, "p_category" "text", "p_return_amount" integer, "p_return_account" "uuid", "p_date" "date", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."settle_reimbursement"("p_id" "uuid", "p_settled_on" "date", "p_notes" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_r      public.reimbursements;
begin
  select * into v_r from public.reimbursements where id = p_id;
  if not found then raise exception 'Reimbursement not found'; end if;
  if v_tenant is not null and v_r.tenant_id is distinct from v_tenant then
    raise exception 'Not in your tenant' using errcode = 'insufficient_privilege';
  end if;
  update public.reimbursements
     set status = 'settled', settled_on = coalesce(p_settled_on, current_date),
         settled_notes = nullif(trim(coalesce(p_notes, '')), '')
   where id = p_id;
end;
$$;


ALTER FUNCTION "public"."settle_reimbursement"("p_id" "uuid", "p_settled_on" "date", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."site_promos_touch_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."site_promos_touch_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_expense_claim"("p_tenant_id" "uuid", "p_employee_id" "uuid", "p_pin" "text", "p_amount" integer, "p_category" "text", "p_purpose" "text", "p_spent_on" "date", "p_receipt_path" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
declare
  v_emp        public.employees;
  v_loan       public.employee_loans;
  v_paid       integer;
  v_pending    integer;
  v_available  integer;
  v_claim      uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be more than zero';
  end if;
  if trim(coalesce(p_category, '')) = '' then
    raise exception 'Please choose a category';
  end if;

  select * into v_emp from public.employees
    where id = p_employee_id and tenant_id = p_tenant_id;
  if not found then raise exception 'Employee not found'; end if;
  if not v_emp.is_active then raise exception 'This employee is inactive'; end if;
  if v_emp.pin_hash is null then raise exception 'No PIN set for you — ask the office to set one'; end if;
  if p_pin is null or crypt(p_pin, v_emp.pin_hash) <> v_emp.pin_hash then
    raise exception 'Wrong PIN';
  end if;

  select * into v_loan from public.employee_loans
    where tenant_id = p_tenant_id and employee_name = v_emp.name
      and kind = 'expense_advance' and status = 'active'
    order by created_at desc limit 1;
  if not found then
    raise exception 'You have no open expense advance to claim against';
  end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.employee_loan_repayments where loan_id = v_loan.id;
  select coalesce(sum(amount), 0) into v_pending
    from public.expense_claims where loan_id = v_loan.id and status = 'pending';
  v_available := v_loan.principal - v_paid - v_pending;

  if p_amount > v_available then
    raise exception 'Amount (%) is more than your remaining advance (%)', p_amount, v_available;
  end if;

  insert into public.expense_claims
    (tenant_id, loan_id, employee_id, amount, category, purpose, spent_on, receipt_path, status)
  values
    (p_tenant_id, v_loan.id, p_employee_id, p_amount, trim(p_category),
     nullif(trim(coalesce(p_purpose, '')), ''), coalesce(p_spent_on, current_date), p_receipt_path, 'pending')
  returning id into v_claim;

  return v_claim;
end;
$$;


ALTER FUNCTION "public"."submit_expense_claim"("p_tenant_id" "uuid", "p_employee_id" "uuid", "p_pin" "text", "p_amount" integer, "p_category" "text", "p_purpose" "text", "p_spent_on" "date", "p_receipt_path" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."subscriptions_resolve_item"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare
  v_id     text;
  v_count  int;
begin
  -- An explicitly supplied item_id is never second-guessed.
  if new.item_id is not null then
    return new;
  end if;
  if new.plan is null or new.tenant_id is null then
    return new;
  end if;

  /* Same tenant, same vendor, same normalised name. Vendor is part of the match
     because "Standard" exists under google, hosting and support in this tenant's own
     catalog — a mix-up would price a Google seat at hosting's ₹0 and invent a 100%
     margin. */
  select count(*), min(i.id)
    into v_count, v_id
    from public.items i
   where i.tenant_id = new.tenant_id
     and i.vendor::text = new.vendor::text
     and public.plan_key(i.name) = public.plan_key(new.plan);

  -- Exactly one candidate, or nothing. Stricter than the TypeScript, which tolerates
  -- duplicates that agree on price; here any ambiguity simply declines to link.
  if v_count = 1 then
    new.item_id := v_id;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."subscriptions_resolve_item"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."subscriptions_resolve_item"() IS 'Fills subscriptions.item_id from the catalog when exactly one row of the same tenant + vendor matches plan_key(plan). Declines to guess when 0 or 2+ match.';



CREATE OR REPLACE FUNCTION "public"."suggest_bank_transaction_matches"("p_bank_txn_id" "uuid") RETURNS TABLE("match_type" "text", "match_id" "text", "match_label" "text", "match_amount" integer, "match_date" "date", "match_confidence" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_txn record; v_tenant uuid; v_search_amount integer; v_is_credit boolean;
begin
  select bt.* into v_txn from public.bank_transactions bt where bt.id = p_bank_txn_id;
  if not found then return; end if;
  v_tenant := v_txn.tenant_id; v_search_amount := greatest(v_txn.debit, v_txn.credit); v_is_credit := v_txn.credit > 0;
  if v_is_credit then
    return query
    select 'payment'::text, p.id::text,
           coalesce(c.name, p.receipt_voucher_no, 'Payment') || case when p.reference is not null and p.reference <> '' then ' · ' || p.reference else '' end,
           p.amount, p.received_at::date,
           case when p.amount = v_search_amount and p.received_at::date = v_txn.txn_date then 'exact'
                when p.amount = v_search_amount and abs(p.received_at::date - v_txn.txn_date) <= 3 then 'high' else 'low' end::text
    from public.payments p left join public.customers c on c.id = p.customer_id
    where p.tenant_id = v_tenant and p.status = 'received' and abs(p.amount - v_search_amount) <= 100 and abs(p.received_at::date - v_txn.txn_date) <= 7
    order by abs(p.amount - v_search_amount), abs(p.received_at::date - v_txn.txn_date) limit 5;

    return query
    select 'project'::text, pp.id::text,
           coalesce(ps.customer_name, ps.title, 'Project payment') || ' · project',
           pp.amount, pp.received_at::date,
           case when pp.amount = v_search_amount and pp.received_at::date = v_txn.txn_date then 'exact'
                when pp.amount = v_search_amount and abs(pp.received_at::date - v_txn.txn_date) <= 3 then 'high' else 'low' end::text
    from public.project_payments pp
    join public.project_sales ps on ps.id = pp.project_id
    where pp.tenant_id = v_tenant and pp.bank_txn_id is null
      and abs(pp.amount - v_search_amount) <= 100 and abs(pp.received_at::date - v_txn.txn_date) <= 7
    order by abs(pp.amount - v_search_amount), abs(pp.received_at::date - v_txn.txn_date) limit 5;
  end if;
  if not v_is_credit then
    return query
    select 'salary'::text, sp.id::text, e.name || ' · salary ' || sp.period, sp.net, sp.pay_date,
           case when sp.net = v_search_amount and sp.pay_date = v_txn.txn_date then 'exact'
                when sp.net = v_search_amount and abs(sp.pay_date - v_txn.txn_date) <= 10 then 'high' else 'low' end::text
    from public.salary_payments sp join public.employees e on e.id = sp.employee_id
    where sp.tenant_id = v_tenant and sp.paid_status = 'unpaid' and abs(sp.net - v_search_amount) <= 100 and abs(sp.pay_date - v_txn.txn_date) <= 15
    order by abs(sp.net - v_search_amount), abs(sp.pay_date - v_txn.txn_date) limit 5;
    return query
    select 'expense'::text, e.id::text, coalesce(e.vendor_name, e.category, 'Expense'), e.amount, e.expense_date,
           case when e.amount = v_search_amount and e.expense_date = v_txn.txn_date then 'exact'
                when e.amount = v_search_amount and abs(e.expense_date - v_txn.txn_date) <= 3 then 'high' else 'low' end::text
    from public.expenses e
    where e.tenant_id = v_tenant and e.category <> 'Salaries' and abs(e.amount - v_search_amount) <= 100 and abs(e.expense_date - v_txn.txn_date) <= 7
    order by abs(e.amount - v_search_amount), abs(e.expense_date - v_txn.txn_date) limit 5;
  end if;
end; $$;


ALTER FUNCTION "public"."suggest_bank_transaction_matches"("p_bank_txn_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_partner_item"("p_partner_item_id" "text", "p_my_msrp" integer DEFAULT NULL::integer) RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_child_tenant uuid;
  v_parent_tenant uuid;
  v_parent items%rowtype;
  v_short text;
  v_new_id text;
  v_existing_id text;
  v_msrp integer;
begin
  select u.tenant_id, t.parent_tenant_id
    into v_child_tenant, v_parent_tenant
  from public.users u
  join public.tenants t on t.id = u.tenant_id
  where u.id = auth.uid()
  limit 1;

  if v_parent_tenant is null then
    raise exception 'Your tenant is not linked to a distributor — cannot sync partner items';
  end if;

  select * into v_parent
  from public.items
  where id = p_partner_item_id
    and tenant_id = v_parent_tenant
    and is_partner_visible = true
    and is_active = true;

  if not found then
    raise exception 'Partner item % not found or not visible to your tenant', p_partner_item_id;
  end if;

  v_msrp := coalesce(p_my_msrp, v_parent.msrp);
  v_short := substr(v_child_tenant::text, 1, 3);

  select id into v_existing_id
  from public.items
  where tenant_id = v_child_tenant
    and synced_from_partner_id = p_partner_item_id
  limit 1;

  if v_existing_id is not null then
    update public.items
      set wholesale = v_parent.partner_price,
          msrp      = case when p_my_msrp is not null then p_my_msrp else msrp end,
          prices    = v_parent.prices,
          is_active = true,
          name      = v_parent.name,
          vendor    = v_parent.vendor,
          kind      = v_parent.kind,
          hsn       = v_parent.hsn
      where id = v_existing_id;
    return v_existing_id;
  end if;

  v_new_id := regexp_replace(p_partner_item_id, '-[a-f0-9]{2,}$', '') || '-' || v_short;
  if exists (select 1 from public.items where id = v_new_id) then
    v_new_id := v_new_id || '-' || substr(md5(random()::text), 1, 4);
  end if;

  insert into public.items (
    id, tenant_id, name, vendor, kind, hsn,
    msrp, wholesale, prices, is_active,
    synced_from_partner_id, is_partner_visible, partner_price
  ) values (
    v_new_id, v_child_tenant, v_parent.name, v_parent.vendor, v_parent.kind, v_parent.hsn,
    v_msrp, v_parent.partner_price, v_parent.prices, true,
    p_partner_item_id, false, null
  );

  return v_new_id;
end $_$;


ALTER FUNCTION "public"."sync_partner_item"("p_partner_item_id" "text", "p_my_msrp" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_partner_item"("p_partner_item_id" "text", "p_my_msrp" integer DEFAULT NULL::integer, "p_link_existing_id" "text" DEFAULT NULL::"text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_child_tenant  uuid;
  v_parent_tenant uuid;
  v_parent        items%rowtype;
  v_short         text;
  v_new_id        text;
  v_existing_id   text;
begin
  select u.tenant_id, t.parent_tenant_id
    into v_child_tenant, v_parent_tenant
  from public.users u
  join public.tenants t on t.id = u.tenant_id
  where u.id = auth.uid()
  limit 1;

  if v_parent_tenant is null then
    raise exception 'Your tenant is not linked to a distributor — cannot sync partner items';
  end if;

  select * into v_parent
  from public.items
  where id = p_partner_item_id
    and tenant_id = v_parent_tenant
    and is_partner_visible = true
    and is_active = true;

  if not found then
    raise exception 'Partner item % not found or not visible to your tenant', p_partner_item_id;
  end if;

  v_short := substr(v_child_tenant::text, 1, 3);

  -- 1. Caller asked to link a specific existing row → trust it (verify ownership).
  if p_link_existing_id is not null then
    if not exists (
      select 1 from public.items
      where id = p_link_existing_id and tenant_id = v_child_tenant
    ) then
      raise exception 'Cannot link to item % — not in your tenant', p_link_existing_id;
    end if;
    update public.items
      set synced_from_partner_id = p_partner_item_id,
          wholesale              = v_parent.partner_price,
          msrp                   = case when p_my_msrp is not null then p_my_msrp else msrp end,
          is_active              = true
      where id = p_link_existing_id and tenant_id = v_child_tenant;
    return p_link_existing_id;
  end if;

  -- 2. Already synced from this exact parent → refresh.
  select id into v_existing_id
  from public.items
  where tenant_id = v_child_tenant
    and synced_from_partner_id = p_partner_item_id
  limit 1;

  if v_existing_id is not null then
    update public.items
      set wholesale = v_parent.partner_price,
          msrp      = case when p_my_msrp is not null then p_my_msrp else msrp end,
          prices    = v_parent.prices,
          is_active = true,
          name      = v_parent.name,
          vendor    = v_parent.vendor,
          kind      = v_parent.kind,
          hsn       = v_parent.hsn
      where id = v_existing_id;
    return v_existing_id;
  end if;

  -- 3. New clone.
  v_new_id := regexp_replace(p_partner_item_id, '-[a-f0-9]{2,}$', '') || '-' || v_short;
  if exists (select 1 from public.items where id = v_new_id) then
    v_new_id := v_new_id || '-' || substr(md5(random()::text), 1, 4);
  end if;

  insert into public.items (
    id, tenant_id, name, vendor, kind, hsn,
    msrp, wholesale, prices, is_active,
    synced_from_partner_id, is_partner_visible, partner_price
  ) values (
    v_new_id, v_child_tenant, v_parent.name, v_parent.vendor, v_parent.kind, v_parent.hsn,
    coalesce(p_my_msrp, v_parent.msrp), v_parent.partner_price, v_parent.prices, true,
    p_partner_item_id, false, null
  );

  return v_new_id;
end $_$;


ALTER FUNCTION "public"."sync_partner_item"("p_partner_item_id" "text", "p_my_msrp" integer, "p_link_existing_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_project_invoice_paid"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_ms   uuid[];
  v_inv  text;
  v_amt  integer;
  v_paid integer;
begin
  v_ms := array_remove(array[
    case when tg_op <> 'INSERT' then old.milestone_id end,
    case when tg_op <> 'DELETE' then new.milestone_id end
  ], null);

  for v_inv in
    select distinct m.invoice_id
      from public.project_milestones m
     where m.id = any(v_ms) and m.invoice_id is not null
  loop
    select amount into v_amt from public.invoices where id = v_inv;
    select coalesce(sum(pp.amount), 0) into v_paid
      from public.project_payments pp
      join public.project_milestones m on m.id = pp.milestone_id
     where m.invoice_id = v_inv;
    update public.invoices
       set paid_amount = v_paid,
           status      = (case when v_paid >= coalesce(v_amt, 0) then 'paid' else 'pending' end)::invoice_status
     where id = v_inv;
  end loop;

  return null;
end
$$;


ALTER FUNCTION "public"."sync_project_invoice_paid"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_salary_paid_status"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_old_sal uuid;
  v_new_sal uuid;
begin
  if tg_op = 'UPDATE' and old.matched_to_type = 'salary' and old.matched_to_id is not null then
    v_old_sal := old.matched_to_id::uuid;
  elsif tg_op = 'UPDATE' and old.matched_to_type = 'expense' and old.matched_to_id is not null then
    select id into v_old_sal from public.salary_payments
     where expense_id = old.matched_to_id and tenant_id = old.tenant_id;
  end if;

  if new.matched_to_type = 'salary' and new.matched_to_id is not null then
    v_new_sal := new.matched_to_id::uuid;
  elsif new.matched_to_type = 'expense' and new.matched_to_id is not null then
    select id into v_new_sal from public.salary_payments
     where expense_id = new.matched_to_id and tenant_id = new.tenant_id;
  end if;

  if v_old_sal is not null and v_old_sal is distinct from v_new_sal then
    update public.salary_payments
       set paid_amount = greatest(0, paid_amount - old.debit),
           paid_status = case
             when greatest(0, paid_amount - old.debit) <= 0   then 'unpaid'
             when greatest(0, paid_amount - old.debit) >= net then 'paid'
             else 'partial' end,
           reconciled_txn_id = case when reconciled_txn_id = old.id then null else reconciled_txn_id end
     where id = v_old_sal;
  end if;

  if v_new_sal is not null and (tg_op = 'INSERT' or v_new_sal is distinct from v_old_sal) then
    update public.salary_payments
       set paid_amount = paid_amount + new.debit,
           paid_status = case
             when paid_amount + new.debit >= net then 'paid'
             when paid_amount + new.debit <= 0   then 'unpaid'
             else 'partial' end,
           reconciled_txn_id = case when paid_amount + new.debit >= net then new.id else reconciled_txn_id end
     where id = v_new_sal;
  end if;

  if tg_op = 'UPDATE' and old.matched_to_type = 'split' and new.matched_to_type is null then
    update public.salary_payments
       set paid_status = 'unpaid', paid_amount = 0, reconciled_txn_id = null
     where reconciled_txn_id = old.id;
    update public.expenses set reconciled_txn_id = null where reconciled_txn_id = old.id;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."sync_salary_paid_status"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."tenant_secrets_touch_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."tenant_secrets_touch_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."tg_expense_delete_guards_salary"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_sp public.salary_payments;
begin
  select * into v_sp from public.salary_payments where expense_id = OLD.id;
  if found then
    if v_sp.reconciled_txn_id is not null then
      raise exception 'This salary is reconciled to a bank transaction — un-reconcile that bank line first (or undo from Payroll).'
        using errcode = 'invalid_parameter_value';
    end if;
    if v_sp.advance_recovered > 0 and v_sp.advance_loan_id is not null then
      delete from public.employee_loan_repayments
       where tenant_id = v_sp.tenant_id and loan_id = v_sp.advance_loan_id
         and method = 'salary_deduction' and amount = v_sp.advance_recovered
         and repaid_on = v_sp.pay_date and notes = 'Recovered from salary ' || v_sp.period;
      update public.employee_loans set status = 'active', updated_at = now()
       where id = v_sp.advance_loan_id;
    end if;
    delete from public.salary_payments where id = v_sp.id;
  end if;
  return OLD;
end;
$$;


ALTER FUNCTION "public"."tg_expense_delete_guards_salary"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."tg_mirror_invoice_to_child_vendor_bill"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_linked_tenant uuid;
  v_parent_tenant tenants%rowtype;
  v_parent_state  text;
  v_child_state   text;
  v_subtotal      integer;
  v_igst          integer;
  v_cgst          integer;
  v_sgst          integer;
  v_inter_state   boolean;
begin
  if NEW.customer_id is null then return NEW; end if;

  select linked_tenant_id into v_linked_tenant
  from public.customers
  where id = NEW.customer_id and tenant_id = NEW.tenant_id;

  if v_linked_tenant is null then return NEW; end if;

  if not exists (
    select 1 from public.tenants
    where id = v_linked_tenant and parent_tenant_id = NEW.tenant_id
  ) then return NEW; end if;

  if exists (
    select 1 from public.vendor_bills
    where tenant_id = v_linked_tenant and source_tenant_invoice_id = NEW.id
  ) then return NEW; end if;

  select * into v_parent_tenant from public.tenants where id = NEW.tenant_id;
  v_parent_state := v_parent_tenant.state_code;
  select state_code into v_child_state from public.tenants where id = v_linked_tenant;
  v_inter_state := v_parent_state is null or v_child_state is null or v_parent_state <> v_child_state;

  v_subtotal := round(NEW.amount::numeric / 1.18)::integer;
  if v_inter_state then
    v_igst := NEW.amount - v_subtotal;
    v_cgst := 0;
    v_sgst := 0;
  else
    v_igst := 0;
    v_cgst := round((NEW.amount - v_subtotal)::numeric / 2)::integer;
    v_sgst := (NEW.amount - v_subtotal) - v_cgst;
  end if;

  insert into public.vendor_bills (
    id, tenant_id, vendor_name, vendor_gstin, bill_no, bill_date, due_date,
    category, line_items, subtotal, cgst, sgst, igst, total, status,
    paid_amount, notes, source_tenant_invoice_id
  ) values (
    'VB-PARTNER-' || NEW.id,
    v_linked_tenant,
    v_parent_tenant.name,
    v_parent_tenant.gstin,
    NEW.id,
    NEW.invoice_date,
    NEW.due_date,
    'cloud_subscriptions',
    jsonb_build_array(jsonb_build_object(
      'description', 'Wholesale supply against invoice ' || NEW.id,
      'quantity',    1,
      'rate',        v_subtotal,
      'amount',      v_subtotal
    )),
    v_subtotal, v_cgst, v_sgst, v_igst, NEW.amount,
    'unpaid', 0,
    'Auto-imported from ' || v_parent_tenant.name || ' (your distributor).',
    NEW.id
  );

  return NEW;
end $$;


ALTER FUNCTION "public"."tg_mirror_invoice_to_child_vendor_bill"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_customer_groups_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin new.updated_at := now(); return new; end $$;


ALTER FUNCTION "public"."touch_customer_groups_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."undo_my_last_punch"() RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_tenant uuid; v_emp uuid; v_date date; v_row public.attendance;
begin
  select tenant_id, employee_id into v_tenant, v_emp from public.users where id = auth.uid();
  if v_emp is null then raise exception 'Pehle apna employee link karo.'; end if;
  v_date := (now() at time zone 'Asia/Kolkata')::date;
  select * into v_row from public.attendance where tenant_id = v_tenant and employee_id = v_emp and work_date = v_date;
  if not found then raise exception 'Aaj ka koi attendance record nahi.'; end if;

  if v_row.check_out is not null then
    if now() - v_row.check_out > interval '15 minutes' then
      raise exception 'Undo ka 15-min time nikal gaya — owner se correction karao.';
    end if;
    update public.attendance set check_out = null, selfie_out = null, geo_out = null, check_out_device = null where id = v_row.id;
    return 'undo_checkout';
  else
    if now() - v_row.check_in > interval '15 minutes' then
      raise exception 'Undo ka 15-min time nikal gaya — owner se correction karao.';
    end if;
    delete from public.attendance where id = v_row.id;
    return 'undo_checkin';
  end if;
end $$;


ALTER FUNCTION "public"."undo_my_last_punch"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_project_future_milestones"("p_project_id" "uuid", "p_milestones" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant     uuid := public.current_tenant_id();
  v_proj       public.project_sales;
  v_locked_sum integer := 0;
  v_max_seq    integer := 0;
  v_new_sum    integer := 0;
  v_seq        integer;
  v_m          jsonb;
begin
  select * into v_proj from public.project_sales where id = p_project_id;
  if not found then raise exception 'Project not found'; end if;
  if v_tenant is not null and v_proj.tenant_id is distinct from v_tenant then
    raise exception 'Not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  select coalesce(sum(m.total_amount), 0), coalesce(max(m.seq), 0)
    into v_locked_sum, v_max_seq
  from public.project_milestones m
  where m.project_id = p_project_id
    and (m.invoice_id is not null
         or exists (select 1 from public.project_payments p where p.milestone_id = m.id));

  for v_m in select * from jsonb_array_elements(coalesce(p_milestones, '[]'::jsonb)) loop
    v_new_sum := v_new_sum + greatest(coalesce((v_m->>'total_amount')::integer, 0), 0);
  end loop;

  if v_locked_sum + v_new_sum <> v_proj.total_amount then
    raise exception 'Schedule must total %. Rupees % is already invoiced/paid and fixed, so the remaining milestones must add up to Rupees %.',
      v_proj.total_amount, v_locked_sum, (v_proj.total_amount - v_locked_sum)
      using errcode = 'invalid_parameter_value';
  end if;

  delete from public.project_milestones m
  where m.project_id = p_project_id
    and m.invoice_id is null
    and not exists (select 1 from public.project_payments p where p.milestone_id = m.id);

  v_seq := v_max_seq;
  for v_m in select * from jsonb_array_elements(coalesce(p_milestones, '[]'::jsonb)) loop
    v_seq := v_seq + 1;
    insert into public.project_milestones (tenant_id, project_id, seq, label, total_amount, due_date, status)
    values (v_proj.tenant_id, p_project_id, v_seq,
            coalesce(v_m->>'label', 'Milestone ' || v_seq),
            greatest(coalesce((v_m->>'total_amount')::integer, 0), 0),
            nullif(v_m->>'due_date', '')::date,
            'pending');
  end loop;

  update public.project_sales set updated_at = now() where id = p_project_id;
end;
$$;


ALTER FUNCTION "public"."update_project_future_milestones"("p_project_id" "uuid", "p_milestones" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_project_quote"("p_project_id" "uuid", "p_customer_name" "text", "p_title" "text", "p_description" "text", "p_line_items" "jsonb", "p_gst_rate" integer, "p_inter_state" boolean, "p_milestones" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_proj    public.project_sales;
  v_taxable integer := 0;
  v_gst     integer;
  v_li      jsonb;
  v_m       jsonb;
  v_seq     integer := 0;
begin
  select * into v_proj from public.project_sales where id = p_project_id;
  if not found then raise exception 'Project not found'; end if;
  if v_tenant is not null and v_proj.tenant_id is distinct from v_tenant then
    raise exception 'Not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.project_milestones where project_id = p_project_id and invoice_id is not null) then
    raise exception 'Can''t edit — a milestone is already invoiced. Delete that invoice first.'
      using errcode = 'invalid_parameter_value';
  end if;
  if exists (select 1 from public.project_payments where project_id = p_project_id) then
    raise exception 'Can''t edit — payments are recorded. Remove them first.'
      using errcode = 'invalid_parameter_value';
  end if;

  for v_li in select * from jsonb_array_elements(coalesce(p_line_items, '[]'::jsonb)) loop
    v_taxable := v_taxable + greatest(coalesce((v_li->>'amount')::integer, 0), 0);
  end loop;
  if v_taxable <= 0 then raise exception 'Needs at least one line item'; end if;
  v_gst := round(v_taxable * coalesce(p_gst_rate, 18) / 100.0);

  update public.project_sales
     set customer_name  = p_customer_name,
         title          = p_title,
         description    = nullif(trim(coalesce(p_description,'')),''),
         gst_rate       = coalesce(p_gst_rate, 18),
         inter_state    = coalesce(p_inter_state, false),
         line_items     = coalesce(p_line_items, '[]'::jsonb),
         taxable_amount = v_taxable,
         gst_amount     = v_gst,
         total_amount   = v_taxable + v_gst,
         updated_at     = now()
   where id = p_project_id;

  delete from public.project_milestones where project_id = p_project_id;
  for v_m in select * from jsonb_array_elements(coalesce(p_milestones, '[]'::jsonb)) loop
    v_seq := v_seq + 1;
    insert into public.project_milestones (tenant_id, project_id, seq, label, total_amount, due_date)
    values (v_proj.tenant_id, p_project_id, v_seq,
            coalesce(v_m->>'label', 'Milestone ' || v_seq),
            greatest(coalesce((v_m->>'total_amount')::integer, 0), 0),
            nullif(v_m->>'due_date','')::date);
  end loop;
end;
$$;


ALTER FUNCTION "public"."update_project_quote"("p_project_id" "uuid", "p_customer_name" "text", "p_title" "text", "p_description" "text", "p_line_items" "jsonb", "p_gst_rate" integer, "p_inter_state" boolean, "p_milestones" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."verify_claim_access"("p_tenant_id" "uuid", "p_employee_id" "uuid", "p_pin" "text") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
declare
  v_emp         public.employees;
  v_loan        public.employee_loans;
  v_paid        integer;
  v_pending     integer;
begin
  select * into v_emp from public.employees
    where id = p_employee_id and tenant_id = p_tenant_id;
  if not found then raise exception 'Employee not found'; end if;
  if not v_emp.is_active then raise exception 'This employee is inactive'; end if;
  if v_emp.pin_hash is null then raise exception 'No PIN set for you — ask the office to set one'; end if;
  if p_pin is null or crypt(p_pin, v_emp.pin_hash) <> v_emp.pin_hash then
    raise exception 'Wrong PIN';
  end if;

  select * into v_loan from public.employee_loans
    where tenant_id = p_tenant_id and employee_name = v_emp.name
      and kind = 'expense_advance' and status = 'active'
    order by created_at desc limit 1;
  if not found then
    raise exception 'You have no open expense advance to claim against';
  end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.employee_loan_repayments where loan_id = v_loan.id;
  select coalesce(sum(amount), 0) into v_pending
    from public.expense_claims where loan_id = v_loan.id and status = 'pending';

  return (v_loan.principal - v_paid - v_pending);
end;
$$;


ALTER FUNCTION "public"."verify_claim_access"("p_tenant_id" "uuid", "p_employee_id" "uuid", "p_pin" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."access_credentials" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "label" "text" NOT NULL,
    "kind" "text",
    "login_url" "text",
    "account_ref" "text",
    "holder_name" "text",
    "holder_employee_id" "uuid",
    "holder_count" smallint,
    "stored_in" "text",
    "last_rotated_on" "date",
    "expires_on" "date",
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "access_credentials_holder_count_check" CHECK ((("holder_count" IS NULL) OR ("holder_count" >= 0))),
    CONSTRAINT "access_credentials_label_check" CHECK (("length"("btrim"("label")) > 0))
);


ALTER TABLE "public"."access_credentials" OWNER TO "postgres";


COMMENT ON TABLE "public"."access_credentials" IS 'Register of WHICH credentials the business holds — never their values. There is deliberately no column for a secret: with a server-side master key, anyone operating the service could read it. Use Bitwarden or 1Password for the secrets themselves and record their location in `stored_in`.';



COMMENT ON COLUMN "public"."access_credentials"."account_ref" IS 'Username or account email. NOT a password — a username on its own opens nothing.';



COMMENT ON COLUMN "public"."access_credentials"."holder_employee_id" IS 'Links the holder to staff so that a credential held by a departed employee surfaces by itself when joined against employees.is_active.';



COMMENT ON COLUMN "public"."access_credentials"."holder_count" IS 'How many people can get in. 1 is a single point of failure, which the register reports.';



COMMENT ON COLUMN "public"."access_credentials"."stored_in" IS 'Where the secret actually lives (password manager, hardware token, a named person). This field is what replaces storing the secret here.';



CREATE TABLE IF NOT EXISTS "public"."activity_log" (
    "id" bigint NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "action" "text" NOT NULL,
    "entity" "text" NOT NULL,
    "entity_id" "text",
    "label" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."activity_log" OWNER TO "postgres";


ALTER TABLE "public"."activity_log" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."activity_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."api_keys" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "label" "text" NOT NULL,
    "key_prefix" "text" NOT NULL,
    "key_hash" "text" NOT NULL,
    "scopes" "text"[] DEFAULT '{read}'::"text"[] NOT NULL,
    "last_used_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."api_keys" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."assessment_attempts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "assessment_id" "uuid" NOT NULL,
    "employee_id" "uuid",
    "candidate_name" "text" NOT NULL,
    "answers" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "score" integer NOT NULL,
    "total" integer NOT NULL,
    "pct" integer NOT NULL,
    "grade" "text" NOT NULL,
    "submitted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "duration_seconds" integer,
    "focus_lost_count" integer DEFAULT 0 NOT NULL,
    "focus_lost_seconds" integer DEFAULT 0 NOT NULL,
    "paste_count" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."assessment_attempts" OWNER TO "postgres";


COMMENT ON COLUMN "public"."assessment_attempts"."duration_seconds" IS 'Total seconds from test open to submit.';



COMMENT ON COLUMN "public"."assessment_attempts"."focus_lost_count" IS 'How many times the candidate switched away from the test tab/window.';



COMMENT ON COLUMN "public"."assessment_attempts"."focus_lost_seconds" IS 'Total seconds spent away from the test (possible AI/lookup use).';



COMMENT ON COLUMN "public"."assessment_attempts"."paste_count" IS 'How many paste events happened inside the test.';



CREATE TABLE IF NOT EXISTS "public"."assessments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "topic" "text",
    "difficulty" "text" DEFAULT 'medium'::"text" NOT NULL,
    "questions" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "public_token" "text" NOT NULL,
    "pass_pct" integer DEFAULT 40 NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."assessments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."attendance" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "work_date" "date" NOT NULL,
    "check_in" timestamp with time zone,
    "check_out" timestamp with time zone,
    "source" "text" DEFAULT 'kiosk'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "marked_ip" "text",
    "selfie_in" "text",
    "selfie_out" "text",
    "geo_in" "text",
    "geo_out" "text",
    "flags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "check_in_device" "text",
    "check_out_device" "text",
    "reviewed_at" timestamp with time zone,
    "reviewed_by" "uuid"
);


ALTER TABLE "public"."attendance" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."attendance_settings" (
    "tenant_id" "uuid" NOT NULL,
    "allowed_ips" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "require_selfie" boolean DEFAULT true NOT NULL,
    "require_presence" boolean DEFAULT false NOT NULL,
    "presence_secret" "text",
    "selfie_retention_days" integer DEFAULT 180 NOT NULL,
    "require_face_match" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."attendance_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."balance_sheet_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "section" "text" NOT NULL,
    "label" "text" NOT NULL,
    "amount" integer DEFAULT 0 NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "bank_txn_id" "uuid",
    CONSTRAINT "balance_sheet_items_section_check" CHECK (("section" = ANY (ARRAY['asset'::"text", 'liability'::"text", 'equity'::"text"])))
);


ALTER TABLE "public"."balance_sheet_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bank_aa_connections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "bank_account_id" "uuid" NOT NULL,
    "provider" "text" DEFAULT 'setu'::"text" NOT NULL,
    "vua" "text" NOT NULL,
    "consent_handle_id" "text",
    "consent_id" "text",
    "linked_account_ref" "text",
    "status" "text" DEFAULT 'initiated'::"text" NOT NULL,
    "status_reason" "text",
    "consent_expires_at" timestamp with time zone,
    "fetch_window_from" "date",
    "fetch_window_to" "date",
    "last_fetch_at" timestamp with time zone,
    "last_fetch_status" "text",
    "last_fetch_count" integer DEFAULT 0,
    "next_fetch_after" timestamp with time zone,
    "consent_payload" "jsonb",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "bank_aa_connections_provider_check" CHECK (("provider" = ANY (ARRAY['setu'::"text", 'finvu'::"text", 'onemoney'::"text"]))),
    CONSTRAINT "bank_aa_connections_status_check" CHECK (("status" = ANY (ARRAY['initiated'::"text", 'pending_approval'::"text", 'active'::"text", 'expired'::"text", 'revoked'::"text", 'rejected'::"text", 'error'::"text"])))
);


ALTER TABLE "public"."bank_aa_connections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bank_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "bank_name" "text" NOT NULL,
    "account_number_last4" "text",
    "ifsc" "text",
    "account_type" "text" DEFAULT 'current'::"text" NOT NULL,
    "opening_balance" integer DEFAULT 0 NOT NULL,
    "opening_balance_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "bank_accounts_account_type_check" CHECK (("account_type" = ANY (ARRAY['current'::"text", 'savings'::"text", 'overdraft'::"text", 'fixed_deposit'::"text", 'cash'::"text", 'other'::"text", 'credit_card'::"text"])))
);


ALTER TABLE "public"."bank_accounts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bank_transactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "bank_account_id" "uuid" NOT NULL,
    "txn_date" "date" NOT NULL,
    "description" "text" NOT NULL,
    "debit" integer DEFAULT 0 NOT NULL,
    "credit" integer DEFAULT 0 NOT NULL,
    "balance_after" integer,
    "reference" "text",
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "matched_to_type" "text",
    "matched_to_id" "text",
    "matched_at" timestamp with time zone,
    "matched_by" "uuid",
    "match_confidence" "text",
    "imported_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "bank_transactions_match_confidence_check" CHECK (("match_confidence" = ANY (ARRAY['exact'::"text", 'high'::"text", 'low'::"text", 'manual'::"text"]))),
    CONSTRAINT "bank_transactions_matched_to_type_check" CHECK (("matched_to_type" = ANY (ARRAY['payment'::"text", 'expense'::"text", 'vendor_bill'::"text", 'transfer'::"text", 'salary'::"text", 'project'::"text", 'manual'::"text", 'split'::"text", 'statutory'::"text"]))),
    CONSTRAINT "bank_transactions_source_check" CHECK (("source" = ANY (ARRAY['manual'::"text", 'csv_upload'::"text", 'api_fetch'::"text"]))),
    CONSTRAINT "debit_xor_credit" CHECK (((("debit" > 0) AND ("credit" = 0)) OR (("credit" > 0) AND ("debit" = 0))))
);


ALTER TABLE "public"."bank_transactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."business_loan_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "loan_id" "uuid" NOT NULL,
    "amount" integer NOT NULL,
    "principal_part" integer NOT NULL,
    "interest_part" integer DEFAULT 0 NOT NULL,
    "paid_on" "date" NOT NULL,
    "bank_account_id" "uuid",
    "expense_id" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "business_loan_payments_amount_check" CHECK (("amount" > 0)),
    CONSTRAINT "business_loan_payments_interest_part_check" CHECK (("interest_part" >= 0)),
    CONSTRAINT "business_loan_payments_principal_part_check" CHECK (("principal_part" >= 0))
);


ALTER TABLE "public"."business_loan_payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."business_loans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "lender" "text" NOT NULL,
    "purpose" "text",
    "principal" integer NOT NULL,
    "interest_rate" numeric(6,2),
    "tenure_months" integer,
    "emi_amount" integer,
    "disbursed_on" "date" NOT NULL,
    "deposit_account_id" "uuid",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    CONSTRAINT "business_loans_emi_amount_check" CHECK ((("emi_amount" IS NULL) OR ("emi_amount" >= 0))),
    CONSTRAINT "business_loans_principal_check" CHECK (("principal" > 0)),
    CONSTRAINT "business_loans_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'closed'::"text"]))),
    CONSTRAINT "business_loans_tenure_months_check" CHECK ((("tenure_months" IS NULL) OR ("tenure_months" > 0)))
);


ALTER TABLE "public"."business_loans" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaign_sends" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "campaign_id" "text" NOT NULL,
    "lead_id" "text",
    "recipient_email" "text" NOT NULL,
    "recipient_name" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "provider_id" "text",
    "error_message" "text",
    "sent_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "campaign_sends_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'failed'::"text", 'skipped'::"text", 'stubbed'::"text"])))
);


ALTER TABLE "public"."campaign_sends" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaign_templates" (
    "id" "text" NOT NULL,
    "tenant_id" "uuid",
    "name" "text" NOT NULL,
    "category" "text" DEFAULT 'custom'::"text" NOT NULL,
    "subject" "text" NOT NULL,
    "body_html" "text" NOT NULL,
    "body_text" "text",
    "description" "text",
    "is_system" boolean DEFAULT false NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "campaign_templates_category_check" CHECK (("category" = ANY (ARRAY['newsletter'::"text", 'offer'::"text", 'winback'::"text", 'onboarding'::"text", 'custom'::"text"])))
);


ALTER TABLE "public"."campaign_templates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaigns" (
    "id" "text" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "subject" "text" NOT NULL,
    "body" "text" NOT NULL,
    "audience_filter" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "offer_code" "text",
    "offer_discount_pct" numeric(5,2),
    "offer_expires_at" timestamp with time zone,
    "recipients_count" integer DEFAULT 0 NOT NULL,
    "sent_count" integer DEFAULT 0 NOT NULL,
    "failed_count" integer DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "sent_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "body_html" "text",
    CONSTRAINT "campaigns_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'sending'::"text", 'sent'::"text", 'failed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."campaigns" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."compliance_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "obligation_key" "text" NOT NULL,
    "period_key" "text" NOT NULL,
    "period_label" "text",
    "due_date" "date",
    "filed_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "reference" "text",
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."compliance_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."compliance_reminder_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "obligation_key" "text" NOT NULL,
    "period_key" "text" NOT NULL,
    "days_before" integer NOT NULL,
    "recipient_email" "text" NOT NULL,
    "status" "text" NOT NULL,
    "provider_id" "text",
    "error_message" "text",
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "compliance_reminder_log_days_before_check" CHECK ((("days_before" > 0) AND ("days_before" <= 90))),
    CONSTRAINT "compliance_reminder_log_status_check" CHECK (("status" = ANY (ARRAY['sent'::"text", 'stubbed'::"text", 'failed'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."compliance_reminder_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contact_greeting_log" (
    "id" bigint NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "contact_id" "text" NOT NULL,
    "kind" "text" NOT NULL,
    "channel" "text" DEFAULT 'email'::"text" NOT NULL,
    "greeting_year" integer NOT NULL,
    "recipient" "text",
    "subject" "text",
    "status" "text" NOT NULL,
    "provider_id" "text",
    "error_message" "text",
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "contact_greeting_log_channel_check" CHECK (("channel" = 'email'::"text")),
    CONSTRAINT "contact_greeting_log_kind_check" CHECK (("kind" = ANY (ARRAY['birthday'::"text", 'anniversary'::"text"])))
);


ALTER TABLE "public"."contact_greeting_log" OWNER TO "postgres";


ALTER TABLE "public"."contact_greeting_log" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."contact_greeting_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."contacts" (
    "id" "text" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "full_name" "text" NOT NULL,
    "email" "text",
    "phone" "text",
    "company" "text",
    "title" "text",
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "external_id" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "promoted_to_lead_id" "text",
    "promoted_at" timestamp with time zone,
    "notes" "text",
    "tags" "text"[] DEFAULT '{}'::"text"[],
    "imported_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "whatsapp" "text",
    "linkedin" "text",
    "instagram" "text",
    "facebook" "text",
    "twitter" "text",
    "website" "text",
    "address" "text",
    "city" "text",
    "customer_id" "uuid",
    "emails" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "phones" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "google_etag" "text",
    "google_synced_at" timestamp with time zone,
    "relationship" "text",
    "birthday" "date",
    "anniversary" "date",
    "nickname" "text",
    "family" "text",
    CONSTRAINT "contacts_source_check" CHECK (("source" = ANY (ARRAY['manual'::"text", 'google_csv'::"text", 'google_api'::"text", 'outlook'::"text", 'linkedin'::"text", 'event'::"text", 'other'::"text", 'enquiry'::"text"]))),
    CONSTRAINT "contacts_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'engaged'::"text", 'promoted'::"text", 'archived'::"text"])))
);


ALTER TABLE "public"."contacts" OWNER TO "postgres";


COMMENT ON COLUMN "public"."contacts"."customer_id" IS 'Optional link to the customer company this person belongs to; ON DELETE SET NULL (unlink, never cascade-delete the contact).';



COMMENT ON COLUMN "public"."contacts"."emails" IS 'All emails: array of {value,label}. contacts.email mirrors the primary (index 0).';



COMMENT ON COLUMN "public"."contacts"."phones" IS 'All phones: array of {value,label}. contacts.phone mirrors the primary (index 0).';



COMMENT ON COLUMN "public"."contacts"."google_etag" IS 'Google People API etag for this contact (for safe write-back).';



COMMENT ON COLUMN "public"."contacts"."google_synced_at" IS 'Last time this contact was reconciled with Google Contacts.';



COMMENT ON COLUMN "public"."contacts"."relationship" IS 'Relationship classification for standalone contacts: partner | vendor | personal | other. NULL = unclassified. Leads/customers derive their kind from their source table.';



COMMENT ON COLUMN "public"."contacts"."birthday" IS 'Date of birth. Powers birthday reminders.';



COMMENT ON COLUMN "public"."contacts"."anniversary" IS 'Anniversary / other yearly date to remember.';



COMMENT ON COLUMN "public"."contacts"."nickname" IS 'What the owner calls this person.';



COMMENT ON COLUMN "public"."contacts"."family" IS 'Free text: spouse, children, relations — personal context.';



CREATE TABLE IF NOT EXISTS "public"."coupon_redemptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "coupon_code" "text" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "quote_id" "text",
    "lead_id" "text",
    "contact_email" "text",
    "contact_name" "text",
    "tier_id" "text",
    "seats" integer,
    "amount_saved" integer NOT NULL,
    "redeemed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."coupon_redemptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."coupons" (
    "code" "text" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "description" "text",
    "discount_type" "text" DEFAULT 'percent'::"text" NOT NULL,
    "discount_value" integer NOT NULL,
    "applies_to_tier" "text",
    "applies_to_vendor" "text" DEFAULT 'google'::"text",
    "min_seats" integer DEFAULT 1 NOT NULL,
    "max_seats" integer,
    "max_redemptions" integer,
    "redemption_count" integer DEFAULT 0 NOT NULL,
    "valid_from" timestamp with time zone DEFAULT "now"() NOT NULL,
    "valid_until" timestamp with time zone,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "coupons_discount_type_check" CHECK (("discount_type" = ANY (ARRAY['percent'::"text", 'flat'::"text"]))),
    CONSTRAINT "coupons_discount_value_check" CHECK (("discount_value" > 0))
);


ALTER TABLE "public"."coupons" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."credit_notes" (
    "id" "text" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "invoice_id" "text" NOT NULL,
    "customer_id" "uuid",
    "customer_name" "text",
    "credit_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "reason_code" "text" DEFAULT 'other'::"text" NOT NULL,
    "reason" "text",
    "amount" integer NOT NULL,
    "taxable_value" integer NOT NULL,
    "tax_amount" integer NOT NULL,
    "tax_rate" integer NOT NULL,
    "inter_state" boolean DEFAULT false NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    CONSTRAINT "credit_notes_amount_check" CHECK (("amount" > 0)),
    CONSTRAINT "credit_notes_reason_code_check" CHECK (("reason_code" = ANY (ARRAY['overbilling'::"text", 'seats_reduced'::"text", 'discount'::"text", 'cancellation'::"text", 'return'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."credit_notes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."customer_credits" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "amount" integer NOT NULL,
    "source" "text" DEFAULT 'overpayment'::"text" NOT NULL,
    "source_payment_id" "uuid",
    "source_quote_id" "text",
    "note" "text",
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "customer_credits_amount_check" CHECK (("amount" > 0)),
    CONSTRAINT "customer_credits_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'used'::"text", 'refunded'::"text"])))
);


ALTER TABLE "public"."customer_credits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."customer_domains" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "domain" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."customer_domains" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."customer_groups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "contact_name" "text",
    "contact_email" "text",
    "contact_phone" "text",
    "is_partner" boolean DEFAULT false NOT NULL,
    "notes" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid"
);


ALTER TABLE "public"."customer_groups" OWNER TO "postgres";


COMMENT ON TABLE "public"."customer_groups" IS 'Umbrella / parent account linking multiple customer companies routed by one common reseller/coordinator (X). Relationship + reporting layer only — billing stays per-customer (each company keeps its own GSTIN + invoices).';



CREATE TABLE IF NOT EXISTS "public"."customer_number_seq" (
    "tenant_id" "uuid" NOT NULL,
    "last_number" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."customer_number_seq" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."customer_users" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "auth_user_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "role" "text" DEFAULT 'admin'::"text" NOT NULL,
    "last_login_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."customer_users" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."customers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "domain" "text",
    "gstin" "text",
    "state" "text",
    "state_code" "text",
    "health" smallint DEFAULT 70,
    "contact_name" "text",
    "contact_title" "text",
    "contact_email" "text",
    "contact_phone" "text",
    "account_manager_id" "uuid",
    "since" "date" DEFAULT CURRENT_DATE,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "tan" "text",
    "tds_default_section" "text" DEFAULT '194J'::"text",
    "tds_default_rate_pct" numeric(5,2) DEFAULT 10.00,
    "address" "text",
    "pin_code" "text",
    "gstin_verified_at" timestamp with time zone,
    "gstin_verification" "jsonb",
    "linked_tenant_id" "uuid",
    "customer_number" "text",
    "country" "text" DEFAULT 'India'::"text" NOT NULL,
    "contact_salutation" "text",
    "contact_first_name" "text",
    "contact_last_name" "text",
    "contact_mobile" "text",
    "contact_persons" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "payment_terms_days" integer,
    "shipping_address" "jsonb",
    "customer_type" "text" DEFAULT 'business'::"text" NOT NULL,
    "display_name" "text",
    "city" "text",
    "group_id" "uuid",
    "is_active" boolean DEFAULT true NOT NULL,
    CONSTRAINT "customers_customer_type_chk" CHECK (("customer_type" = ANY (ARRAY['business'::"text", 'individual'::"text"]))),
    CONSTRAINT "customers_health_check" CHECK ((("health" >= 0) AND ("health" <= 100)))
);


ALTER TABLE "public"."customers" OWNER TO "postgres";


COMMENT ON COLUMN "public"."customers"."tan" IS 'Tax Account Number — required to attribute TDS deductions to this customer. Different from GSTIN.';



COMMENT ON COLUMN "public"."customers"."tds_default_section" IS 'Default section under which this customer typically deducts TDS. Most SaaS = 194J.';



COMMENT ON COLUMN "public"."customers"."tds_default_rate_pct" IS 'Default TDS percentage. 194J for services = 10%, 194C for contracts = 2%, 194Q for high-value = 0.1%.';



COMMENT ON COLUMN "public"."customers"."address" IS 'Customer billing address — printed on GST invoices.';



COMMENT ON COLUMN "public"."customers"."pin_code" IS '6-digit postal PIN code.';



COMMENT ON COLUMN "public"."customers"."gstin_verified_at" IS 'When the customer GSTIN was last verified via 3rd-party (Sandbox/ClearTax/NIC). NULL = never.';



COMMENT ON COLUMN "public"."customers"."gstin_verification" IS 'Cached normalised verification response (matches lib/supabase/database.types.ts GstinVerification).';



COMMENT ON COLUMN "public"."customers"."customer_number" IS 'External reference from the source system (e.g. Zoho "CUS-00001"). Used as the join key when importing subscriptions.';



COMMENT ON COLUMN "public"."customers"."country" IS 'Recipient country. Anything other than India / IN marks an EXPORT (zero-rated) customer for GST.';



COMMENT ON COLUMN "public"."customers"."group_id" IS 'Optional parent account (customer_groups). Groups companies routed by one common reseller/coordinator. Does not affect this customer''s own invoicing/GSTIN.';



COMMENT ON COLUMN "public"."customers"."is_active" IS 'Zoho-style active flag. false = archived/inactive: hidden from the default customers list but all invoices/payments/GST records are retained. Reversible.';



CREATE TABLE IF NOT EXISTS "public"."debit_notes" (
    "id" "text" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "invoice_id" "text" NOT NULL,
    "customer_id" "uuid",
    "customer_name" "text",
    "debit_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "reason_code" "text" DEFAULT 'other'::"text" NOT NULL,
    "reason" "text",
    "amount" integer NOT NULL,
    "taxable_value" integer NOT NULL,
    "tax_amount" integer NOT NULL,
    "tax_rate" integer NOT NULL,
    "inter_state" boolean DEFAULT false NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    CONSTRAINT "debit_notes_amount_check" CHECK (("amount" > 0)),
    CONSTRAINT "debit_notes_reason_code_check" CHECK (("reason_code" = ANY (ARRAY['undercharge'::"text", 'additional_charge'::"text", 'price_escalation'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."debit_notes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."document_series" (
    "tenant_id" "uuid" NOT NULL,
    "doc_type" "text" NOT NULL,
    "fiscal_year" "text" NOT NULL,
    "prefix" "text" NOT NULL,
    "last_number" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "document_series_doc_type_check" CHECK (("doc_type" = ANY (ARRAY['invoice'::"text", 'receipt_voucher'::"text", 'refund_voucher'::"text", 'credit_note'::"text", 'debit_note'::"text", 'quote'::"text", 'purchase_order'::"text", 'campaign'::"text"]))),
    CONSTRAINT "document_series_last_number_check" CHECK (("last_number" >= 0))
);


ALTER TABLE "public"."document_series" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "category" "text" DEFAULT 'other'::"text" NOT NULL,
    "file_path" "text" NOT NULL,
    "file_name" "text",
    "mime_type" "text",
    "size_bytes" bigint,
    "expiry_date" "date",
    "notes" "text",
    "uploaded_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "documents_category_check" CHECK (("category" = ANY (ARRAY['legal'::"text", 'finance'::"text", 'hr'::"text", 'operations'::"text", 'sales_marketing'::"text", 'admin'::"text", 'branding'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."email_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "recipient" "text" NOT NULL,
    "subject" "text",
    "kind" "text",
    "provider" "text" NOT NULL,
    "status" "text" NOT NULL,
    "provider_message_id" "text",
    "error_message" "text",
    "user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "email_log_provider_check" CHECK (("provider" = ANY (ARRAY['resend'::"text", 'gmail'::"text", 'stub'::"text"]))),
    CONSTRAINT "email_log_status_check" CHECK (("status" = ANY (ARRAY['sent'::"text", 'stubbed'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."email_log" OWNER TO "postgres";


COMMENT ON TABLE "public"."email_log" IS 'Every outbound email attempt, written from inside sendEmail() so no caller can omit it. Bodies are NOT stored. status=sent means the provider accepted the message, not that it was delivered.';



CREATE TABLE IF NOT EXISTS "public"."emi_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "purchase_id" "uuid" NOT NULL,
    "amount" integer NOT NULL,
    "principal_part" integer NOT NULL,
    "interest_part" integer DEFAULT 0 NOT NULL,
    "paid_on" "date" NOT NULL,
    "bank_account_id" "uuid",
    "expense_id" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "emi_payments_amount_check" CHECK (("amount" > 0)),
    CONSTRAINT "emi_payments_interest_part_check" CHECK (("interest_part" >= 0)),
    CONSTRAINT "emi_payments_principal_part_check" CHECK (("principal_part" >= 0))
);


ALTER TABLE "public"."emi_payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."emi_purchases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "category" "text" DEFAULT 'other'::"text" NOT NULL,
    "total_cost" integer NOT NULL,
    "down_payment" integer DEFAULT 0 NOT NULL,
    "financed" integer NOT NULL,
    "emi_count" integer DEFAULT 0 NOT NULL,
    "emi_amount" integer DEFAULT 0 NOT NULL,
    "purchased_on" "date" NOT NULL,
    "down_account_id" "uuid",
    "lender" "text",
    "notes" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    CONSTRAINT "emi_purchases_category_check" CHECK (("category" = ANY (ARRAY['vehicle'::"text", 'equipment'::"text", 'furniture'::"text", 'property'::"text", 'other'::"text"]))),
    CONSTRAINT "emi_purchases_down_payment_check" CHECK (("down_payment" >= 0)),
    CONSTRAINT "emi_purchases_emi_amount_check" CHECK (("emi_amount" >= 0)),
    CONSTRAINT "emi_purchases_emi_count_check" CHECK (("emi_count" >= 0)),
    CONSTRAINT "emi_purchases_financed_check" CHECK (("financed" >= 0)),
    CONSTRAINT "emi_purchases_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'closed'::"text"]))),
    CONSTRAINT "emi_purchases_total_cost_check" CHECK (("total_cost" > 0))
);


ALTER TABLE "public"."emi_purchases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."employee_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "doc_type" "text" DEFAULT 'other'::"text" NOT NULL,
    "file_name" "text" NOT NULL,
    "file_path" "text" NOT NULL,
    "mime_type" "text",
    "size_bytes" integer,
    "uploaded_by" "uuid",
    "uploaded_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."employee_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."employee_loan_repayments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "loan_id" "uuid" NOT NULL,
    "amount" integer NOT NULL,
    "repaid_on" "date" NOT NULL,
    "method" "text" NOT NULL,
    "bank_account_id" "uuid",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expense_id" "text",
    CONSTRAINT "employee_loan_repayments_amount_check" CHECK (("amount" > 0)),
    CONSTRAINT "employee_loan_repayments_method_check" CHECK (("method" = ANY (ARRAY['cash'::"text", 'bank'::"text", 'salary_deduction'::"text", 'expense'::"text"])))
);


ALTER TABLE "public"."employee_loan_repayments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."employee_loans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "employee_name" "text" NOT NULL,
    "principal" integer NOT NULL,
    "disbursed_on" "date" NOT NULL,
    "bank_account_id" "uuid",
    "notes" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "kind" "text" DEFAULT 'loan'::"text" NOT NULL,
    CONSTRAINT "employee_loans_kind_check" CHECK (("kind" = ANY (ARRAY['loan'::"text", 'salary_advance'::"text", 'expense_advance'::"text"]))),
    CONSTRAINT "employee_loans_principal_check" CHECK (("principal" > 0)),
    CONSTRAINT "employee_loans_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'closed'::"text"])))
);


ALTER TABLE "public"."employee_loans" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."employees" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "monthly_gross" integer DEFAULT 0 NOT NULL,
    "joining_date" "date",
    "leave_allowance" integer DEFAULT 18 NOT NULL,
    "pan" "text",
    "pf_no" "text",
    "esi_no" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "pin_hash" "text",
    "email" "text",
    "phone" "text",
    "designation" "text",
    "date_of_birth" "date",
    "address" "text",
    "emergency_contact_name" "text",
    "emergency_contact_phone" "text",
    "esi_applicable" boolean DEFAULT false NOT NULL,
    "pf_applicable" boolean DEFAULT false NOT NULL,
    "biometric_id" "text",
    "attendance_consent_at" timestamp with time zone,
    "attendance_consent_source" "text",
    "face_enrolled_at" timestamp with time zone,
    "face_ref_path" "text",
    CONSTRAINT "employees_leave_allowance_check" CHECK (("leave_allowance" >= 0)),
    CONSTRAINT "employees_monthly_gross_check" CHECK (("monthly_gross" >= 0))
);


ALTER TABLE "public"."employees" OWNER TO "postgres";


COMMENT ON COLUMN "public"."employees"."biometric_id" IS 'This employee''s user number on the biometric attendance machine (maps device punches to employee).';



CREATE TABLE IF NOT EXISTS "public"."expense_claims" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "loan_id" "uuid" NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "amount" integer NOT NULL,
    "category" "text" NOT NULL,
    "purpose" "text",
    "spent_on" "date" NOT NULL,
    "receipt_path" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "expense_id" "text",
    "reject_reason" "text",
    "reviewed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "expense_claims_amount_check" CHECK (("amount" > 0)),
    CONSTRAINT "expense_claims_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."expense_claims" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."expenses" (
    "id" "text" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "category" "text" NOT NULL,
    "vendor_name" "text",
    "expense_date" "date" NOT NULL,
    "amount" integer NOT NULL,
    "gst_paid" integer DEFAULT 0 NOT NULL,
    "payment_method" "text",
    "description" "text",
    "attachment_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reconciled_txn_id" "uuid",
    "vendor_id" "uuid",
    "currency" "text" DEFAULT 'INR'::"text" NOT NULL,
    "fx_rate" numeric DEFAULT 1 NOT NULL,
    "bill_type" "text" DEFAULT 'gst'::"text" NOT NULL,
    "line_items" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "bill_no" "text",
    "paid" boolean DEFAULT true NOT NULL,
    "paid_date" "date",
    "due_date" "date",
    "project_id" "uuid",
    "tds_section" "text",
    "tds_amount" integer DEFAULT 0 NOT NULL,
    "bank_account_id" "uuid",
    "notes" "text",
    "prepaid_advance_id" "uuid",
    CONSTRAINT "expenses_bill_type_check" CHECK (("bill_type" = ANY (ARRAY['gst'::"text", 'kaccha'::"text", 'none'::"text"])))
);


ALTER TABLE "public"."expenses" OWNER TO "postgres";


COMMENT ON TABLE "public"."expenses" IS 'Operating expenses (non-COGS) — hosting, salaries, software, office, marketing, etc.';



COMMENT ON COLUMN "public"."expenses"."vendor_id" IS 'Optional link to the vendors master (the supplier who invoiced this expense).';



COMMENT ON COLUMN "public"."expenses"."currency" IS 'Currency printed on the bill (ISO): INR, USD, … . INR = domestic.';



COMMENT ON COLUMN "public"."expenses"."fx_rate" IS 'INR per 1 unit of currency at bill time (1 for INR). Foreign amount = amount / fx_rate.';



COMMENT ON COLUMN "public"."expenses"."bill_type" IS 'Supporting document: gst (tax invoice), kaccha (informal/no-GST), none (no bill).';



COMMENT ON COLUMN "public"."expenses"."line_items" IS 'Itemised bill lines [{name, qty?, rate?, amount}] in the bill''s own currency; for verifying the entry against the paper bill.';



COMMENT ON COLUMN "public"."expenses"."bill_no" IS 'Supplier invoice/bill number — used to detect duplicate expense entries (vendor + bill_no).';



COMMENT ON COLUMN "public"."expenses"."paid" IS 'true = money already went out; false = payable (bill received, settle later)';



COMMENT ON COLUMN "public"."expenses"."paid_date" IS 'date the expense was actually settled (null while unpaid)';



COMMENT ON COLUMN "public"."expenses"."due_date" IS 'date the payable is owed (optional; only meaningful while unpaid)';



COMMENT ON COLUMN "public"."expenses"."project_id" IS 'Optional link to a project_sales row — tags this expense as a cost of that project (per-project P&L). ON DELETE SET NULL.';



COMMENT ON COLUMN "public"."expenses"."tds_section" IS 'TDS section for 26Q — 194C/194J/194I/194H/194A/etc. Null = no TDS deducted.';



COMMENT ON COLUMN "public"."expenses"."tds_amount" IS 'TDS deducted on this payment (deductor side), feeds 26Q.';



COMMENT ON COLUMN "public"."expenses"."bank_account_id" IS 'Source bank account the money was paid FROM (bank/UPI/card/cheque). Reference + reconcile hint; the actual debit comes from the imported statement line.';



COMMENT ON COLUMN "public"."expenses"."notes" IS 'Free-text comment / extra detail about the expense (context, who/why/how). Separate from the short description.';



COMMENT ON COLUMN "public"."expenses"."prepaid_advance_id" IS 'If this expense was booked by consuming a prepaid advance, the advance it came from.';



CREATE TABLE IF NOT EXISTS "public"."google_contact_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "source_type" "text" NOT NULL,
    "source_id" "text" NOT NULL,
    "resource_name" "text" NOT NULL,
    "etag" "text",
    "synced_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "google_contact_links_source_type_check" CHECK (("source_type" = ANY (ARRAY['contact'::"text", 'lead'::"text", 'customer'::"text"])))
);


ALTER TABLE "public"."google_contact_links" OWNER TO "postgres";


COMMENT ON TABLE "public"."google_contact_links" IS 'Per-user link: app person (contact/lead/customer) to Google Contacts resourceName. Service-role only.';



CREATE TABLE IF NOT EXISTS "public"."holidays" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "holiday_date" "date" NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."holidays" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inbound_emails" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "message_id" "text" NOT NULL,
    "from_email" "text",
    "from_name" "text",
    "subject" "text",
    "status" "text" DEFAULT 'received'::"text" NOT NULL,
    "lead_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "body_text" "text",
    "body_html" "text",
    "to_email" "text",
    "route" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "ticket_id" "text",
    "attachment_path" "text",
    "attachment_name" "text",
    "attachment_mime" "text",
    "extracted_bill" "jsonb",
    "bill_id" "text",
    CONSTRAINT "inbound_emails_route_check" CHECK (("route" = ANY (ARRAY['sales'::"text", 'support'::"text", 'billing'::"text", 'ignored'::"text", 'unknown'::"text"])))
);


ALTER TABLE "public"."inbound_emails" OWNER TO "postgres";


COMMENT ON COLUMN "public"."inbound_emails"."to_email" IS 'The address the message was sent to. Routing keys on this; it is why support@ and billing@ can behave differently from sales@.';



COMMENT ON COLUMN "public"."inbound_emails"."route" IS 'What the router decided AT THE TIME. Never recomputed on read — the address→route mapping changes, and rewriting an old row''s route would make an incident impossible to reconstruct.';



COMMENT ON COLUMN "public"."inbound_emails"."ticket_id" IS 'Support ticket opened from this message. The twin of lead_id for the support route.';



COMMENT ON COLUMN "public"."inbound_emails"."attachment_path" IS 'Object path in the private `documents` bucket. The original file — without it the extraction cannot be checked, and an audit asks for the invoice, not for what a model thought it said.';



COMMENT ON COLUMN "public"."inbound_emails"."extracted_bill" IS 'What Gemini read from the attachment. A SUGGESTION, never posted to the books on its own: these figures feed GST input credit and the P&L.';



COMMENT ON COLUMN "public"."inbound_emails"."bill_id" IS 'Set only when a human reviewed the extraction and created the vendor bill. NULL means nothing was posted.';



CREATE TABLE IF NOT EXISTS "public"."inbound_purchases" (
    "id" bigint NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "source" "text" DEFAULT 'amazon'::"text" NOT NULL,
    "message_id" "text",
    "order_id" "text",
    "from_email" "text",
    "subject" "text",
    "order_date" "date",
    "currency" "text" DEFAULT 'INR'::"text" NOT NULL,
    "total" numeric(14,2),
    "gst" numeric(14,2),
    "items" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "raw_text" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "expense_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "inbound_purchases_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'imported'::"text", 'ignored'::"text"])))
);


ALTER TABLE "public"."inbound_purchases" OWNER TO "postgres";


ALTER TABLE "public"."inbound_purchases" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."inbound_purchases_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."invoices" (
    "id" "text" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "customer_id" "uuid",
    "customer_name" "text" NOT NULL,
    "amount" integer NOT NULL,
    "status" "public"."invoice_status" DEFAULT 'pending'::"public"."invoice_status" NOT NULL,
    "invoice_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "due_date" "date",
    "paid_date" "date",
    "overdue_days" integer DEFAULT 0,
    "razorpay_id" "text",
    "gst_irn" "text",
    "pdf_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "adjusted_advances" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "net_payable" integer,
    "first_advance_at" timestamp with time zone,
    "quote_id" "text",
    "taxable_value" integer,
    "tax_amount" integer,
    "tax_rate" integer,
    "inter_state" boolean,
    "paid_amount" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "invoices_net_payable_range" CHECK ((("net_payable" IS NULL) OR ("net_payable" >= 0)))
);


ALTER TABLE "public"."invoices" OWNER TO "postgres";


COMMENT ON COLUMN "public"."invoices"."paid_amount" IS 'Total received against this invoice (maintained for project invoices by trg_project_payment_sync_invoice). Outstanding = amount - paid_amount unless status=paid.';



CREATE TABLE IF NOT EXISTS "public"."items" (
    "id" "text" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "vendor" "public"."vendor" NOT NULL,
    "hsn" "text" DEFAULT '998313'::"text",
    "msrp" integer NOT NULL,
    "wholesale" integer NOT NULL,
    "margin_pct" smallint GENERATED ALWAYS AS (
CASE
    WHEN ("msrp" > 0) THEN ((("msrp" - "wholesale") * 100) / "msrp")
    ELSE 0
END) STORED,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "kind" "text" DEFAULT 'main'::"text" NOT NULL,
    "prices" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "is_partner_visible" boolean DEFAULT false NOT NULL,
    "partner_price" integer,
    "synced_from_partner_id" "text",
    "item_type" "text" DEFAULT 'subscription'::"text" NOT NULL,
    CONSTRAINT "items_item_type_check" CHECK (("item_type" = ANY (ARRAY['subscription'::"text", 'one_time'::"text"]))),
    CONSTRAINT "items_kind_check" CHECK (("kind" = ANY (ARRAY['main'::"text", 'addon'::"text"]))),
    CONSTRAINT "items_partner_price_nonneg" CHECK ((("partner_price" IS NULL) OR ("partner_price" >= 0))),
    CONSTRAINT "items_partner_visible_needs_price" CHECK ((("is_partner_visible" = false) OR ("partner_price" IS NOT NULL)))
);


ALTER TABLE "public"."items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."join_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "auth_user_id" "uuid",
    "email" "text" NOT NULL,
    "full_name" "text",
    "requested_role" "public"."user_role" DEFAULT 'support'::"public"."user_role" NOT NULL,
    "status" "text" DEFAULT 'pending_approval'::"text" NOT NULL,
    "matched_by" "text" NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "decided_at" timestamp with time zone,
    "decided_by" "uuid",
    CONSTRAINT "join_requests_email_check" CHECK ((("email" = "lower"("email")) AND ("email" ~~ '%@%'::"text"))),
    CONSTRAINT "join_requests_matched_by_check" CHECK (("matched_by" = ANY (ARRAY['domain'::"text", 'manual'::"text"]))),
    CONSTRAINT "join_requests_status_check" CHECK (("status" = ANY (ARRAY['pending_approval'::"text", 'approved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."join_requests" OWNER TO "postgres";


COMMENT ON TABLE "public"."join_requests" IS 'A person waiting for an owner to let them into a tenant. Holds NO access of its own — approving it is what creates the public.users row.';



CREATE TABLE IF NOT EXISTS "public"."lead_activities" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "lead_id" "text" NOT NULL,
    "kind" "text" NOT NULL,
    "detail" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid"
);


ALTER TABLE "public"."lead_activities" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."leads" (
    "id" "text" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "company" "text" NOT NULL,
    "contact_name" "text",
    "contact_email" "text",
    "contact_phone" "text",
    "plan" "text",
    "seats" integer,
    "value" integer,
    "stage" "public"."lead_stage" DEFAULT 'new'::"public"."lead_stage" NOT NULL,
    "owner_id" "uuid",
    "source" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "domain" "text",
    "trial_started_at" timestamp with time zone,
    "trial_expires_at" timestamp with time zone,
    "trial_converted_at" timestamp with time zone,
    "trial_expired_at" timestamp with time zone,
    "follow_up_date" "date",
    "priority" "text" DEFAULT 'medium'::"text" NOT NULL,
    "gstin" "text",
    "state_code" "text",
    "state" "text",
    "subscription_type" "text",
    "country" "text" DEFAULT 'India'::"text" NOT NULL,
    "is_junk" boolean DEFAULT false NOT NULL,
    "contact_id" "text",
    "lost_reason" "text",
    "lost_note" "text",
    "lost_at" timestamp with time zone,
    CONSTRAINT "leads_lost_reason_check" CHECK ((("lost_reason" IS NULL) OR ("lost_reason" = ANY (ARRAY['price'::"text", 'competitor'::"text", 'no_response'::"text", 'timing'::"text", 'not_qualified'::"text", 'other'::"text"])))),
    CONSTRAINT "leads_priority_check" CHECK (("priority" = ANY (ARRAY['low'::"text", 'medium'::"text", 'high'::"text"]))),
    CONSTRAINT "leads_subscription_type_check" CHECK (("subscription_type" = ANY (ARRAY['fresh'::"text", 'switch'::"text"])))
);


ALTER TABLE "public"."leads" OWNER TO "postgres";


COMMENT ON COLUMN "public"."leads"."domain" IS 'Customer workspace domain — required for Google Workspace / M365 / Zoho provisioning. Copied to quote + subscription downstream.';



COMMENT ON COLUMN "public"."leads"."trial_started_at" IS 'When trial provisioning began (set by /api/public/trial/workspace).';



COMMENT ON COLUMN "public"."leads"."trial_expires_at" IS 'When the 14-day trial expires. Drives cron + reminders.';



COMMENT ON COLUMN "public"."leads"."trial_converted_at" IS 'When the trial was converted to paid (stage moved to won).';



COMMENT ON COLUMN "public"."leads"."trial_expired_at" IS 'When the trial expired without converting (cron marks this).';



COMMENT ON COLUMN "public"."leads"."state_code" IS 'GST state code (2 digits, e.g. 27=Maharashtra) captured from the buy page. Copied to the customer on conversion to drive the GST head (IGST vs CGST+SGST).';



COMMENT ON COLUMN "public"."leads"."state" IS 'Human-readable GST state name (e.g. "Maharashtra (27)") for display; paired with state_code.';



COMMENT ON COLUMN "public"."leads"."country" IS 'Prospect country. Non-India marks an export (zero-rated) prospect, mirroring customers.country.';



COMMENT ON COLUMN "public"."leads"."is_junk" IS 'true = spam/fake/test lead; hidden from working views, shown only in the Junk view';



COMMENT ON COLUMN "public"."leads"."contact_id" IS 'The master contact (person) this lead belongs to. Auto-linked on insert via resolve_or_create_contact; one person can have many leads.';



CREATE TABLE IF NOT EXISTS "public"."leave_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "from_date" "date" NOT NULL,
    "to_date" "date" NOT NULL,
    "days" numeric(5,1) NOT NULL,
    "type" "text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "leave_entries_days_check" CHECK (("days" > (0)::numeric)),
    CONSTRAINT "leave_entries_type_check" CHECK (("type" = ANY (ARRAY['casual'::"text", 'sick'::"text", 'earned'::"text", 'unpaid'::"text"])))
);


ALTER TABLE "public"."leave_entries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "quote_id" "text" NOT NULL,
    "customer_id" "uuid",
    "amount" integer NOT NULL,
    "method" "text" NOT NULL,
    "reference" "text",
    "notes" "text",
    "status" "text" DEFAULT 'received'::"text" NOT NULL,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "refunded_at" timestamp with time zone,
    "refund_reason" "text",
    "recorded_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "receipt_voucher_no" "text",
    "bank_account_id" "uuid",
    "receipt_file_path" "text",
    CONSTRAINT "payments_amount_check" CHECK (("amount" > 0)),
    CONSTRAINT "payments_method_check" CHECK (("method" = ANY (ARRAY['upi'::"text", 'razorpay'::"text", 'bank_transfer'::"text", 'cheque'::"text", 'cash'::"text", 'other'::"text"]))),
    CONSTRAINT "payments_status_check" CHECK (("status" = ANY (ARRAY['received'::"text", 'refunded'::"text"])))
);


ALTER TABLE "public"."payments" OWNER TO "postgres";


COMMENT ON COLUMN "public"."payments"."bank_account_id" IS 'Optional: which of the tenant''s bank_accounts received this payment. Reporting/reconciliation aid only — does not affect any computed balance.';



COMMENT ON COLUMN "public"."payments"."receipt_file_path" IS 'Optional proof-of-payment file path in the private documents bucket ({tenant_id}/payments/{payment_id}-{name}). Nullable; view via signed URL.';



CREATE TABLE IF NOT EXISTS "public"."po_bill_allocations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "purchase_order_id" "text" NOT NULL,
    "vendor_bill_id" "text" NOT NULL,
    "allocated_amount" integer NOT NULL,
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "po_bill_allocations_allocated_amount_check" CHECK (("allocated_amount" > 0))
);


ALTER TABLE "public"."po_bill_allocations" OWNER TO "postgres";


COMMENT ON TABLE "public"."po_bill_allocations" IS 'Many-to-many link between purchase_orders and vendor_bills. allocated_amount is the ₹ portion of the bill applied against this PO. Single bill from Google CSP often covers many customer POs; single annual PO spans many monthly bills.';



CREATE TABLE IF NOT EXISTS "public"."prepaid_advances" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "vendor_name" "text" NOT NULL,
    "vendor_id" "uuid",
    "category" "text" DEFAULT 'Marketing'::"text" NOT NULL,
    "total_amount" integer NOT NULL,
    "consumed_amount" integer DEFAULT 0 NOT NULL,
    "paid_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "payment_method" "text",
    "bank_account_id" "uuid",
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."prepaid_advances" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."project_labour" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "percent" numeric DEFAULT 100 NOT NULL,
    "months" numeric DEFAULT 1 NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "start_date" "date",
    "end_date" "date",
    CONSTRAINT "project_labour_months_check" CHECK (("months" > (0)::numeric)),
    CONSTRAINT "project_labour_percent_check" CHECK ((("percent" > (0)::numeric) AND ("percent" <= (100)::numeric)))
);


ALTER TABLE "public"."project_labour" OWNER TO "postgres";


COMMENT ON TABLE "public"."project_labour" IS 'Employee time allocated to a project (management overlay for per-project P&L). Cost = employees.monthly_gross x percent% x months. NEVER written to expenses.';



COMMENT ON COLUMN "public"."project_labour"."start_date" IS 'When this person started on the project (nullable).';



COMMENT ON COLUMN "public"."project_labour"."end_date" IS 'When this persons stint ends (nullable).';



CREATE TABLE IF NOT EXISTS "public"."project_milestones" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "seq" integer DEFAULT 1 NOT NULL,
    "label" "text" NOT NULL,
    "total_amount" integer NOT NULL,
    "due_date" "date",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "invoice_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "project_milestones_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'invoiced'::"text", 'paid'::"text"])))
);


ALTER TABLE "public"."project_milestones" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."project_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "milestone_id" "uuid",
    "amount" integer NOT NULL,
    "method" "text",
    "reference" "text",
    "received_at" "date" DEFAULT CURRENT_DATE NOT NULL,
    "bank_txn_id" "uuid",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."project_payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."project_sales" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "customer_id" "uuid",
    "customer_name" "text" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "sac_code" "text" DEFAULT '998314'::"text" NOT NULL,
    "gst_rate" integer DEFAULT 18 NOT NULL,
    "inter_state" boolean DEFAULT false NOT NULL,
    "taxable_amount" integer NOT NULL,
    "gst_amount" integer NOT NULL,
    "total_amount" integer NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "line_items" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "accepted_at" timestamp with time zone,
    "start_date" "date",
    "target_date" "date",
    CONSTRAINT "project_sales_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'quoted'::"text", 'active'::"text", 'completed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."project_sales" OWNER TO "postgres";


COMMENT ON COLUMN "public"."project_sales"."start_date" IS 'When work on the project began (nullable).';



COMMENT ON COLUMN "public"."project_sales"."target_date" IS 'Target completion / deadline (nullable).';



CREATE TABLE IF NOT EXISTS "public"."project_tasks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "status" "text" DEFAULT 'todo'::"text" NOT NULL,
    "assignee_employee_id" "uuid",
    "due_date" "date",
    "seq" integer DEFAULT 0 NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."project_tasks" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."purchase_order_summary" AS
SELECT
    NULL::"text" AS "purchase_order_id",
    NULL::"uuid" AS "tenant_id",
    NULL::"uuid" AS "subscription_id",
    NULL::"uuid" AS "customer_id",
    NULL::"text" AS "customer_name",
    NULL::"public"."vendor" AS "vendor",
    NULL::"text" AS "plan",
    NULL::integer AS "seats",
    NULL::integer AS "term_months",
    NULL::integer AS "unit_cost_pm",
    NULL::integer AS "expected_cost",
    NULL::"text" AS "status",
    NULL::timestamp with time zone AS "placed_at",
    NULL::timestamp with time zone AS "provisioned_at",
    NULL::timestamp with time zone AS "closed_at",
    NULL::integer AS "allocated_total",
    NULL::integer AS "allocation_count",
    NULL::integer AS "variance_amount";


ALTER VIEW "public"."purchase_order_summary" OWNER TO "postgres";


COMMENT ON VIEW "public"."purchase_order_summary" IS 'Per-PO rollup: expected vs allocated cost. Used by the Procurement page variance card.';



CREATE TABLE IF NOT EXISTS "public"."purchase_orders" (
    "id" "text" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "subscription_id" "uuid",
    "customer_id" "uuid",
    "customer_name" "text" NOT NULL,
    "domain" "text",
    "vendor" "public"."vendor" NOT NULL,
    "vendor_order_id" "text",
    "plan" "text" NOT NULL,
    "seats" integer NOT NULL,
    "term_months" integer DEFAULT 12 NOT NULL,
    "unit_cost_pm" integer DEFAULT 0 NOT NULL,
    "total_cost" integer DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "placed_at" timestamp with time zone,
    "provisioned_at" timestamp with time zone,
    "closed_at" timestamp with time zone,
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "purchase_orders_seats_check" CHECK (("seats" > 0)),
    CONSTRAINT "purchase_orders_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'placed'::"text", 'provisioned'::"text", 'closed'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "purchase_orders_term_months_check" CHECK (("term_months" > 0))
);


ALTER TABLE "public"."purchase_orders" OWNER TO "postgres";


COMMENT ON TABLE "public"."purchase_orders" IS 'Tracks what we must order from upstream vendors (Google CSP, MS Partner, Zoho) to fulfill each customer subscription. Auto-created at record_payment, finalized by operator.';



CREATE TABLE IF NOT EXISTS "public"."quote_send_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "quote_id" "text" NOT NULL,
    "recipient_email" "text" NOT NULL,
    "cc_emails" "text"[],
    "subject" "text",
    "status" "text" NOT NULL,
    "provider_id" "text",
    "error_message" "text",
    "sent_by" "uuid",
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "quote_send_log_status_check" CHECK (("status" = ANY (ARRAY['sent'::"text", 'stubbed'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."quote_send_log" OWNER TO "postgres";


COMMENT ON TABLE "public"."quote_send_log" IS 'Audit log of every quote email sent. status="stubbed" when RESEND_API_KEY missing; "sent" when real Resend send succeeded.';



COMMENT ON COLUMN "public"."quote_send_log"."sent_by" IS 'User who triggered the send. NULL for system-initiated sends.';



CREATE TABLE IF NOT EXISTS "public"."quotes" (
    "id" "text" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "customer_id" "uuid",
    "customer_name" "text" NOT NULL,
    "lead_id" "text",
    "plan" "text",
    "seats" integer,
    "amount" integer,
    "status" "public"."quote_status" DEFAULT 'draft'::"public"."quote_status" NOT NULL,
    "owner_id" "uuid",
    "created_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "expires_date" "date",
    "pdf_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "line_items" "jsonb" DEFAULT '[]'::"jsonb",
    "subtotal" integer DEFAULT 0,
    "total_cost" integer DEFAULT 0,
    "discount_pct" smallint DEFAULT 0,
    "tax_rate" smallint DEFAULT 18,
    "notes" "text",
    "payment_status" "public"."payment_status" DEFAULT 'none'::"public"."payment_status",
    "payment_amount" integer,
    "payment_method" "text",
    "payment_reference" "text",
    "payment_received_at" timestamp with time zone,
    "payment_notes" "text",
    "invoice_id" "text",
    "is_renewal" boolean DEFAULT false NOT NULL,
    "domain" "text",
    "extension_months" integer DEFAULT 12 NOT NULL,
    "is_extension" boolean DEFAULT false NOT NULL,
    "is_add_seats" boolean DEFAULT false NOT NULL,
    "public_token" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "currency" "text" DEFAULT 'INR'::"text" NOT NULL,
    "exchange_rate" numeric DEFAULT 1 NOT NULL,
    "is_one_off" boolean DEFAULT false NOT NULL,
    "billing_cycle" "text" DEFAULT 'yearly'::"text" NOT NULL,
    "payment_terms_days" integer,
    "terms_conditions" "text",
    "prospect_state_code" "text",
    "prospect_state" "text",
    "prospect_country" "text",
    CONSTRAINT "quotes_billing_cycle_check" CHECK (("billing_cycle" = ANY (ARRAY['monthly'::"text", 'quarterly'::"text", 'half_yearly'::"text", 'yearly'::"text"])))
);


ALTER TABLE "public"."quotes" OWNER TO "postgres";


COMMENT ON COLUMN "public"."quotes"."line_items" IS 'Array of {id,item_id?,name,qty,rate,cost} objects';



COMMENT ON COLUMN "public"."quotes"."subtotal" IS 'Sum of qty*rate before discount & tax (₹)';



COMMENT ON COLUMN "public"."quotes"."total_cost" IS 'Sum of qty*wholesale_cost for margin calc (₹)';



COMMENT ON COLUMN "public"."quotes"."discount_pct" IS 'Discount % (0-100)';



COMMENT ON COLUMN "public"."quotes"."tax_rate" IS 'GST rate % (default 18)';



COMMENT ON COLUMN "public"."quotes"."payment_status" IS 'Workflow: none → awaiting → received → invoiced';



COMMENT ON COLUMN "public"."quotes"."payment_method" IS 'razorpay / upi / bank_transfer / cheque / cash';



COMMENT ON COLUMN "public"."quotes"."payment_reference" IS 'Razorpay payment_id, UPI ref, cheque no., bank txn id';



COMMENT ON COLUMN "public"."quotes"."invoice_id" IS 'Set once invoice is generated from this paid quote';



COMMENT ON COLUMN "public"."quotes"."is_renewal" IS 'True when this quote was issued for the renewal of an existing subscription.';



COMMENT ON COLUMN "public"."quotes"."domain" IS 'Customer workspace domain inherited from the source lead. Auto-copied to subscription when payment is recorded.';



COMMENT ON COLUMN "public"."quotes"."extension_months" IS 'Months to advance subscription.renewal_date by when this (renewal) quote is paid. Default 12. Used by record_payment when is_renewal = true.';



COMMENT ON COLUMN "public"."quotes"."is_extension" IS 'True when this quote was issued via the operator "Extend subscription" flow (vs the auto-renewal cron). Display-only; roll-forward logic uses is_renewal + extension_months.';



COMMENT ON COLUMN "public"."quotes"."currency" IS 'Billing currency (ISO, e.g. USD). INR = domestic. Books stay INR; this is display-only.';



COMMENT ON COLUMN "public"."quotes"."exchange_rate" IS 'INR per 1 unit of currency (e.g. 83 for USD). foreign_amount = amount / exchange_rate.';



COMMENT ON COLUMN "public"."quotes"."prospect_state_code" IS 'GST state code (2 digits, e.g. 27=Maharashtra) captured on the quote builder for a TYPED prospect with no customer record yet. Copied to the customer by record_payment on first payment to drive the GST head (IGST vs CGST+SGST). Null when a real customer_id is picked.';



COMMENT ON COLUMN "public"."quotes"."prospect_state" IS 'Human-readable GST state name paired with prospect_state_code (display).';



COMMENT ON COLUMN "public"."quotes"."prospect_country" IS 'Typed prospect country (default India). Non-India = export; copied to the customer so future quotes detect export correctly.';



CREATE TABLE IF NOT EXISTS "public"."referral_agreements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "partner_id" "uuid" NOT NULL,
    "customer_id" "uuid",
    "quote_id" "text",
    "subscription_id" "uuid",
    "label" "text",
    "basis" "text" DEFAULT 'percent'::"text" NOT NULL,
    "percent" numeric(5,2) DEFAULT 10,
    "fixed_amount" integer DEFAULT 0,
    "scope" "text" DEFAULT 'one_time'::"text" NOT NULL,
    "deduct_tds" boolean DEFAULT false NOT NULL,
    "tds_rate" numeric(5,2) DEFAULT 5 NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    CONSTRAINT "referral_agreements_basis_check" CHECK (("basis" = ANY (ARRAY['percent'::"text", 'fixed'::"text"]))),
    CONSTRAINT "referral_agreements_fixed_amount_check" CHECK (("fixed_amount" >= 0)),
    CONSTRAINT "referral_agreements_percent_check" CHECK ((("percent" >= (0)::numeric) AND ("percent" <= (100)::numeric))),
    CONSTRAINT "referral_agreements_scope_check" CHECK (("scope" = ANY (ARRAY['one_time'::"text", 'recurring'::"text"]))),
    CONSTRAINT "referral_agreements_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'closed'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "referral_agreements_tds_rate_check" CHECK ((("tds_rate" >= (0)::numeric) AND ("tds_rate" <= (100)::numeric)))
);


ALTER TABLE "public"."referral_agreements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."referral_commissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "agreement_id" "uuid" NOT NULL,
    "partner_id" "uuid" NOT NULL,
    "customer_id" "uuid",
    "payment_id" "uuid",
    "base_amount" integer DEFAULT 0 NOT NULL,
    "basis" "text" NOT NULL,
    "rate" numeric(5,2),
    "gross_commission" integer DEFAULT 0 NOT NULL,
    "tds_amount" integer DEFAULT 0 NOT NULL,
    "net_payable" integer DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'earned'::"text" NOT NULL,
    "earned_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "paid_date" "date",
    "pay_txn_id" "uuid",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "referral_commissions_status_check" CHECK (("status" = ANY (ARRAY['earned'::"text", 'paid'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."referral_commissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."referral_partners" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "phone" "text",
    "email" "text",
    "pan" "text",
    "gstin" "text",
    "default_basis" "text" DEFAULT 'percent'::"text" NOT NULL,
    "default_percent" numeric(5,2) DEFAULT 10,
    "default_fixed_amount" integer DEFAULT 0,
    "deduct_tds" boolean DEFAULT false NOT NULL,
    "tds_rate" numeric(5,2) DEFAULT 5 NOT NULL,
    "notes" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    CONSTRAINT "referral_partners_default_basis_check" CHECK (("default_basis" = ANY (ARRAY['percent'::"text", 'fixed'::"text"]))),
    CONSTRAINT "referral_partners_default_fixed_amount_check" CHECK (("default_fixed_amount" >= 0)),
    CONSTRAINT "referral_partners_default_percent_check" CHECK ((("default_percent" >= (0)::numeric) AND ("default_percent" <= (100)::numeric))),
    CONSTRAINT "referral_partners_tds_rate_check" CHECK ((("tds_rate" >= (0)::numeric) AND ("tds_rate" <= (100)::numeric)))
);


ALTER TABLE "public"."referral_partners" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reimbursements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "person_name" "text" NOT NULL,
    "purpose" "text" NOT NULL,
    "category" "text" DEFAULT 'Other'::"text" NOT NULL,
    "amount" integer NOT NULL,
    "gst_paid" integer DEFAULT 0 NOT NULL,
    "incurred_on" "date" NOT NULL,
    "paid_via" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "settled_on" "date",
    "settled_notes" "text",
    "expense_id" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "employee_id" "uuid",
    "receipt_path" "text",
    CONSTRAINT "reimbursements_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'settled'::"text"])))
);


ALTER TABLE "public"."reimbursements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."renewal_email_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "subscription_id" "uuid" NOT NULL,
    "cadence_step" "public"."renewal_state" NOT NULL,
    "recipient_email" "text" NOT NULL,
    "subject" "text",
    "status" "text" NOT NULL,
    "provider_id" "text",
    "error_message" "text",
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "renewal_email_log_status_check" CHECK (("status" = ANY (ARRAY['sent'::"text", 'stubbed'::"text", 'failed'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."renewal_email_log" OWNER TO "postgres";


COMMENT ON TABLE "public"."renewal_email_log" IS 'Audit of every renewal-cadence email. status=stubbed when RESEND_API_KEY missing; sent when real Resend send succeeded.';



CREATE TABLE IF NOT EXISTS "public"."salary_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "period" "text" NOT NULL,
    "pay_date" "date" NOT NULL,
    "gross" integer NOT NULL,
    "lop_days" numeric(5,1) DEFAULT 0 NOT NULL,
    "lop_amount" integer DEFAULT 0 NOT NULL,
    "advance_recovered" integer DEFAULT 0 NOT NULL,
    "tds" integer DEFAULT 0 NOT NULL,
    "pf" integer DEFAULT 0 NOT NULL,
    "esi" integer DEFAULT 0 NOT NULL,
    "other_deduction" integer DEFAULT 0 NOT NULL,
    "net" integer NOT NULL,
    "bank_account_id" "uuid",
    "expense_id" "text",
    "advance_loan_id" "uuid",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "paid_status" "text" DEFAULT 'unpaid'::"text" NOT NULL,
    "reconciled_txn_id" "uuid",
    "incentive" integer DEFAULT 0 NOT NULL,
    "paid_amount" integer DEFAULT 0 NOT NULL,
    "esi_employer" integer DEFAULT 0 NOT NULL,
    "pf_employer" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "salary_payments_advance_recovered_check" CHECK (("advance_recovered" >= 0)),
    CONSTRAINT "salary_payments_esi_check" CHECK (("esi" >= 0)),
    CONSTRAINT "salary_payments_gross_check" CHECK (("gross" >= 0)),
    CONSTRAINT "salary_payments_lop_amount_check" CHECK (("lop_amount" >= 0)),
    CONSTRAINT "salary_payments_other_deduction_check" CHECK (("other_deduction" >= 0)),
    CONSTRAINT "salary_payments_paid_status_check" CHECK (("paid_status" = ANY (ARRAY['unpaid'::"text", 'partial'::"text", 'paid'::"text"]))),
    CONSTRAINT "salary_payments_pf_check" CHECK (("pf" >= 0)),
    CONSTRAINT "salary_payments_tds_check" CHECK (("tds" >= 0))
);


ALTER TABLE "public"."salary_payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."statutory_dues_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "kind" "text" DEFAULT 'mixed'::"text" NOT NULL,
    "amount" integer NOT NULL,
    "paid_on" "date" NOT NULL,
    "bank_account_id" "uuid",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "bank_txn_id" "uuid",
    CONSTRAINT "statutory_dues_payments_amount_check" CHECK (("amount" > 0)),
    CONSTRAINT "statutory_dues_payments_kind_check" CHECK (("kind" = ANY (ARRAY['tds'::"text", 'pf'::"text", 'esi'::"text", 'mixed'::"text"])))
);


ALTER TABLE "public"."statutory_dues_payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "customer_id" "uuid",
    "customer_name" "text" NOT NULL,
    "domain" "text",
    "plan" "text" NOT NULL,
    "vendor" "public"."vendor" NOT NULL,
    "seats" integer NOT NULL,
    "used" integer DEFAULT 0,
    "mrr" integer NOT NULL,
    "start_date" "date",
    "renewal_date" "date",
    "status" "public"."sub_status" DEFAULT 'active'::"public"."sub_status" NOT NULL,
    "is_urgent" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "outstanding_amount" integer DEFAULT 0 NOT NULL,
    "write_off_reason" "text",
    "written_off_at" timestamp with time zone,
    "last_reminder_at" timestamp with time zone,
    "renewal_state" "public"."renewal_state" DEFAULT 'pending'::"public"."renewal_state" NOT NULL,
    "reminder_count" smallint DEFAULT 0 NOT NULL,
    "last_reminder_sent_at_v2" timestamp with time zone,
    "renewal_quote_id" "text",
    "suspended_at" timestamp with time zone,
    "auto_renew" boolean DEFAULT true NOT NULL,
    "quote_id" "text",
    "external_ref" "text",
    "item_id" "text",
    CONSTRAINT "subscriptions_outstanding_amount_check" CHECK (("outstanding_amount" >= 0)),
    CONSTRAINT "subscriptions_reminder_count_check" CHECK (("reminder_count" >= 0))
);


ALTER TABLE "public"."subscriptions" OWNER TO "postgres";


COMMENT ON COLUMN "public"."subscriptions"."renewal_state" IS 'Where in the renewal email cadence this sub is. Updated daily by /api/cron/renewals.';



COMMENT ON COLUMN "public"."subscriptions"."renewal_quote_id" IS 'The auto-generated quote for the upcoming renewal (created at T-15). Customer pays this to renew.';



COMMENT ON COLUMN "public"."subscriptions"."suspended_at" IS 'When the auto-suspend trigger fired. Distinguishes auto-suspend from operator-initiated pause.';



COMMENT ON COLUMN "public"."subscriptions"."auto_renew" IS 'Customer-controlled flag. When false, no auto-renewal quote is generated at T-30; subscription expires on renewal_date.';



COMMENT ON COLUMN "public"."subscriptions"."quote_id" IS 'The quote whose payment created this subscription. Scopes outstanding-amount updates to the right sub when a customer has multiple subscriptions (bug #1b).';



COMMENT ON COLUMN "public"."subscriptions"."item_id" IS 'Catalog row this subscription sells, for vendor cost / margin. NULL when the plan has no catalog row (normal). Auto-filled by trg_subscriptions_resolve_item when unambiguous; an explicit value always wins.';



CREATE TABLE IF NOT EXISTS "public"."support_plans" (
    "id" "text" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "annual_price" integer DEFAULT 0 NOT NULL,
    "sort_order" smallint DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."support_plans" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."support_sync_outbox" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "subscription_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "last_error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sent_at" timestamp with time zone,
    CONSTRAINT "support_sync_outbox_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."support_sync_outbox" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."support_tickets" (
    "id" "text" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "customer_id" "uuid",
    "customer_name" "text" NOT NULL,
    "raised_by_email" "text" NOT NULL,
    "raised_by_user" "uuid",
    "category" "text" NOT NULL,
    "priority" "text" DEFAULT 'normal'::"text" NOT NULL,
    "subject" "text" NOT NULL,
    "body" "text" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "resolved_at" timestamp with time zone,
    "resolved_by" "uuid",
    "resolution_note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."support_tickets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tasks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "owner_id" "uuid",
    "title" "text" NOT NULL,
    "notes" "text",
    "kind" "public"."task_kind" DEFAULT 'followup'::"public"."task_kind" NOT NULL,
    "due_at" timestamp with time zone NOT NULL,
    "reminder_minutes_before" smallint DEFAULT 60 NOT NULL,
    "status" "public"."task_status" DEFAULT 'pending'::"public"."task_status" NOT NULL,
    "lead_id" "text",
    "quote_id" "text",
    "customer_id" "uuid",
    "subscription_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "completed_by" "uuid",
    "snooze_count" smallint DEFAULT 0 NOT NULL,
    CONSTRAINT "tasks_one_link_only" CHECK (((((
CASE
    WHEN ("lead_id" IS NULL) THEN 0
    ELSE 1
END +
CASE
    WHEN ("quote_id" IS NULL) THEN 0
    ELSE 1
END) +
CASE
    WHEN ("customer_id" IS NULL) THEN 0
    ELSE 1
END) +
CASE
    WHEN ("subscription_id" IS NULL) THEN 0
    ELSE 1
END) <= 1)),
    CONSTRAINT "tasks_reminder_minutes_before_check" CHECK (("reminder_minutes_before" >= 0)),
    CONSTRAINT "tasks_snooze_count_check" CHECK (("snooze_count" >= 0))
);


ALTER TABLE "public"."tasks" OWNER TO "postgres";


COMMENT ON TABLE "public"."tasks" IS 'Follow-up to-dos for sales reps. Polymorphic — anchored to one lead/quote/customer/subscription.';



COMMENT ON COLUMN "public"."tasks"."kind" IS 'Affordance hint for the rendering UI (icon, default reminder window).';



COMMENT ON COLUMN "public"."tasks"."due_at" IS 'UTC timestamp when this task is due. Clients render in IST.';



COMMENT ON COLUMN "public"."tasks"."snooze_count" IS 'Increment each time due_at is pushed forward — surfaces chronic snoozers.';



CREATE TABLE IF NOT EXISTS "public"."tds_receivable" (
    "id" "text" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "invoice_id" "text",
    "payment_id" "uuid",
    "customer_id" "uuid",
    "customer_name" "text" NOT NULL,
    "customer_tan" "text",
    "section" "text" NOT NULL,
    "rate_pct" numeric(5,2) NOT NULL,
    "gross_amount" integer NOT NULL,
    "tds_amount" integer NOT NULL,
    "net_paid" integer NOT NULL,
    "fiscal_year" "text" NOT NULL,
    "payment_received_date" "date" NOT NULL,
    "status" "text" DEFAULT 'pending_cert'::"text" NOT NULL,
    "form_16a_url" "text",
    "form_16a_received_date" "date",
    "appears_in_26as" boolean DEFAULT false NOT NULL,
    "appears_in_26as_date" "date",
    "claimed_in_itr" boolean DEFAULT false NOT NULL,
    "claimed_in_itr_date" "date",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."tds_receivable" OWNER TO "postgres";


COMMENT ON TABLE "public"."tds_receivable" IS 'TDS deducted by customers when paying invoices. Tracks Form 16A receipt + Form 26AS verification + ITR claim lifecycle.';



CREATE TABLE IF NOT EXISTS "public"."team_invites" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "role" "public"."user_role" DEFAULT 'sales'::"public"."user_role" NOT NULL,
    "invited_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "accepted_at" timestamp with time zone
);


ALTER TABLE "public"."team_invites" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tenant_domains" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "domain" "text" NOT NULL,
    "verified_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tenant_domains_domain_check" CHECK ((("domain" = "lower"("domain")) AND ("domain" !~~ '%@%'::"text") AND ("domain" ~~ '%.%'::"text") AND ("length"("btrim"("domain")) > 3)))
);


ALTER TABLE "public"."tenant_domains" OWNER TO "postgres";


COMMENT ON TABLE "public"."tenant_domains" IS 'Email domains belonging to a tenant. A signup whose domain matches a VERIFIED row here is parked in join_requests for owner approval — never auto-joined (CLAUDE.md §4).';



COMMENT ON COLUMN "public"."tenant_domains"."verified_at" IS 'NULL means claimed but unproven, and unproven domains route nobody. Deliberate: exceltechnologies.in is currently claimed by two accidentally-created tenants.';



CREATE TABLE IF NOT EXISTS "public"."tenant_secrets" (
    "tenant_id" "uuid" NOT NULL,
    "sandbox_api_key" "text",
    "sandbox_api_secret" "text",
    "sandbox_api_base" "text" DEFAULT 'https://api.sandbox.co.in'::"text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "whatsapp_provider" "text" DEFAULT 'meta'::"text",
    "whatsapp_phone_number_id" "text",
    "whatsapp_access_token" "text",
    "whatsapp_business_account_id" "text",
    "whatsapp_app_secret" "text",
    "whatsapp_verify_token" "text",
    "razorpay_mode" "text" DEFAULT 'test'::"text",
    "razorpay_key_id" "text",
    "razorpay_key_secret" "text",
    "razorpay_webhook_secret" "text",
    "gemini_api_key" "text",
    "gemini_model" "text",
    "resend_api_key" "text",
    CONSTRAINT "tenant_secrets_razorpay_mode_check" CHECK (("razorpay_mode" = ANY (ARRAY['test'::"text", 'live'::"text"])))
);


ALTER TABLE "public"."tenant_secrets" OWNER TO "postgres";


COMMENT ON TABLE "public"."tenant_secrets" IS 'Per-tenant API credentials (Sandbox/Razorpay/etc). Owner-only RLS.';



COMMENT ON COLUMN "public"."tenant_secrets"."whatsapp_provider" IS 'meta (default) | gupshup | twilio. Determines which API client is used.';



COMMENT ON COLUMN "public"."tenant_secrets"."whatsapp_phone_number_id" IS 'Meta-assigned Phone Number ID (numeric). Different from the actual phone number.';



COMMENT ON COLUMN "public"."tenant_secrets"."whatsapp_access_token" IS 'Meta Graph API Bearer token. Prefer a System User token (never expires).';



COMMENT ON COLUMN "public"."tenant_secrets"."whatsapp_business_account_id" IS 'Meta WhatsApp Business Account (WABA) ID — parent of the phone number.';



COMMENT ON COLUMN "public"."tenant_secrets"."whatsapp_app_secret" IS 'Meta App secret used to verify HMAC signatures on inbound webhooks.';



COMMENT ON COLUMN "public"."tenant_secrets"."whatsapp_verify_token" IS 'Arbitrary random string set in the Meta dashboard for webhook subscription verification.';



COMMENT ON COLUMN "public"."tenant_secrets"."razorpay_mode" IS 'test|live — when test, key_id starts with rzp_test_*. UI surfaces a banner so visitor knows.';



COMMENT ON COLUMN "public"."tenant_secrets"."razorpay_key_id" IS 'Razorpay public-side identifier — safe to expose to client.';



COMMENT ON COLUMN "public"."tenant_secrets"."razorpay_key_secret" IS 'Razorpay server-only secret — never sent to client.';



COMMENT ON COLUMN "public"."tenant_secrets"."razorpay_webhook_secret" IS 'Used to verify x-razorpay-signature on /api/webhooks/razorpay.';



COMMENT ON COLUMN "public"."tenant_secrets"."gemini_api_key" IS 'Per-tenant Google Gemini API key (server-only; never returned raw to the client).';



COMMENT ON COLUMN "public"."tenant_secrets"."gemini_model" IS 'Optional Gemini model override (default gemini-1.5-flash).';



COMMENT ON COLUMN "public"."tenant_secrets"."resend_api_key" IS 'Tenant''s own Resend API key, envelope-encrypted (rosv1:). NULL = fall back to the deployment-wide RESEND_API_KEY. Listed in SECRET_COLUMNS so it is never returned to a browser in the clear.';



CREATE TABLE IF NOT EXISTS "public"."tenants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "gstin" "text",
    "state" "text",
    "state_code" "text",
    "address" "text",
    "email" "text" NOT NULL,
    "phone" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "grace_period_days" smallint DEFAULT 0 NOT NULL,
    "pin_code" "text",
    "contact_name" "text",
    "setup_completed_at" timestamp with time zone,
    "gstin_verified_at" timestamp with time zone,
    "gstin_verification" "jsonb",
    "parent_tenant_id" "uuid",
    "tier" "text" DEFAULT 'reseller'::"text" NOT NULL,
    "doc_code" "text",
    "logo_url" "text",
    "lut_number" "text",
    "lut_valid_upto" "date",
    "attendance_ingest_key" "text",
    "upi_vpa" "text",
    "upi_payee_name" "text",
    "email_provider" "text" DEFAULT 'resend'::"text" NOT NULL,
    "gmail_sender_user_id" "uuid",
    "email_from_address" "text",
    "email_from_name" "text",
    CONSTRAINT "tenants_email_provider_check" CHECK (("email_provider" = ANY (ARRAY['resend'::"text", 'gmail'::"text"]))),
    CONSTRAINT "tenants_grace_period_days_check" CHECK ((("grace_period_days" >= 0) AND ("grace_period_days" <= 30))),
    CONSTRAINT "tenants_no_self_parent" CHECK ((("parent_tenant_id" IS NULL) OR ("parent_tenant_id" <> "id"))),
    CONSTRAINT "tenants_tier_check" CHECK (("tier" = ANY (ARRAY['distributor'::"text", 'reseller'::"text"])))
);


ALTER TABLE "public"."tenants" OWNER TO "postgres";


COMMENT ON TABLE "public"."tenants" IS 'Each reseller business is one tenant. Multi-tenant isolation via tenant_id + RLS.';



COMMENT ON COLUMN "public"."tenants"."grace_period_days" IS 'Days after renewal_date during which the subscription stays active despite non-payment. Default 0 = immediate suspend.';



COMMENT ON COLUMN "public"."tenants"."pin_code" IS 'Postal PIN code for the registered business address (6 digits in India).';



COMMENT ON COLUMN "public"."tenants"."contact_name" IS 'Owner / primary contact name; appears on GST invoice signature line.';



COMMENT ON COLUMN "public"."tenants"."setup_completed_at" IS 'When the Setup Wizard final step was completed. NULL means wizard is incomplete.';



COMMENT ON COLUMN "public"."tenants"."gstin_verified_at" IS 'When the GSTIN was last verified against GSTN via the provider. NULL = never verified, or GSTIN changed since.';



COMMENT ON COLUMN "public"."tenants"."gstin_verification" IS 'Raw provider response (Sandbox.co.in shape). Normalised fields: legal_name, trade_name, status, constitution, registration_type, valid_from, last_return_filed, jurisdiction.';



COMMENT ON COLUMN "public"."tenants"."doc_code" IS 'Short per-tenant code embedded in document numbers (e.g. ET) to keep global doc ids unique across tenants. Shown on GST invoices.';



COMMENT ON COLUMN "public"."tenants"."lut_number" IS 'LUT / ARN number for zero-rated exports without IGST (CGST Rule 96A)';



COMMENT ON COLUMN "public"."tenants"."lut_valid_upto" IS 'LUT validity end date (usually the financial year end)';



COMMENT ON COLUMN "public"."tenants"."email_provider" IS 'Which transport outbound mail uses. Defaults to resend because Gmail reports no bounces — a dead address fails silently and the app would record "sent".';



COMMENT ON COLUMN "public"."tenants"."gmail_sender_user_id" IS 'Whose connected Google account sends for this tenant. Required when email_provider = gmail, because Gmail sends AS somebody and a cron has no session. ON DELETE SET NULL so removing a user disables sending loudly rather than leaving a dangling reference.';



COMMENT ON COLUMN "public"."tenants"."email_from_address" IS 'From: address for outbound mail, e.g. billing@exceltechnologies.in. Must be on a domain verified in that tenant''s own Resend account, or Resend rejects the send.';



CREATE TABLE IF NOT EXISTS "public"."user_google_tokens" (
    "user_id" "uuid" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "google_email" "text",
    "access_token" "text",
    "refresh_token" "text",
    "token_expiry" timestamp with time zone,
    "scopes" "text",
    "sync_token" "text",
    "last_synced_at" timestamp with time zone,
    "last_error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_google_tokens" OWNER TO "postgres";


COMMENT ON TABLE "public"."user_google_tokens" IS 'Per-user Google OAuth tokens for Contacts sync. Service-role only (RLS deny-all); refresh_token never exposed to the browser.';



COMMENT ON COLUMN "public"."user_google_tokens"."scopes" IS 'Scopes Google actually granted, space-separated. NULL = connected before this column existed, which is treated as "cannot send" rather than assumed. A token granted before gmail.send existed authenticates fine and fails only at send time with a 403.';



CREATE TABLE IF NOT EXISTS "public"."users" (
    "id" "uuid" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "full_name" "text",
    "initials" "text",
    "role" "public"."user_role" DEFAULT 'sales'::"public"."user_role" NOT NULL,
    "color" "text" DEFAULT 'ink'::"text",
    "avatar_url" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "can_view_deals" boolean DEFAULT false NOT NULL,
    "employee_id" "uuid"
);


ALTER TABLE "public"."users" OWNER TO "postgres";


COMMENT ON COLUMN "public"."users"."can_view_deals" IS 'Sales-role extension: when true, this user also sees the /deals page. Ignored for owner/manager (who always see Deals).';



CREATE OR REPLACE VIEW "public"."v_tenant_with_parent" AS
 SELECT "t"."id",
    "t"."name",
    "t"."tier",
    "t"."parent_tenant_id",
    "p"."name" AS "parent_name",
    "p"."tier" AS "parent_tier",
    "p"."gstin" AS "parent_gstin"
   FROM ("public"."tenants" "t"
     LEFT JOIN "public"."tenants" "p" ON (("p"."id" = "t"."parent_tenant_id")));


ALTER VIEW "public"."v_tenant_with_parent" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vault_access_log" (
    "id" bigint NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "credential_id" "uuid",
    "customer_id" "uuid",
    "user_id" "uuid",
    "action" "text" NOT NULL,
    "ip_address" "inet",
    "user_agent" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "vault_access_log_action_check" CHECK (("action" = ANY (ARRAY['view'::"text", 'copy'::"text", 'create'::"text", 'update'::"text", 'delete'::"text", 'rotate'::"text", 'export'::"text"])))
);


ALTER TABLE "public"."vault_access_log" OWNER TO "postgres";


COMMENT ON TABLE "public"."vault_access_log" IS 'Append-only record of every vault read or change. UPDATE and DELETE are revoked from all app roles so a trail cannot be edited or erased. Written BEFORE plaintext is returned: if the log write fails, the reveal must be refused.';



CREATE SEQUENCE IF NOT EXISTS "public"."vault_access_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."vault_access_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."vault_access_log_id_seq" OWNED BY "public"."vault_access_log"."id";



CREATE TABLE IF NOT EXISTS "public"."vault_passwords" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "customer_id" "uuid",
    "title" "text" NOT NULL,
    "category" "public"."vault_category" DEFAULT 'other'::"public"."vault_category" NOT NULL,
    "url" "text",
    "username_ciphertext" "text",
    "password_ciphertext" "text",
    "notes_ciphertext" "text",
    "password_fingerprint" "text",
    "last_rotated_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "vault_passwords_password_fingerprint_check" CHECK ((("password_fingerprint" IS NULL) OR ("length"("password_fingerprint") <= 32))),
    CONSTRAINT "vault_passwords_title_check" CHECK (("length"("btrim"("title")) > 0))
);


ALTER TABLE "public"."vault_passwords" OWNER TO "postgres";


COMMENT ON TABLE "public"."vault_passwords" IS 'Credentials for customer consoles this reseller administers (Google Admin, M365, registrar, cPanel, distributor). Encrypted at rest via lib/crypto/vault.ts. NOT zero-knowledge: the server can decrypt, so personal and banking passwords do not belong here.';



COMMENT ON COLUMN "public"."vault_passwords"."password_fingerprint" IS 'Keyed truncated HMAC of the password, for detecting reuse across entries without storing anything a leak could crack. Never a substitute for the ciphertext.';



CREATE TABLE IF NOT EXISTS "public"."vendor_bills" (
    "id" "text" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "vendor_name" "text" NOT NULL,
    "vendor_gstin" "text",
    "bill_no" "text",
    "bill_date" "date" NOT NULL,
    "due_date" "date",
    "category" "text" DEFAULT 'COGS-Other'::"text" NOT NULL,
    "line_items" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "subtotal" integer DEFAULT 0 NOT NULL,
    "cgst" integer DEFAULT 0 NOT NULL,
    "sgst" integer DEFAULT 0 NOT NULL,
    "igst" integer DEFAULT 0 NOT NULL,
    "total" integer NOT NULL,
    "status" "text" DEFAULT 'unpaid'::"text" NOT NULL,
    "paid_amount" integer DEFAULT 0 NOT NULL,
    "notes" "text",
    "attachment_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source_tenant_invoice_id" "text",
    "vendor_id" "uuid",
    "currency" "text" DEFAULT 'INR'::"text" NOT NULL,
    "fx_rate" numeric DEFAULT 1 NOT NULL
);


ALTER TABLE "public"."vendor_bills" OWNER TO "postgres";


COMMENT ON TABLE "public"."vendor_bills" IS 'Bills received from suppliers (Google CSP, MS Partner, Zoho). Source of actual COGS and input GST.';



COMMENT ON COLUMN "public"."vendor_bills"."currency" IS 'Currency printed on the bill (ISO): INR, USD, … . INR = domestic.';



COMMENT ON COLUMN "public"."vendor_bills"."fx_rate" IS 'INR per 1 unit of currency at bill time (1 for INR). Foreign amount = total / fx_rate.';



CREATE TABLE IF NOT EXISTS "public"."vendors" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "gstin" "text",
    "contact_name" "text",
    "contact_email" "text",
    "contact_phone" "text",
    "default_category" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "address" "text",
    "city" "text",
    "state" "text",
    "pincode" "text"
);


ALTER TABLE "public"."vendors" OWNER TO "postgres";


COMMENT ON COLUMN "public"."vendors"."address" IS 'Street / building address of the supplier (free text).';



COMMENT ON COLUMN "public"."vendors"."city" IS 'City / town of the supplier.';



COMMENT ON COLUMN "public"."vendors"."state" IS 'State (GST place-of-supply) of the supplier.';



COMMENT ON COLUMN "public"."vendors"."pincode" IS '6-digit PIN code of the supplier.';



CREATE TABLE IF NOT EXISTS "public"."whatsapp_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "wamid" "text",
    "contact_phone" "text" NOT NULL,
    "direction" "text" NOT NULL,
    "type" "text" NOT NULL,
    "text_body" "text",
    "template_name" "text",
    "template_lang" "text",
    "template_params" "jsonb",
    "media_id" "text",
    "media_mime" "text",
    "media_filename" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "error_code" "text",
    "error_message" "text",
    "related_lead_id" "text",
    "related_quote_id" "text",
    "related_customer_id" "uuid",
    "meta_timestamp" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "whatsapp_messages_direction_check" CHECK (("direction" = ANY (ARRAY['inbound'::"text", 'outbound'::"text"]))),
    CONSTRAINT "whatsapp_messages_type_check" CHECK (("type" = ANY (ARRAY['text'::"text", 'template'::"text", 'image'::"text", 'document'::"text", 'video'::"text", 'audio'::"text", 'location'::"text", 'reaction'::"text", 'sticker'::"text", 'button'::"text", 'interactive'::"text", 'unsupported'::"text"])))
);


ALTER TABLE "public"."whatsapp_messages" OWNER TO "postgres";


COMMENT ON TABLE "public"."whatsapp_messages" IS 'Outbound + inbound WhatsApp messages (Meta Cloud API).';



COMMENT ON COLUMN "public"."whatsapp_messages"."wamid" IS 'Meta message id — used for de-dup and status updates.';



COMMENT ON COLUMN "public"."whatsapp_messages"."direction" IS 'inbound = received from customer, outbound = sent by us.';



COMMENT ON COLUMN "public"."whatsapp_messages"."status" IS 'outbound lifecycle: pending|sent|delivered|read|failed.  inbound: received.';



ALTER TABLE ONLY "public"."vault_access_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."vault_access_log_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."access_credentials"
    ADD CONSTRAINT "access_credentials_label_uniq" UNIQUE ("tenant_id", "label");



ALTER TABLE ONLY "public"."access_credentials"
    ADD CONSTRAINT "access_credentials_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."activity_log"
    ADD CONSTRAINT "activity_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_key_hash_key" UNIQUE ("key_hash");



ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."assessment_attempts"
    ADD CONSTRAINT "assessment_attempts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."assessments"
    ADD CONSTRAINT "assessments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."assessments"
    ADD CONSTRAINT "assessments_public_token_key" UNIQUE ("public_token");



ALTER TABLE ONLY "public"."attendance"
    ADD CONSTRAINT "attendance_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."attendance_settings"
    ADD CONSTRAINT "attendance_settings_pkey" PRIMARY KEY ("tenant_id");



ALTER TABLE ONLY "public"."attendance"
    ADD CONSTRAINT "attendance_tenant_id_employee_id_work_date_key" UNIQUE ("tenant_id", "employee_id", "work_date");



ALTER TABLE ONLY "public"."balance_sheet_items"
    ADD CONSTRAINT "balance_sheet_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bank_aa_connections"
    ADD CONSTRAINT "bank_aa_connections_bank_account_id_status_key" UNIQUE ("bank_account_id", "status") DEFERRABLE INITIALLY DEFERRED;



ALTER TABLE ONLY "public"."bank_aa_connections"
    ADD CONSTRAINT "bank_aa_connections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bank_accounts"
    ADD CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bank_transactions"
    ADD CONSTRAINT "bank_transactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."business_loan_payments"
    ADD CONSTRAINT "business_loan_payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."business_loans"
    ADD CONSTRAINT "business_loans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campaign_sends"
    ADD CONSTRAINT "campaign_sends_campaign_id_recipient_email_key" UNIQUE ("campaign_id", "recipient_email");



ALTER TABLE ONLY "public"."campaign_sends"
    ADD CONSTRAINT "campaign_sends_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campaign_templates"
    ADD CONSTRAINT "campaign_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campaigns"
    ADD CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."compliance_log"
    ADD CONSTRAINT "compliance_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."compliance_log"
    ADD CONSTRAINT "compliance_log_tenant_id_obligation_key_period_key_key" UNIQUE ("tenant_id", "obligation_key", "period_key");



ALTER TABLE ONLY "public"."compliance_reminder_log"
    ADD CONSTRAINT "compliance_reminder_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_greeting_log"
    ADD CONSTRAINT "contact_greeting_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_greeting_log"
    ADD CONSTRAINT "contact_greeting_log_tenant_id_contact_id_kind_channel_gree_key" UNIQUE ("tenant_id", "contact_id", "kind", "channel", "greeting_year");



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."coupon_redemptions"
    ADD CONSTRAINT "coupon_redemptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."coupons"
    ADD CONSTRAINT "coupons_pkey" PRIMARY KEY ("code");



ALTER TABLE ONLY "public"."credit_notes"
    ADD CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."customer_credits"
    ADD CONSTRAINT "customer_credits_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."customer_domains"
    ADD CONSTRAINT "customer_domains_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."customer_groups"
    ADD CONSTRAINT "customer_groups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."customer_number_seq"
    ADD CONSTRAINT "customer_number_seq_pkey" PRIMARY KEY ("tenant_id");



ALTER TABLE ONLY "public"."customer_users"
    ADD CONSTRAINT "customer_users_auth_user_id_key" UNIQUE ("auth_user_id");



ALTER TABLE ONLY "public"."customer_users"
    ADD CONSTRAINT "customer_users_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."debit_notes"
    ADD CONSTRAINT "debit_notes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."document_series"
    ADD CONSTRAINT "document_series_pkey" PRIMARY KEY ("tenant_id", "doc_type", "fiscal_year");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_log"
    ADD CONSTRAINT "email_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."emi_payments"
    ADD CONSTRAINT "emi_payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."emi_purchases"
    ADD CONSTRAINT "emi_purchases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."employee_documents"
    ADD CONSTRAINT "employee_documents_file_path_key" UNIQUE ("file_path");



ALTER TABLE ONLY "public"."employee_documents"
    ADD CONSTRAINT "employee_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."employee_loan_repayments"
    ADD CONSTRAINT "employee_loan_repayments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."employee_loans"
    ADD CONSTRAINT "employee_loans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."employees"
    ADD CONSTRAINT "employees_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."expense_claims"
    ADD CONSTRAINT "expense_claims_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."google_contact_links"
    ADD CONSTRAINT "google_contact_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."google_contact_links"
    ADD CONSTRAINT "google_contact_links_user_id_resource_name_key" UNIQUE ("user_id", "resource_name");



ALTER TABLE ONLY "public"."google_contact_links"
    ADD CONSTRAINT "google_contact_links_user_id_source_type_source_id_key" UNIQUE ("user_id", "source_type", "source_id");



ALTER TABLE ONLY "public"."holidays"
    ADD CONSTRAINT "holidays_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."holidays"
    ADD CONSTRAINT "holidays_tenant_id_holiday_date_key" UNIQUE ("tenant_id", "holiday_date");



ALTER TABLE ONLY "public"."inbound_emails"
    ADD CONSTRAINT "inbound_emails_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inbound_emails"
    ADD CONSTRAINT "inbound_emails_tenant_id_message_id_key" UNIQUE ("tenant_id", "message_id");



ALTER TABLE ONLY "public"."inbound_purchases"
    ADD CONSTRAINT "inbound_purchases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inbound_purchases"
    ADD CONSTRAINT "inbound_purchases_tenant_id_message_id_key" UNIQUE ("tenant_id", "message_id");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."items"
    ADD CONSTRAINT "items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."items"
    ADD CONSTRAINT "items_tenant_id_id_key" UNIQUE ("tenant_id", "id");



ALTER TABLE ONLY "public"."join_requests"
    ADD CONSTRAINT "join_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lead_activities"
    ADD CONSTRAINT "lead_activities_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."leave_entries"
    ADD CONSTRAINT "leave_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."po_bill_allocations"
    ADD CONSTRAINT "po_bill_allocations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."po_bill_allocations"
    ADD CONSTRAINT "po_bill_allocations_purchase_order_id_vendor_bill_id_key" UNIQUE ("purchase_order_id", "vendor_bill_id");



ALTER TABLE ONLY "public"."prepaid_advances"
    ADD CONSTRAINT "prepaid_advances_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_labour"
    ADD CONSTRAINT "project_labour_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_labour"
    ADD CONSTRAINT "project_labour_tenant_id_project_id_employee_id_key" UNIQUE ("tenant_id", "project_id", "employee_id");



ALTER TABLE ONLY "public"."project_milestones"
    ADD CONSTRAINT "project_milestones_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_payments"
    ADD CONSTRAINT "project_payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_sales"
    ADD CONSTRAINT "project_sales_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_tasks"
    ADD CONSTRAINT "project_tasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."quote_send_log"
    ADD CONSTRAINT "quote_send_log_pkey" PRIMARY KEY ("id");



ALTER TABLE "public"."quotes"
    ADD CONSTRAINT "quotes_exchange_rate_positive" CHECK (("exchange_rate" > (0)::numeric)) NOT VALID;



ALTER TABLE ONLY "public"."quotes"
    ADD CONSTRAINT "quotes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."referral_agreements"
    ADD CONSTRAINT "referral_agreements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."referral_commissions"
    ADD CONSTRAINT "referral_commissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."referral_partners"
    ADD CONSTRAINT "referral_partners_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reimbursements"
    ADD CONSTRAINT "reimbursements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."renewal_email_log"
    ADD CONSTRAINT "renewal_email_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."salary_payments"
    ADD CONSTRAINT "salary_payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."salary_payments"
    ADD CONSTRAINT "salary_payments_tenant_id_employee_id_period_key" UNIQUE ("tenant_id", "employee_id", "period");



ALTER TABLE ONLY "public"."site_promos"
    ADD CONSTRAINT "site_promos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."statutory_dues_payments"
    ADD CONSTRAINT "statutory_dues_payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."support_plans"
    ADD CONSTRAINT "support_plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."support_sync_outbox"
    ADD CONSTRAINT "support_sync_outbox_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."support_tickets"
    ADD CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tds_receivable"
    ADD CONSTRAINT "tds_receivable_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."team_invites"
    ADD CONSTRAINT "team_invites_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tenant_domains"
    ADD CONSTRAINT "tenant_domains_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tenant_secrets"
    ADD CONSTRAINT "tenant_secrets_pkey" PRIMARY KEY ("tenant_id");



ALTER TABLE ONLY "public"."tenants"
    ADD CONSTRAINT "tenants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_google_tokens"
    ADD CONSTRAINT "user_google_tokens_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vault_access_log"
    ADD CONSTRAINT "vault_access_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vault_passwords"
    ADD CONSTRAINT "vault_passwords_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vendor_bills"
    ADD CONSTRAINT "vendor_bills_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vendors"
    ADD CONSTRAINT "vendors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."whatsapp_messages"
    ADD CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id");



CREATE INDEX "access_credentials_expiry_idx" ON "public"."access_credentials" USING "btree" ("tenant_id", "expires_on") WHERE ("expires_on" IS NOT NULL);



CREATE INDEX "access_credentials_tenant_idx" ON "public"."access_credentials" USING "btree" ("tenant_id", "label");



CREATE INDEX "activity_log_tenant_time_idx" ON "public"."activity_log" USING "btree" ("tenant_id", "created_at" DESC);



CREATE INDEX "activity_log_user_idx" ON "public"."activity_log" USING "btree" ("tenant_id", "user_id", "created_at" DESC);



CREATE INDEX "assessment_attempts_idx" ON "public"."assessment_attempts" USING "btree" ("tenant_id", "assessment_id", "submitted_at" DESC);



CREATE INDEX "assessments_tenant_idx" ON "public"."assessments" USING "btree" ("tenant_id", "created_at" DESC);



CREATE INDEX "attendance_flags_idx" ON "public"."attendance" USING "btree" ("tenant_id") WHERE (("cardinality"("flags") > 0) AND ("reviewed_at" IS NULL));



CREATE INDEX "attendance_tenant_date_idx" ON "public"."attendance" USING "btree" ("tenant_id", "work_date");



CREATE INDEX "balance_sheet_items_bank_txn_idx" ON "public"."balance_sheet_items" USING "btree" ("bank_txn_id") WHERE ("bank_txn_id" IS NOT NULL);



CREATE INDEX "balance_sheet_items_tenant_idx" ON "public"."balance_sheet_items" USING "btree" ("tenant_id", "section", "sort_order");



CREATE INDEX "bank_aa_connections_account_idx" ON "public"."bank_aa_connections" USING "btree" ("bank_account_id");



CREATE INDEX "bank_aa_connections_status_idx" ON "public"."bank_aa_connections" USING "btree" ("status") WHERE ("status" = 'active'::"text");



CREATE INDEX "bank_aa_connections_tenant_idx" ON "public"."bank_aa_connections" USING "btree" ("tenant_id");



CREATE INDEX "bank_accounts_tenant_idx" ON "public"."bank_accounts" USING "btree" ("tenant_id");



CREATE INDEX "bank_txn_date_idx" ON "public"."bank_transactions" USING "btree" ("tenant_id", "txn_date" DESC);



CREATE INDEX "bank_txn_tenant_account_idx" ON "public"."bank_transactions" USING "btree" ("tenant_id", "bank_account_id");



CREATE INDEX "bank_txn_unmatched_idx" ON "public"."bank_transactions" USING "btree" ("tenant_id", "matched_to_type") WHERE ("matched_to_type" IS NULL);



CREATE INDEX "business_loan_payments_loan_idx" ON "public"."business_loan_payments" USING "btree" ("loan_id");



CREATE INDEX "business_loans_tenant_idx" ON "public"."business_loans" USING "btree" ("tenant_id", "status");



CREATE INDEX "campaign_sends_campaign_idx" ON "public"."campaign_sends" USING "btree" ("campaign_id");



CREATE INDEX "campaign_sends_lead_idx" ON "public"."campaign_sends" USING "btree" ("lead_id");



CREATE INDEX "campaigns_status_idx" ON "public"."campaigns" USING "btree" ("tenant_id", "status");



CREATE INDEX "campaigns_tenant_idx" ON "public"."campaigns" USING "btree" ("tenant_id");



CREATE INDEX "compliance_log_tenant_idx" ON "public"."compliance_log" USING "btree" ("tenant_id", "due_date");



CREATE INDEX "compliance_reminder_log_tenant_time_idx" ON "public"."compliance_reminder_log" USING "btree" ("tenant_id", "sent_at" DESC);



CREATE UNIQUE INDEX "compliance_reminder_log_uq" ON "public"."compliance_reminder_log" USING "btree" ("tenant_id", "obligation_key", "period_key", "days_before", "lower"("recipient_email"));



CREATE INDEX "contact_greeting_log_tenant_idx" ON "public"."contact_greeting_log" USING "btree" ("tenant_id", "sent_at" DESC);



CREATE INDEX "contacts_customer_id_idx" ON "public"."contacts" USING "btree" ("customer_id") WHERE ("customer_id" IS NOT NULL);



CREATE INDEX "contacts_email_idx" ON "public"."contacts" USING "btree" ("tenant_id", "lower"("email")) WHERE ("email" IS NOT NULL);



CREATE INDEX "contacts_external_idx" ON "public"."contacts" USING "btree" ("tenant_id", "source", "external_id") WHERE ("external_id" IS NOT NULL);



CREATE INDEX "contacts_status_idx" ON "public"."contacts" USING "btree" ("tenant_id", "status");



CREATE UNIQUE INDEX "contacts_tenant_external_uidx" ON "public"."contacts" USING "btree" ("tenant_id", "external_id") WHERE ("external_id" IS NOT NULL);



CREATE INDEX "contacts_tenant_idx" ON "public"."contacts" USING "btree" ("tenant_id");



CREATE UNIQUE INDEX "contacts_unique_email_per_tenant" ON "public"."contacts" USING "btree" ("tenant_id", "lower"("email")) WHERE ("email" IS NOT NULL);



CREATE INDEX "coupon_red_code_idx" ON "public"."coupon_redemptions" USING "btree" ("coupon_code");



CREATE INDEX "coupon_red_tenant_idx" ON "public"."coupon_redemptions" USING "btree" ("tenant_id");



CREATE INDEX "coupons_active_idx" ON "public"."coupons" USING "btree" ("tenant_id", "is_active") WHERE ("is_active" = true);



CREATE INDEX "coupons_tenant_idx" ON "public"."coupons" USING "btree" ("tenant_id");



CREATE INDEX "credit_notes_tenant_date_idx" ON "public"."credit_notes" USING "btree" ("tenant_id", "credit_date");



CREATE INDEX "credit_notes_tenant_invoice_idx" ON "public"."credit_notes" USING "btree" ("tenant_id", "invoice_id");



CREATE INDEX "ctmpl_system_idx" ON "public"."campaign_templates" USING "btree" ("is_system") WHERE ("is_system" = true);



CREATE INDEX "ctmpl_tenant_idx" ON "public"."campaign_templates" USING "btree" ("tenant_id");



CREATE INDEX "customer_credits_tenant_customer_status_idx" ON "public"."customer_credits" USING "btree" ("tenant_id", "customer_id", "status");



CREATE INDEX "customer_domains_customer_idx" ON "public"."customer_domains" USING "btree" ("customer_id");



CREATE UNIQUE INDEX "customer_domains_tenant_domain_unique" ON "public"."customer_domains" USING "btree" ("tenant_id", "lower"("domain"));



CREATE INDEX "customers_group_idx" ON "public"."customers" USING "btree" ("tenant_id", "group_id") WHERE ("group_id" IS NOT NULL);



CREATE INDEX "customers_manager_idx" ON "public"."customers" USING "btree" ("account_manager_id") WHERE ("account_manager_id" IS NOT NULL);



CREATE INDEX "customers_tenant_active_idx" ON "public"."customers" USING "btree" ("tenant_id", "is_active");



CREATE INDEX "debit_notes_tenant_date_idx" ON "public"."debit_notes" USING "btree" ("tenant_id", "debit_date");



CREATE INDEX "debit_notes_tenant_invoice_idx" ON "public"."debit_notes" USING "btree" ("tenant_id", "invoice_id");



CREATE INDEX "document_series_tenant_idx" ON "public"."document_series" USING "btree" ("tenant_id");



CREATE INDEX "email_log_failed_idx" ON "public"."email_log" USING "btree" ("tenant_id", "created_at" DESC) WHERE ("status" <> 'sent'::"text");



CREATE INDEX "email_log_recipient_idx" ON "public"."email_log" USING "btree" ("tenant_id", "lower"("recipient"));



CREATE INDEX "email_log_tenant_time_idx" ON "public"."email_log" USING "btree" ("tenant_id", "created_at" DESC);



CREATE INDEX "emi_payments_purchase_idx" ON "public"."emi_payments" USING "btree" ("purchase_id");



CREATE INDEX "emi_purchases_tenant_idx" ON "public"."emi_purchases" USING "btree" ("tenant_id", "status");



CREATE INDEX "employee_documents_employee_idx" ON "public"."employee_documents" USING "btree" ("employee_id");



CREATE INDEX "employee_documents_tenant_idx" ON "public"."employee_documents" USING "btree" ("tenant_id");



CREATE INDEX "employee_loan_repayments_loan_idx" ON "public"."employee_loan_repayments" USING "btree" ("loan_id");



CREATE INDEX "employee_loans_tenant_idx" ON "public"."employee_loans" USING "btree" ("tenant_id", "status");



CREATE INDEX "employees_tenant_idx" ON "public"."employees" USING "btree" ("tenant_id", "is_active");



CREATE INDEX "expense_claims_loan_idx" ON "public"."expense_claims" USING "btree" ("loan_id");



CREATE INDEX "expense_claims_tenant_idx" ON "public"."expense_claims" USING "btree" ("tenant_id", "status", "created_at" DESC);



CREATE INDEX "expenses_project_id_idx" ON "public"."expenses" USING "btree" ("project_id") WHERE ("project_id" IS NOT NULL);



CREATE INDEX "expenses_tenant_billno_idx" ON "public"."expenses" USING "btree" ("tenant_id", "bill_no") WHERE ("bill_no" IS NOT NULL);



CREATE INDEX "expenses_tenant_unpaid_idx" ON "public"."expenses" USING "btree" ("tenant_id") WHERE ("paid" = false);



CREATE INDEX "expenses_vendor_id_idx" ON "public"."expenses" USING "btree" ("vendor_id");



CREATE INDEX "google_contact_links_tenant_idx" ON "public"."google_contact_links" USING "btree" ("tenant_id");



CREATE INDEX "holidays_tenant_date_idx" ON "public"."holidays" USING "btree" ("tenant_id", "holiday_date");



CREATE INDEX "idx_api_keys_tenant" ON "public"."api_keys" USING "btree" ("tenant_id");



CREATE INDEX "idx_customer_users_customer" ON "public"."customer_users" USING "btree" ("customer_id");



CREATE INDEX "idx_customer_users_email" ON "public"."customer_users" USING "btree" ("lower"("email"));



CREATE INDEX "idx_customer_users_tenant" ON "public"."customer_users" USING "btree" ("tenant_id");



CREATE INDEX "idx_customers_domain" ON "public"."customers" USING "btree" ("tenant_id", "domain");



CREATE INDEX "idx_customers_linked_tenant" ON "public"."customers" USING "btree" ("linked_tenant_id") WHERE ("linked_tenant_id" IS NOT NULL);



CREATE INDEX "idx_customers_tenant" ON "public"."customers" USING "btree" ("tenant_id");



CREATE INDEX "idx_customers_tenant_customer_number" ON "public"."customers" USING "btree" ("tenant_id", "customer_number");



CREATE INDEX "idx_documents_expiry" ON "public"."documents" USING "btree" ("expiry_date") WHERE ("expiry_date" IS NOT NULL);



CREATE INDEX "idx_documents_tenant" ON "public"."documents" USING "btree" ("tenant_id");



CREATE INDEX "idx_employees_biometric" ON "public"."employees" USING "btree" ("tenant_id", "biometric_id");



CREATE INDEX "idx_expenses_prepaid_advance" ON "public"."expenses" USING "btree" ("prepaid_advance_id");



CREATE INDEX "idx_expenses_tenant_category" ON "public"."expenses" USING "btree" ("tenant_id", "category");



CREATE INDEX "idx_expenses_tenant_date" ON "public"."expenses" USING "btree" ("tenant_id", "expense_date" DESC);



CREATE INDEX "idx_inbound_emails_pending_bill" ON "public"."inbound_emails" USING "btree" ("tenant_id", "created_at" DESC) WHERE (("route" = 'billing'::"text") AND ("bill_id" IS NULL));



CREATE INDEX "idx_inbound_emails_route" ON "public"."inbound_emails" USING "btree" ("tenant_id", "route", "created_at" DESC);



CREATE INDEX "idx_invoices_tenant_status" ON "public"."invoices" USING "btree" ("tenant_id", "status");



CREATE INDEX "idx_items_partner_visible" ON "public"."items" USING "btree" ("tenant_id", "is_partner_visible") WHERE ("is_partner_visible" = true);



CREATE INDEX "idx_items_synced_from_partner" ON "public"."items" USING "btree" ("synced_from_partner_id") WHERE ("synced_from_partner_id" IS NOT NULL);



CREATE INDEX "idx_items_tenant" ON "public"."items" USING "btree" ("tenant_id");



CREATE INDEX "idx_leads_domain" ON "public"."leads" USING "btree" ("lower"("domain")) WHERE ("domain" IS NOT NULL);



CREATE INDEX "idx_leads_follow_up_date" ON "public"."leads" USING "btree" ("follow_up_date") WHERE ("follow_up_date" IS NOT NULL);



CREATE INDEX "idx_leads_priority" ON "public"."leads" USING "btree" ("priority") WHERE ("priority" <> 'medium'::"text");



CREATE INDEX "idx_leads_tenant_stage" ON "public"."leads" USING "btree" ("tenant_id", "stage");



CREATE INDEX "idx_payments_bank_account" ON "public"."payments" USING "btree" ("bank_account_id");



CREATE INDEX "idx_project_milestones_project" ON "public"."project_milestones" USING "btree" ("project_id");



CREATE INDEX "idx_project_payments_project" ON "public"."project_payments" USING "btree" ("project_id");



CREATE INDEX "idx_project_tasks_assignee" ON "public"."project_tasks" USING "btree" ("assignee_employee_id");



CREATE INDEX "idx_project_tasks_project" ON "public"."project_tasks" USING "btree" ("project_id", "seq");



CREATE INDEX "idx_quotes_domain" ON "public"."quotes" USING "btree" ("lower"("domain")) WHERE ("domain" IS NOT NULL);



CREATE INDEX "idx_quotes_status" ON "public"."quotes" USING "btree" ("tenant_id", "status");



CREATE INDEX "idx_quotes_tenant" ON "public"."quotes" USING "btree" ("tenant_id");



CREATE INDEX "idx_site_promos_tenant_active" ON "public"."site_promos" USING "btree" ("tenant_id", "is_active");



CREATE INDEX "idx_subs_renewal" ON "public"."subscriptions" USING "btree" ("tenant_id", "renewal_date");



CREATE INDEX "idx_subs_tenant" ON "public"."subscriptions" USING "btree" ("tenant_id");



CREATE INDEX "idx_support_plans_tenant" ON "public"."support_plans" USING "btree" ("tenant_id");



CREATE INDEX "idx_support_sync_outbox_pending" ON "public"."support_sync_outbox" USING "btree" ("created_at") WHERE ("status" = 'pending'::"text");



CREATE INDEX "idx_support_tickets_customer" ON "public"."support_tickets" USING "btree" ("customer_id");



CREATE INDEX "idx_support_tickets_priority" ON "public"."support_tickets" USING "btree" ("tenant_id", "priority");



CREATE INDEX "idx_support_tickets_tenant_status" ON "public"."support_tickets" USING "btree" ("tenant_id", "status");



CREATE INDEX "idx_tds_receivable_invoice" ON "public"."tds_receivable" USING "btree" ("invoice_id");



CREATE INDEX "idx_tds_receivable_tenant_cust" ON "public"."tds_receivable" USING "btree" ("tenant_id", "customer_id");



CREATE INDEX "idx_tds_receivable_tenant_fy" ON "public"."tds_receivable" USING "btree" ("tenant_id", "fiscal_year");



CREATE INDEX "idx_tds_receivable_tenant_status" ON "public"."tds_receivable" USING "btree" ("tenant_id", "status");



CREATE UNIQUE INDEX "idx_tenants_attendance_ingest_key" ON "public"."tenants" USING "btree" ("attendance_ingest_key");



CREATE INDEX "idx_tenants_parent_tenant_id" ON "public"."tenants" USING "btree" ("parent_tenant_id");



CREATE INDEX "idx_tenants_tier" ON "public"."tenants" USING "btree" ("tier");



CREATE INDEX "idx_users_tenant" ON "public"."users" USING "btree" ("tenant_id");



CREATE INDEX "idx_vendor_bills_tenant_category" ON "public"."vendor_bills" USING "btree" ("tenant_id", "category");



CREATE INDEX "idx_vendor_bills_tenant_date" ON "public"."vendor_bills" USING "btree" ("tenant_id", "bill_date" DESC);



CREATE INDEX "idx_vendor_bills_tenant_status" ON "public"."vendor_bills" USING "btree" ("tenant_id", "status") WHERE ("status" <> 'paid'::"text");



CREATE INDEX "idx_whatsapp_messages_recent" ON "public"."whatsapp_messages" USING "btree" ("tenant_id", "created_at" DESC);



CREATE INDEX "idx_whatsapp_messages_thread" ON "public"."whatsapp_messages" USING "btree" ("tenant_id", "contact_phone", "created_at" DESC);



CREATE UNIQUE INDEX "idx_whatsapp_messages_wamid_tenant" ON "public"."whatsapp_messages" USING "btree" ("tenant_id", "wamid") WHERE ("wamid" IS NOT NULL);



CREATE INDEX "inbound_purchases_tenant_status_idx" ON "public"."inbound_purchases" USING "btree" ("tenant_id", "status", "created_at" DESC);



CREATE INDEX "invoices_customer_idx" ON "public"."invoices" USING "btree" ("customer_id") WHERE ("customer_id" IS NOT NULL);



CREATE INDEX "invoices_first_advance_idx" ON "public"."invoices" USING "btree" ("first_advance_at") WHERE ("first_advance_at" IS NOT NULL);



CREATE INDEX "invoices_quote_idx" ON "public"."invoices" USING "btree" ("quote_id") WHERE ("quote_id" IS NOT NULL);



CREATE UNIQUE INDEX "invoices_quote_unique" ON "public"."invoices" USING "btree" ("quote_id") WHERE ("quote_id" IS NOT NULL);



CREATE INDEX "invoices_razorpay_idx" ON "public"."invoices" USING "btree" ("razorpay_id") WHERE ("razorpay_id" IS NOT NULL);



CREATE INDEX "items_kind_idx" ON "public"."items" USING "btree" ("kind");



CREATE UNIQUE INDEX "join_requests_one_open_per_email" ON "public"."join_requests" USING "btree" ("tenant_id", "lower"("email")) WHERE ("status" = 'pending_approval'::"text");



CREATE INDEX "join_requests_tenant_status_idx" ON "public"."join_requests" USING "btree" ("tenant_id", "status", "created_at" DESC);



CREATE INDEX "lead_activities_lead_idx" ON "public"."lead_activities" USING "btree" ("lead_id", "created_at" DESC);



CREATE INDEX "leads_contact_id_idx" ON "public"."leads" USING "btree" ("contact_id") WHERE ("contact_id" IS NOT NULL);



CREATE INDEX "leads_lost_reason_idx" ON "public"."leads" USING "btree" ("tenant_id", "lost_at" DESC) WHERE ("stage" = 'lost'::"public"."lead_stage");



CREATE INDEX "leads_owner_idx" ON "public"."leads" USING "btree" ("owner_id") WHERE ("owner_id" IS NOT NULL);



CREATE INDEX "leads_tenant_active_idx" ON "public"."leads" USING "btree" ("tenant_id") WHERE ("is_junk" = false);



CREATE INDEX "leads_trial_expires_idx" ON "public"."leads" USING "btree" ("trial_expires_at") WHERE ("stage" = 'trial'::"public"."lead_stage");



CREATE INDEX "leave_entries_emp_idx" ON "public"."leave_entries" USING "btree" ("employee_id", "from_date");



CREATE INDEX "payments_customer_idx" ON "public"."payments" USING "btree" ("customer_id");



CREATE UNIQUE INDEX "payments_idempotency_uq" ON "public"."payments" USING "btree" ("tenant_id", "quote_id", "reference") WHERE ("status" = 'received'::"text");



CREATE INDEX "payments_quote_idx" ON "public"."payments" USING "btree" ("quote_id");



CREATE UNIQUE INDEX "payments_receipt_voucher_unique" ON "public"."payments" USING "btree" ("tenant_id", "receipt_voucher_no") WHERE ("receipt_voucher_no" IS NOT NULL);



CREATE INDEX "payments_received_idx" ON "public"."payments" USING "btree" ("received_at" DESC);



CREATE INDEX "payments_tenant_idx" ON "public"."payments" USING "btree" ("tenant_id");



CREATE INDEX "po_alloc_bill_idx" ON "public"."po_bill_allocations" USING "btree" ("vendor_bill_id");



CREATE INDEX "po_alloc_po_idx" ON "public"."po_bill_allocations" USING "btree" ("purchase_order_id");



CREATE INDEX "po_alloc_tenant_idx" ON "public"."po_bill_allocations" USING "btree" ("tenant_id");



CREATE INDEX "prepaid_advances_tenant_idx" ON "public"."prepaid_advances" USING "btree" ("tenant_id", "paid_date" DESC);



CREATE INDEX "project_labour_employee_idx" ON "public"."project_labour" USING "btree" ("employee_id");



CREATE INDEX "project_labour_project_idx" ON "public"."project_labour" USING "btree" ("project_id");



CREATE INDEX "purchase_orders_subscription_idx" ON "public"."purchase_orders" USING "btree" ("subscription_id");



CREATE INDEX "purchase_orders_tenant_status_idx" ON "public"."purchase_orders" USING "btree" ("tenant_id", "status");



CREATE INDEX "purchase_orders_vendor_idx" ON "public"."purchase_orders" USING "btree" ("tenant_id", "vendor");



CREATE INDEX "quote_send_log_quote_idx" ON "public"."quote_send_log" USING "btree" ("quote_id", "sent_at" DESC);



CREATE INDEX "quote_send_log_tenant_idx" ON "public"."quote_send_log" USING "btree" ("tenant_id", "sent_at" DESC);



CREATE INDEX "quotes_customer_idx" ON "public"."quotes" USING "btree" ("customer_id") WHERE ("customer_id" IS NOT NULL);



CREATE INDEX "quotes_invoice_idx" ON "public"."quotes" USING "btree" ("invoice_id") WHERE ("invoice_id" IS NOT NULL);



CREATE INDEX "quotes_is_renewal_idx" ON "public"."quotes" USING "btree" ("tenant_id", "is_renewal") WHERE ("is_renewal" = true);



CREATE INDEX "quotes_lead_idx" ON "public"."quotes" USING "btree" ("lead_id") WHERE ("lead_id" IS NOT NULL);



CREATE UNIQUE INDEX "quotes_public_token_key" ON "public"."quotes" USING "btree" ("public_token");



CREATE UNIQUE INDEX "referral_agreements_one_active_per_customer" ON "public"."referral_agreements" USING "btree" ("tenant_id", "customer_id") WHERE (("status" = 'active'::"text") AND ("customer_id" IS NOT NULL));



CREATE INDEX "referral_agreements_partner_idx" ON "public"."referral_agreements" USING "btree" ("tenant_id", "partner_id");



CREATE INDEX "referral_commissions_partner_idx" ON "public"."referral_commissions" USING "btree" ("tenant_id", "partner_id");



CREATE INDEX "referral_commissions_status_idx" ON "public"."referral_commissions" USING "btree" ("tenant_id", "status");



CREATE UNIQUE INDEX "referral_commissions_unique_payment" ON "public"."referral_commissions" USING "btree" ("agreement_id", "payment_id") WHERE ("payment_id" IS NOT NULL);



CREATE INDEX "referral_partners_tenant_idx" ON "public"."referral_partners" USING "btree" ("tenant_id");



CREATE INDEX "reimbursements_employee_idx" ON "public"."reimbursements" USING "btree" ("employee_id") WHERE ("employee_id" IS NOT NULL);



CREATE INDEX "reimbursements_status_idx" ON "public"."reimbursements" USING "btree" ("tenant_id", "status");



CREATE INDEX "reimbursements_tenant_idx" ON "public"."reimbursements" USING "btree" ("tenant_id");



CREATE INDEX "renewal_email_log_step_idx" ON "public"."renewal_email_log" USING "btree" ("subscription_id", "cadence_step", "sent_at");



CREATE INDEX "renewal_email_log_sub_idx" ON "public"."renewal_email_log" USING "btree" ("subscription_id", "sent_at" DESC);



CREATE INDEX "salary_payments_tenant_idx" ON "public"."salary_payments" USING "btree" ("tenant_id", "period");



CREATE INDEX "statutory_dues_tenant_idx" ON "public"."statutory_dues_payments" USING "btree" ("tenant_id", "paid_on");



CREATE INDEX "subscriptions_customer_idx" ON "public"."subscriptions" USING "btree" ("customer_id") WHERE ("customer_id" IS NOT NULL);



CREATE INDEX "subscriptions_outstanding_idx" ON "public"."subscriptions" USING "btree" ("outstanding_amount") WHERE ("outstanding_amount" > 0);



CREATE INDEX "subscriptions_renewal_date_idx" ON "public"."subscriptions" USING "btree" ("renewal_date") WHERE (("renewal_date" IS NOT NULL) AND ("status" = 'active'::"public"."sub_status"));



CREATE INDEX "subscriptions_renewal_state_idx" ON "public"."subscriptions" USING "btree" ("renewal_state") WHERE ("renewal_state" = ANY (ARRAY['pending'::"public"."renewal_state", 'notice_sent'::"public"."renewal_state", 'reminder_1'::"public"."renewal_state", 'reminder_2'::"public"."renewal_state", 'reminder_3'::"public"."renewal_state", 'reminder_4'::"public"."renewal_state", 'final_sent'::"public"."renewal_state", 'grace_period'::"public"."renewal_state"]));



CREATE INDEX "subscriptions_tenant_item_idx" ON "public"."subscriptions" USING "btree" ("tenant_id", "item_id");



CREATE UNIQUE INDEX "subscriptions_tenant_quote_domain_unique" ON "public"."subscriptions" USING "btree" ("tenant_id", "quote_id", "lower"("domain")) WHERE (("quote_id" IS NOT NULL) AND ("domain" IS NOT NULL));



CREATE INDEX "tasks_customer_idx" ON "public"."tasks" USING "btree" ("customer_id") WHERE ("customer_id" IS NOT NULL);



CREATE INDEX "tasks_lead_idx" ON "public"."tasks" USING "btree" ("lead_id") WHERE ("lead_id" IS NOT NULL);



CREATE INDEX "tasks_owner_due_pending_idx" ON "public"."tasks" USING "btree" ("owner_id", "due_at") WHERE ("status" = 'pending'::"public"."task_status");



CREATE INDEX "tasks_quote_idx" ON "public"."tasks" USING "btree" ("quote_id") WHERE ("quote_id" IS NOT NULL);



CREATE INDEX "tasks_subscription_idx" ON "public"."tasks" USING "btree" ("subscription_id") WHERE ("subscription_id" IS NOT NULL);



CREATE INDEX "tasks_tenant_due_pending_idx" ON "public"."tasks" USING "btree" ("tenant_id", "due_at") WHERE ("status" = 'pending'::"public"."task_status");



CREATE UNIQUE INDEX "team_invites_email_unique" ON "public"."team_invites" USING "btree" ("lower"("email"));



CREATE UNIQUE INDEX "tenant_domains_domain_unique" ON "public"."tenant_domains" USING "btree" ("lower"("domain"));



CREATE INDEX "tenant_domains_tenant_idx" ON "public"."tenant_domains" USING "btree" ("tenant_id");



CREATE INDEX "tenants_gmail_sender_idx" ON "public"."tenants" USING "btree" ("gmail_sender_user_id") WHERE ("gmail_sender_user_id" IS NOT NULL);



CREATE UNIQUE INDEX "ux_vendor_bills_source_tenant_invoice" ON "public"."vendor_bills" USING "btree" ("tenant_id", "source_tenant_invoice_id") WHERE ("source_tenant_invoice_id" IS NOT NULL);



CREATE INDEX "vault_access_log_cred_idx" ON "public"."vault_access_log" USING "btree" ("credential_id", "created_at" DESC);



CREATE INDEX "vault_access_log_tenant_idx" ON "public"."vault_access_log" USING "btree" ("tenant_id", "created_at" DESC);



CREATE INDEX "vault_passwords_customer_idx" ON "public"."vault_passwords" USING "btree" ("tenant_id", "customer_id") WHERE ("customer_id" IS NOT NULL);



CREATE INDEX "vault_passwords_print_idx" ON "public"."vault_passwords" USING "btree" ("tenant_id", "password_fingerprint") WHERE ("password_fingerprint" IS NOT NULL);



CREATE INDEX "vault_passwords_tenant_idx" ON "public"."vault_passwords" USING "btree" ("tenant_id", "title");



CREATE INDEX "vendor_bills_vendor_idx" ON "public"."vendor_bills" USING "btree" ("vendor_id") WHERE ("vendor_id" IS NOT NULL);



CREATE INDEX "vendors_tenant_idx" ON "public"."vendors" USING "btree" ("tenant_id");



CREATE UNIQUE INDEX "vendors_tenant_name_uniq" ON "public"."vendors" USING "btree" ("tenant_id", "lower"(TRIM(BOTH FROM "name")));



CREATE OR REPLACE VIEW "public"."purchase_order_summary" AS
 SELECT "p"."id" AS "purchase_order_id",
    "p"."tenant_id",
    "p"."subscription_id",
    "p"."customer_id",
    "p"."customer_name",
    "p"."vendor",
    "p"."plan",
    "p"."seats",
    "p"."term_months",
    "p"."unit_cost_pm",
    "p"."total_cost" AS "expected_cost",
    "p"."status",
    "p"."placed_at",
    "p"."provisioned_at",
    "p"."closed_at",
    (COALESCE("sum"("a"."allocated_amount"), (0)::bigint))::integer AS "allocated_total",
    ("count"("a"."id"))::integer AS "allocation_count",
    ("p"."total_cost" - (COALESCE("sum"("a"."allocated_amount"), (0)::bigint))::integer) AS "variance_amount"
   FROM ("public"."purchase_orders" "p"
     LEFT JOIN "public"."po_bill_allocations" "a" ON (("a"."purchase_order_id" = "p"."id")))
  GROUP BY "p"."id";



CREATE OR REPLACE TRIGGER "trg_accrue_referral_commission" AFTER INSERT ON "public"."payments" FOR EACH ROW EXECUTE FUNCTION "public"."fn_accrue_referral_commission"();



CREATE OR REPLACE TRIGGER "trg_activity_bank_transactions" AFTER INSERT OR DELETE OR UPDATE ON "public"."bank_transactions" FOR EACH ROW EXECUTE FUNCTION "public"."log_row_change"();



CREATE OR REPLACE TRIGGER "trg_activity_contacts" AFTER INSERT OR DELETE OR UPDATE ON "public"."contacts" FOR EACH ROW EXECUTE FUNCTION "public"."log_row_change"();



CREATE OR REPLACE TRIGGER "trg_activity_customers" AFTER INSERT OR DELETE OR UPDATE ON "public"."customers" FOR EACH ROW EXECUTE FUNCTION "public"."log_row_change"();



CREATE OR REPLACE TRIGGER "trg_activity_employees" AFTER INSERT OR DELETE OR UPDATE ON "public"."employees" FOR EACH ROW EXECUTE FUNCTION "public"."log_row_change"();



CREATE OR REPLACE TRIGGER "trg_activity_expenses" AFTER INSERT OR DELETE OR UPDATE ON "public"."expenses" FOR EACH ROW EXECUTE FUNCTION "public"."log_row_change"();



CREATE OR REPLACE TRIGGER "trg_activity_invoices" AFTER INSERT OR DELETE OR UPDATE ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "public"."log_row_change"();



CREATE OR REPLACE TRIGGER "trg_activity_leads" AFTER INSERT OR DELETE OR UPDATE ON "public"."leads" FOR EACH ROW EXECUTE FUNCTION "public"."log_row_change"();



CREATE OR REPLACE TRIGGER "trg_activity_payments" AFTER INSERT OR DELETE OR UPDATE ON "public"."payments" FOR EACH ROW EXECUTE FUNCTION "public"."log_row_change"();



CREATE OR REPLACE TRIGGER "trg_activity_project_sales" AFTER INSERT OR DELETE OR UPDATE ON "public"."project_sales" FOR EACH ROW EXECUTE FUNCTION "public"."log_row_change"();



CREATE OR REPLACE TRIGGER "trg_activity_quotes" AFTER INSERT OR DELETE OR UPDATE ON "public"."quotes" FOR EACH ROW EXECUTE FUNCTION "public"."log_row_change"();



CREATE OR REPLACE TRIGGER "trg_activity_subscriptions" AFTER INSERT OR DELETE OR UPDATE ON "public"."subscriptions" FOR EACH ROW EXECUTE FUNCTION "public"."log_row_change"();



CREATE OR REPLACE TRIGGER "trg_activity_vendor_bills" AFTER INSERT OR DELETE OR UPDATE ON "public"."vendor_bills" FOR EACH ROW EXECUTE FUNCTION "public"."log_row_change"();



CREATE OR REPLACE TRIGGER "trg_assign_customer_number" BEFORE INSERT ON "public"."customers" FOR EACH ROW EXECUTE FUNCTION "public"."assign_customer_number"();



CREATE OR REPLACE TRIGGER "trg_bank_aa_set_updated" BEFORE UPDATE ON "public"."bank_aa_connections" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_campaigns_updated_at" BEFORE UPDATE ON "public"."campaigns" FOR EACH ROW EXECUTE FUNCTION "public"."campaigns_touch_updated_at"();



CREATE OR REPLACE TRIGGER "trg_contacts_updated" BEFORE UPDATE ON "public"."contacts" FOR EACH ROW EXECUTE FUNCTION "public"."contacts_touch"();



CREATE OR REPLACE TRIGGER "trg_contacts_updated_at" BEFORE UPDATE ON "public"."contacts" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "trg_coupons_updated" BEFORE UPDATE ON "public"."coupons" FOR EACH ROW EXECUTE FUNCTION "public"."coupons_touch"();



CREATE OR REPLACE TRIGGER "trg_ctmpl_updated" BEFORE UPDATE ON "public"."campaign_templates" FOR EACH ROW EXECUTE FUNCTION "public"."campaign_templates_touch"();



CREATE OR REPLACE TRIGGER "trg_customer_groups_touch" BEFORE UPDATE ON "public"."customer_groups" FOR EACH ROW EXECUTE FUNCTION "public"."touch_customer_groups_updated_at"();



CREATE OR REPLACE TRIGGER "trg_customers_updated_at" BEFORE UPDATE ON "public"."customers" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "trg_expense_delete_guards_salary" BEFORE DELETE ON "public"."expenses" FOR EACH ROW EXECUTE FUNCTION "public"."tg_expense_delete_guards_salary"();



CREATE OR REPLACE TRIGGER "trg_expenses_updated_at" BEFORE UPDATE ON "public"."expenses" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "trg_google_contact_links_updated_at" BEFORE UPDATE ON "public"."google_contact_links" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "trg_inbound_purchases_updated_at" BEFORE UPDATE ON "public"."inbound_purchases" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "trg_invoices_updated_at" BEFORE UPDATE ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "trg_leads_autolink_contact" BEFORE INSERT ON "public"."leads" FOR EACH ROW EXECUTE FUNCTION "public"."leads_autolink_contact"();



CREATE OR REPLACE TRIGGER "trg_leads_updated_at" BEFORE UPDATE ON "public"."leads" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "trg_mirror_invoice_to_child" AFTER INSERT ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "public"."tg_mirror_invoice_to_child_vendor_bill"();



CREATE OR REPLACE TRIGGER "trg_project_labour_updated_at" BEFORE UPDATE ON "public"."project_labour" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "trg_project_payment_sync_invoice" AFTER INSERT OR DELETE OR UPDATE ON "public"."project_payments" FOR EACH ROW EXECUTE FUNCTION "public"."sync_project_invoice_paid"();



CREATE OR REPLACE TRIGGER "trg_purchase_orders_updated_at" BEFORE UPDATE ON "public"."purchase_orders" FOR EACH ROW EXECUTE FUNCTION "public"."purchase_orders_touch_updated_at"();



CREATE OR REPLACE TRIGGER "trg_queue_support_sync" AFTER INSERT OR UPDATE OF "plan", "status", "renewal_date" ON "public"."subscriptions" FOR EACH ROW WHEN (("new"."vendor" = 'support'::"public"."vendor")) EXECUTE FUNCTION "public"."queue_support_sync"();



CREATE OR REPLACE TRIGGER "trg_queue_support_sync_on_customer_status" AFTER UPDATE OF "is_active" ON "public"."customers" FOR EACH ROW EXECUTE FUNCTION "public"."queue_support_sync_on_customer_status"();



CREATE OR REPLACE TRIGGER "trg_quote_status_change" BEFORE INSERT OR UPDATE OF "status" ON "public"."quotes" FOR EACH ROW EXECUTE FUNCTION "public"."handle_quote_status_change"();



CREATE OR REPLACE TRIGGER "trg_quotes_updated_at" BEFORE UPDATE ON "public"."quotes" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "trg_site_promos_touch" BEFORE UPDATE ON "public"."site_promos" FOR EACH ROW EXECUTE FUNCTION "public"."site_promos_touch_updated_at"();



CREATE OR REPLACE TRIGGER "trg_subscriptions_resolve_item" BEFORE INSERT OR UPDATE OF "plan", "vendor", "item_id" ON "public"."subscriptions" FOR EACH ROW EXECUTE FUNCTION "public"."subscriptions_resolve_item"();



CREATE OR REPLACE TRIGGER "trg_subscriptions_updated_at" BEFORE UPDATE ON "public"."subscriptions" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "trg_support_tickets_updated_at" BEFORE UPDATE ON "public"."support_tickets" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "trg_sync_salary_paid" AFTER INSERT OR UPDATE ON "public"."bank_transactions" FOR EACH ROW EXECUTE FUNCTION "public"."sync_salary_paid_status"();



CREATE OR REPLACE TRIGGER "trg_tasks_completion" BEFORE UPDATE ON "public"."tasks" FOR EACH ROW EXECUTE FUNCTION "public"."handle_task_completion"();



CREATE OR REPLACE TRIGGER "trg_tds_receivable_updated_at" BEFORE UPDATE ON "public"."tds_receivable" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tenant_secrets_touch" BEFORE UPDATE ON "public"."tenant_secrets" FOR EACH ROW EXECUTE FUNCTION "public"."tenant_secrets_touch_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tenants_updated_at" BEFORE UPDATE ON "public"."tenants" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "trg_user_google_tokens_updated_at" BEFORE UPDATE ON "public"."user_google_tokens" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "trg_vendor_bills_updated_at" BEFORE UPDATE ON "public"."vendor_bills" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



ALTER TABLE ONLY "public"."access_credentials"
    ADD CONSTRAINT "access_credentials_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."access_credentials"
    ADD CONSTRAINT "access_credentials_holder_employee_id_fkey" FOREIGN KEY ("holder_employee_id") REFERENCES "public"."employees"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."access_credentials"
    ADD CONSTRAINT "access_credentials_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."activity_log"
    ADD CONSTRAINT "activity_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."activity_log"
    ADD CONSTRAINT "activity_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."assessment_attempts"
    ADD CONSTRAINT "assessment_attempts_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."assessment_attempts"
    ADD CONSTRAINT "assessment_attempts_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."assessment_attempts"
    ADD CONSTRAINT "assessment_attempts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."assessments"
    ADD CONSTRAINT "assessments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."assessments"
    ADD CONSTRAINT "assessments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."attendance"
    ADD CONSTRAINT "attendance_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."attendance"
    ADD CONSTRAINT "attendance_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."attendance_settings"
    ADD CONSTRAINT "attendance_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."attendance"
    ADD CONSTRAINT "attendance_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."balance_sheet_items"
    ADD CONSTRAINT "balance_sheet_items_bank_txn_id_fkey" FOREIGN KEY ("bank_txn_id") REFERENCES "public"."bank_transactions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."balance_sheet_items"
    ADD CONSTRAINT "balance_sheet_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bank_aa_connections"
    ADD CONSTRAINT "bank_aa_connections_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bank_aa_connections"
    ADD CONSTRAINT "bank_aa_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bank_accounts"
    ADD CONSTRAINT "bank_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bank_transactions"
    ADD CONSTRAINT "bank_transactions_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bank_transactions"
    ADD CONSTRAINT "bank_transactions_matched_by_fkey" FOREIGN KEY ("matched_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."bank_transactions"
    ADD CONSTRAINT "bank_transactions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."business_loan_payments"
    ADD CONSTRAINT "business_loan_payments_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."business_loan_payments"
    ADD CONSTRAINT "business_loan_payments_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."business_loan_payments"
    ADD CONSTRAINT "business_loan_payments_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "public"."business_loans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."business_loan_payments"
    ADD CONSTRAINT "business_loan_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."business_loans"
    ADD CONSTRAINT "business_loans_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."business_loans"
    ADD CONSTRAINT "business_loans_deposit_account_id_fkey" FOREIGN KEY ("deposit_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."business_loans"
    ADD CONSTRAINT "business_loans_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaign_sends"
    ADD CONSTRAINT "campaign_sends_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaign_sends"
    ADD CONSTRAINT "campaign_sends_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."campaign_sends"
    ADD CONSTRAINT "campaign_sends_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaign_templates"
    ADD CONSTRAINT "campaign_templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."campaign_templates"
    ADD CONSTRAINT "campaign_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaigns"
    ADD CONSTRAINT "campaigns_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."campaigns"
    ADD CONSTRAINT "campaigns_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."compliance_log"
    ADD CONSTRAINT "compliance_log_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."compliance_log"
    ADD CONSTRAINT "compliance_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."compliance_reminder_log"
    ADD CONSTRAINT "compliance_reminder_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contact_greeting_log"
    ADD CONSTRAINT "contact_greeting_log_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contact_greeting_log"
    ADD CONSTRAINT "contact_greeting_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_imported_by_fkey" FOREIGN KEY ("imported_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_promoted_to_lead_id_fkey" FOREIGN KEY ("promoted_to_lead_id") REFERENCES "public"."leads"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."coupon_redemptions"
    ADD CONSTRAINT "coupon_redemptions_coupon_code_fkey" FOREIGN KEY ("coupon_code") REFERENCES "public"."coupons"("code") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."coupon_redemptions"
    ADD CONSTRAINT "coupon_redemptions_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."coupon_redemptions"
    ADD CONSTRAINT "coupon_redemptions_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."coupon_redemptions"
    ADD CONSTRAINT "coupon_redemptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."coupons"
    ADD CONSTRAINT "coupons_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."coupons"
    ADD CONSTRAINT "coupons_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."credit_notes"
    ADD CONSTRAINT "credit_notes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."credit_notes"
    ADD CONSTRAINT "credit_notes_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."credit_notes"
    ADD CONSTRAINT "credit_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customer_credits"
    ADD CONSTRAINT "customer_credits_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customer_credits"
    ADD CONSTRAINT "customer_credits_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customer_domains"
    ADD CONSTRAINT "customer_domains_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customer_domains"
    ADD CONSTRAINT "customer_domains_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customer_groups"
    ADD CONSTRAINT "customer_groups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customer_number_seq"
    ADD CONSTRAINT "customer_number_seq_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customer_users"
    ADD CONSTRAINT "customer_users_auth_user_id_fkey" FOREIGN KEY ("auth_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customer_users"
    ADD CONSTRAINT "customer_users_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customer_users"
    ADD CONSTRAINT "customer_users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_account_manager_id_fkey" FOREIGN KEY ("account_manager_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."customer_groups"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_linked_tenant_id_fkey" FOREIGN KEY ("linked_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."debit_notes"
    ADD CONSTRAINT "debit_notes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."debit_notes"
    ADD CONSTRAINT "debit_notes_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."debit_notes"
    ADD CONSTRAINT "debit_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."document_series"
    ADD CONSTRAINT "document_series_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."email_log"
    ADD CONSTRAINT "email_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."email_log"
    ADD CONSTRAINT "email_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."emi_payments"
    ADD CONSTRAINT "emi_payments_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."emi_payments"
    ADD CONSTRAINT "emi_payments_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."emi_payments"
    ADD CONSTRAINT "emi_payments_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "public"."emi_purchases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."emi_payments"
    ADD CONSTRAINT "emi_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."emi_purchases"
    ADD CONSTRAINT "emi_purchases_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."emi_purchases"
    ADD CONSTRAINT "emi_purchases_down_account_id_fkey" FOREIGN KEY ("down_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."emi_purchases"
    ADD CONSTRAINT "emi_purchases_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."employee_documents"
    ADD CONSTRAINT "employee_documents_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."employee_documents"
    ADD CONSTRAINT "employee_documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."employee_loan_repayments"
    ADD CONSTRAINT "employee_loan_repayments_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."employee_loan_repayments"
    ADD CONSTRAINT "employee_loan_repayments_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."employee_loan_repayments"
    ADD CONSTRAINT "employee_loan_repayments_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "public"."employee_loans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."employee_loan_repayments"
    ADD CONSTRAINT "employee_loan_repayments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."employee_loans"
    ADD CONSTRAINT "employee_loans_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."employee_loans"
    ADD CONSTRAINT "employee_loans_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."employee_loans"
    ADD CONSTRAINT "employee_loans_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."employees"
    ADD CONSTRAINT "employees_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."expense_claims"
    ADD CONSTRAINT "expense_claims_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."expense_claims"
    ADD CONSTRAINT "expense_claims_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."expense_claims"
    ADD CONSTRAINT "expense_claims_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "public"."employee_loans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."expense_claims"
    ADD CONSTRAINT "expense_claims_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_prepaid_advance_id_fkey" FOREIGN KEY ("prepaid_advance_id") REFERENCES "public"."prepaid_advances"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."project_sales"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_reconciled_txn_id_fkey" FOREIGN KEY ("reconciled_txn_id") REFERENCES "public"."bank_transactions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."google_contact_links"
    ADD CONSTRAINT "google_contact_links_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."google_contact_links"
    ADD CONSTRAINT "google_contact_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."holidays"
    ADD CONSTRAINT "holidays_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."inbound_emails"
    ADD CONSTRAINT "inbound_emails_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "public"."vendor_bills"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inbound_emails"
    ADD CONSTRAINT "inbound_emails_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."inbound_emails"
    ADD CONSTRAINT "inbound_emails_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inbound_purchases"
    ADD CONSTRAINT "inbound_purchases_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inbound_purchases"
    ADD CONSTRAINT "inbound_purchases_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."items"
    ADD CONSTRAINT "items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."join_requests"
    ADD CONSTRAINT "join_requests_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."join_requests"
    ADD CONSTRAINT "join_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lead_activities"
    ADD CONSTRAINT "lead_activities_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lead_activities"
    ADD CONSTRAINT "lead_activities_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."leave_entries"
    ADD CONSTRAINT "leave_entries_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."leave_entries"
    ADD CONSTRAINT "leave_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."po_bill_allocations"
    ADD CONSTRAINT "po_bill_allocations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."po_bill_allocations"
    ADD CONSTRAINT "po_bill_allocations_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."po_bill_allocations"
    ADD CONSTRAINT "po_bill_allocations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."po_bill_allocations"
    ADD CONSTRAINT "po_bill_allocations_vendor_bill_id_fkey" FOREIGN KEY ("vendor_bill_id") REFERENCES "public"."vendor_bills"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."prepaid_advances"
    ADD CONSTRAINT "prepaid_advances_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."prepaid_advances"
    ADD CONSTRAINT "prepaid_advances_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."prepaid_advances"
    ADD CONSTRAINT "prepaid_advances_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."prepaid_advances"
    ADD CONSTRAINT "prepaid_advances_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."project_labour"
    ADD CONSTRAINT "project_labour_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_labour"
    ADD CONSTRAINT "project_labour_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."project_sales"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_labour"
    ADD CONSTRAINT "project_labour_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_milestones"
    ADD CONSTRAINT "project_milestones_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."project_milestones"
    ADD CONSTRAINT "project_milestones_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."project_sales"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_milestones"
    ADD CONSTRAINT "project_milestones_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_payments"
    ADD CONSTRAINT "project_payments_bank_txn_id_fkey" FOREIGN KEY ("bank_txn_id") REFERENCES "public"."bank_transactions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."project_payments"
    ADD CONSTRAINT "project_payments_milestone_id_fkey" FOREIGN KEY ("milestone_id") REFERENCES "public"."project_milestones"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."project_payments"
    ADD CONSTRAINT "project_payments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."project_sales"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_payments"
    ADD CONSTRAINT "project_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_sales"
    ADD CONSTRAINT "project_sales_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."project_sales"
    ADD CONSTRAINT "project_sales_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_tasks"
    ADD CONSTRAINT "project_tasks_assignee_employee_id_fkey" FOREIGN KEY ("assignee_employee_id") REFERENCES "public"."employees"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."project_tasks"
    ADD CONSTRAINT "project_tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."project_sales"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_tasks"
    ADD CONSTRAINT "project_tasks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."quote_send_log"
    ADD CONSTRAINT "quote_send_log_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."quote_send_log"
    ADD CONSTRAINT "quote_send_log_sent_by_fkey" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."quote_send_log"
    ADD CONSTRAINT "quote_send_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."quotes"
    ADD CONSTRAINT "quotes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."quotes"
    ADD CONSTRAINT "quotes_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."quotes"
    ADD CONSTRAINT "quotes_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."quotes"
    ADD CONSTRAINT "quotes_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."quotes"
    ADD CONSTRAINT "quotes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."referral_agreements"
    ADD CONSTRAINT "referral_agreements_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."referral_agreements"
    ADD CONSTRAINT "referral_agreements_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "public"."referral_partners"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."referral_agreements"
    ADD CONSTRAINT "referral_agreements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."referral_commissions"
    ADD CONSTRAINT "referral_commissions_agreement_id_fkey" FOREIGN KEY ("agreement_id") REFERENCES "public"."referral_agreements"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."referral_commissions"
    ADD CONSTRAINT "referral_commissions_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "public"."referral_partners"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."referral_commissions"
    ADD CONSTRAINT "referral_commissions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."referral_partners"
    ADD CONSTRAINT "referral_partners_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reimbursements"
    ADD CONSTRAINT "reimbursements_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."reimbursements"
    ADD CONSTRAINT "reimbursements_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."reimbursements"
    ADD CONSTRAINT "reimbursements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."renewal_email_log"
    ADD CONSTRAINT "renewal_email_log_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."renewal_email_log"
    ADD CONSTRAINT "renewal_email_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."salary_payments"
    ADD CONSTRAINT "salary_payments_advance_loan_id_fkey" FOREIGN KEY ("advance_loan_id") REFERENCES "public"."employee_loans"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."salary_payments"
    ADD CONSTRAINT "salary_payments_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."salary_payments"
    ADD CONSTRAINT "salary_payments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."salary_payments"
    ADD CONSTRAINT "salary_payments_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."salary_payments"
    ADD CONSTRAINT "salary_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."site_promos"
    ADD CONSTRAINT "site_promos_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."site_promos"
    ADD CONSTRAINT "site_promos_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."statutory_dues_payments"
    ADD CONSTRAINT "statutory_dues_payments_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."statutory_dues_payments"
    ADD CONSTRAINT "statutory_dues_payments_bank_txn_id_fkey" FOREIGN KEY ("bank_txn_id") REFERENCES "public"."bank_transactions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."statutory_dues_payments"
    ADD CONSTRAINT "statutory_dues_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_item_fkey" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "public"."items"("tenant_id", "id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_renewal_quote_id_fkey" FOREIGN KEY ("renewal_quote_id") REFERENCES "public"."quotes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."support_plans"
    ADD CONSTRAINT "support_plans_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."support_sync_outbox"
    ADD CONSTRAINT "support_sync_outbox_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."support_sync_outbox"
    ADD CONSTRAINT "support_sync_outbox_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."support_sync_outbox"
    ADD CONSTRAINT "support_sync_outbox_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."support_tickets"
    ADD CONSTRAINT "support_tickets_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."support_tickets"
    ADD CONSTRAINT "support_tickets_raised_by_user_fkey" FOREIGN KEY ("raised_by_user") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."support_tickets"
    ADD CONSTRAINT "support_tickets_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."support_tickets"
    ADD CONSTRAINT "support_tickets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_completed_by_fkey" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tds_receivable"
    ADD CONSTRAINT "tds_receivable_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tds_receivable"
    ADD CONSTRAINT "tds_receivable_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tds_receivable"
    ADD CONSTRAINT "tds_receivable_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tds_receivable"
    ADD CONSTRAINT "tds_receivable_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."team_invites"
    ADD CONSTRAINT "team_invites_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."team_invites"
    ADD CONSTRAINT "team_invites_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tenant_domains"
    ADD CONSTRAINT "tenant_domains_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tenant_domains"
    ADD CONSTRAINT "tenant_domains_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tenant_secrets"
    ADD CONSTRAINT "tenant_secrets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tenants"
    ADD CONSTRAINT "tenants_gmail_sender_user_id_fkey" FOREIGN KEY ("gmail_sender_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tenants"
    ADD CONSTRAINT "tenants_parent_tenant_id_fkey" FOREIGN KEY ("parent_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."user_google_tokens"
    ADD CONSTRAINT "user_google_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_google_tokens"
    ADD CONSTRAINT "user_google_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vault_access_log"
    ADD CONSTRAINT "vault_access_log_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "public"."vault_passwords"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vault_access_log"
    ADD CONSTRAINT "vault_access_log_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vault_access_log"
    ADD CONSTRAINT "vault_access_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vault_access_log"
    ADD CONSTRAINT "vault_access_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vault_passwords"
    ADD CONSTRAINT "vault_passwords_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vault_passwords"
    ADD CONSTRAINT "vault_passwords_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vault_passwords"
    ADD CONSTRAINT "vault_passwords_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vendor_bills"
    ADD CONSTRAINT "vendor_bills_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vendor_bills"
    ADD CONSTRAINT "vendor_bills_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vendors"
    ADD CONSTRAINT "vendors_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."whatsapp_messages"
    ADD CONSTRAINT "whatsapp_messages_related_customer_id_fkey" FOREIGN KEY ("related_customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."whatsapp_messages"
    ADD CONSTRAINT "whatsapp_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE "public"."access_credentials" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "access_credentials_delete" ON "public"."access_credentials" FOR DELETE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "access_credentials_insert" ON "public"."access_credentials" FOR INSERT TO "authenticated" WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "access_credentials_select" ON "public"."access_credentials" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "access_credentials_update" ON "public"."access_credentials" FOR UPDATE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."activity_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "activity_log_sel" ON "public"."activity_log" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."api_keys" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "api_keys_insert_own" ON "public"."api_keys" FOR INSERT TO "authenticated" WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "api_keys_select_own" ON "public"."api_keys" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "api_keys_update_own" ON "public"."api_keys" FOR UPDATE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."assessment_attempts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."assessments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "assessments_all" ON "public"."assessments" USING (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"())))) WITH CHECK (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))));



CREATE POLICY "attempts_select" ON "public"."assessment_attempts" FOR SELECT USING (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))));



ALTER TABLE "public"."attendance" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."attendance_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."balance_sheet_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bank_aa_connections" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bank_accounts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bank_transactions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."business_loan_payments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."business_loans" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."campaign_sends" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "campaign_sends_select" ON "public"."campaign_sends" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "campaign_sends_service_role" ON "public"."campaign_sends" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."campaign_templates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."campaigns" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "campaigns_delete" ON "public"."campaigns" FOR DELETE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "campaigns_insert" ON "public"."campaigns" FOR INSERT TO "authenticated" WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "campaigns_select" ON "public"."campaigns" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "campaigns_service_role" ON "public"."campaigns" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "campaigns_update" ON "public"."campaigns" FOR UPDATE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."compliance_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "compliance_log_delete" ON "public"."compliance_log" FOR DELETE USING (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))));



CREATE POLICY "compliance_log_insert" ON "public"."compliance_log" FOR INSERT WITH CHECK (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))));



CREATE POLICY "compliance_log_select" ON "public"."compliance_log" FOR SELECT USING (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))));



CREATE POLICY "compliance_log_update" ON "public"."compliance_log" FOR UPDATE USING (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"())))) WITH CHECK (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))));



ALTER TABLE "public"."compliance_reminder_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "compliance_reminder_log_sel" ON "public"."compliance_reminder_log" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."contact_greeting_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "contact_greeting_log_select" ON "public"."contact_greeting_log" FOR SELECT USING (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))));



ALTER TABLE "public"."contacts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "contacts_delete" ON "public"."contacts" FOR DELETE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "contacts_insert" ON "public"."contacts" FOR INSERT TO "authenticated" WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "contacts_select" ON "public"."contacts" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "contacts_service_role" ON "public"."contacts" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "contacts_update" ON "public"."contacts" FOR UPDATE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "coupon_red_select" ON "public"."coupon_redemptions" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "coupon_red_service_role" ON "public"."coupon_redemptions" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."coupon_redemptions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."coupons" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "coupons_delete" ON "public"."coupons" FOR DELETE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "coupons_insert" ON "public"."coupons" FOR INSERT TO "authenticated" WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "coupons_select" ON "public"."coupons" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "coupons_service_role" ON "public"."coupons" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "coupons_update" ON "public"."coupons" FOR UPDATE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."credit_notes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "credit_notes_delete_own_tenant" ON "public"."credit_notes" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "credit_notes_insert_own_tenant" ON "public"."credit_notes" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "credit_notes_select_own_tenant" ON "public"."credit_notes" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "credit_notes_service_role_all" ON "public"."credit_notes" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "credit_notes_update_own_tenant" ON "public"."credit_notes" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "ctmpl_delete" ON "public"."campaign_templates" FOR DELETE TO "authenticated" USING ((("is_system" = false) AND ("tenant_id" = "public"."current_tenant_id"())));



CREATE POLICY "ctmpl_insert" ON "public"."campaign_templates" FOR INSERT TO "authenticated" WITH CHECK ((("is_system" = false) AND ("tenant_id" = "public"."current_tenant_id"())));



CREATE POLICY "ctmpl_select" ON "public"."campaign_templates" FOR SELECT TO "authenticated" USING ((("is_system" = true) OR ("tenant_id" = "public"."current_tenant_id"())));



CREATE POLICY "ctmpl_service_role" ON "public"."campaign_templates" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "ctmpl_update" ON "public"."campaign_templates" FOR UPDATE TO "authenticated" USING ((("is_system" = false) AND ("tenant_id" = "public"."current_tenant_id"()))) WITH CHECK ((("is_system" = false) AND ("tenant_id" = "public"."current_tenant_id"())));



ALTER TABLE "public"."customer_credits" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "customer_credits_delete_own_tenant" ON "public"."customer_credits" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "customer_credits_insert_own_tenant" ON "public"."customer_credits" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "customer_credits_select_own_tenant" ON "public"."customer_credits" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "customer_credits_service_role_all" ON "public"."customer_credits" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "customer_credits_update_own_tenant" ON "public"."customer_credits" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."customer_domains" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "customer_domains_tenant" ON "public"."customer_domains" TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."customer_groups" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "customer_groups_delete_own_tenant" ON "public"."customer_groups" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "customer_groups_insert_own_tenant" ON "public"."customer_groups" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "customer_groups_select_own_tenant" ON "public"."customer_groups" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "customer_groups_service_role_all" ON "public"."customer_groups" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "customer_groups_update_own_tenant" ON "public"."customer_groups" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."customer_number_seq" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "customer_number_seq_service" ON "public"."customer_number_seq" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."customer_users" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "customer_users_insert_service_role" ON "public"."customer_users" FOR INSERT WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR ("auth"."role"() = 'service_role'::"text")));



CREATE POLICY "customer_users_select_own_tenant" ON "public"."customer_users" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "customer_users_select_self" ON "public"."customer_users" FOR SELECT USING (("auth_user_id" = "auth"."uid"()));



CREATE POLICY "customer_users_update_operator" ON "public"."customer_users" FOR UPDATE USING ((("tenant_id" = "public"."current_tenant_id"()) OR ("auth"."role"() = 'service_role'::"text"))) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR ("auth"."role"() = 'service_role'::"text")));



ALTER TABLE "public"."customers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "customers_delete" ON "public"."customers" FOR DELETE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "customers_insert" ON "public"."customers" FOR INSERT TO "authenticated" WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "customers_select" ON "public"."customers" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "customers_select_self_customer" ON "public"."customers" FOR SELECT USING (("id" = "public"."current_customer_id"()));



CREATE POLICY "customers_update" ON "public"."customers" FOR UPDATE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."debit_notes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "debit_notes_delete_own_tenant" ON "public"."debit_notes" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "debit_notes_insert_own_tenant" ON "public"."debit_notes" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "debit_notes_select_own_tenant" ON "public"."debit_notes" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "debit_notes_service_role_all" ON "public"."debit_notes" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "debit_notes_update_own_tenant" ON "public"."debit_notes" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."document_series" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "document_series_select" ON "public"."document_series" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "document_series_service_role" ON "public"."document_series" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."documents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "documents_tenant" ON "public"."documents" USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."email_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "email_log_select" ON "public"."email_log" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."emi_payments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."emi_purchases" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."employee_documents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "employee_documents tenant all" ON "public"."employee_documents" TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."employee_loan_repayments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."employee_loans" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."employees" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."expense_claims" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."expenses" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "expenses_delete_own_tenant" ON "public"."expenses" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "expenses_insert_own_tenant" ON "public"."expenses" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "expenses_select_own_tenant" ON "public"."expenses" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "expenses_update_own_tenant" ON "public"."expenses" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."google_contact_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."holidays" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "holidays_delete_own_tenant" ON "public"."holidays" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "holidays_insert_own_tenant" ON "public"."holidays" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "holidays_select_own_tenant" ON "public"."holidays" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "holidays_service_role_all" ON "public"."holidays" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."inbound_emails" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "inbound_emails_select_own_tenant" ON "public"."inbound_emails" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."inbound_purchases" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "inbound_purchases_select" ON "public"."inbound_purchases" FOR SELECT USING (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))));



CREATE POLICY "inbound_purchases_update" ON "public"."inbound_purchases" FOR UPDATE USING (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))));



ALTER TABLE "public"."invoices" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "invoices_insert" ON "public"."invoices" FOR INSERT TO "authenticated" WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "invoices_select" ON "public"."invoices" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "invoices_select_own_customer" ON "public"."invoices" FOR SELECT USING (("customer_id" = "public"."current_customer_id"()));



CREATE POLICY "invoices_update" ON "public"."invoices" FOR UPDATE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "items_delete" ON "public"."items" FOR DELETE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "items_insert" ON "public"."items" FOR INSERT TO "authenticated" WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "items_select" ON "public"."items" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "items_update" ON "public"."items" FOR UPDATE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."join_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "join_requests_decide" ON "public"."join_requests" FOR UPDATE TO "authenticated" USING ((("tenant_id" = "public"."current_tenant_id"()) AND (EXISTS ( SELECT 1
   FROM "public"."users" "u"
  WHERE (("u"."id" = "auth"."uid"()) AND ("u"."role" = ANY (ARRAY['owner'::"public"."user_role", 'manager'::"public"."user_role"]))))))) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "join_requests_select" ON "public"."join_requests" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."lead_activities" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."leads" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "leads_delete" ON "public"."leads" FOR DELETE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "leads_insert" ON "public"."leads" FOR INSERT TO "authenticated" WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "leads_select" ON "public"."leads" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "leads_update" ON "public"."leads" FOR UPDATE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."leave_entries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payments_insert" ON "public"."payments" FOR INSERT TO "authenticated" WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "payments_select" ON "public"."payments" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "payments_select_own_customer" ON "public"."payments" FOR SELECT USING (("customer_id" = "public"."current_customer_id"()));



CREATE POLICY "payments_service_role_all" ON "public"."payments" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "payments_update" ON "public"."payments" FOR UPDATE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "po_alloc_delete" ON "public"."po_bill_allocations" FOR DELETE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "po_alloc_insert" ON "public"."po_bill_allocations" FOR INSERT TO "authenticated" WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "po_alloc_select" ON "public"."po_bill_allocations" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "po_alloc_service_role" ON "public"."po_bill_allocations" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "po_alloc_update" ON "public"."po_bill_allocations" FOR UPDATE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."po_bill_allocations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."prepaid_advances" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "prepaid_advances_all" ON "public"."prepaid_advances" USING (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"())))) WITH CHECK (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))));



ALTER TABLE "public"."project_labour" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "project_labour_rw" ON "public"."project_labour" USING (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"())))) WITH CHECK (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))));



ALTER TABLE "public"."project_milestones" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "project_milestones_tenant" ON "public"."project_milestones" USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."project_payments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "project_payments_tenant" ON "public"."project_payments" USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."project_sales" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "project_sales_tenant" ON "public"."project_sales" USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."project_tasks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "project_tasks_tenant_all" ON "public"."project_tasks" USING (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"())))) WITH CHECK (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))));



ALTER TABLE "public"."purchase_orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "purchase_orders_delete" ON "public"."purchase_orders" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "purchase_orders_insert" ON "public"."purchase_orders" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "purchase_orders_select" ON "public"."purchase_orders" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "purchase_orders_service_role" ON "public"."purchase_orders" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "purchase_orders_update" ON "public"."purchase_orders" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."quote_send_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "quote_send_log_insert" ON "public"."quote_send_log" FOR INSERT TO "authenticated" WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "quote_send_log_select" ON "public"."quote_send_log" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "quote_send_log_service" ON "public"."quote_send_log" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."quotes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "quotes_delete" ON "public"."quotes" FOR DELETE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "quotes_insert" ON "public"."quotes" FOR INSERT TO "authenticated" WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "quotes_select" ON "public"."quotes" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "quotes_select_own_customer" ON "public"."quotes" FOR SELECT USING (("customer_id" = "public"."current_customer_id"()));



CREATE POLICY "quotes_update" ON "public"."quotes" FOR UPDATE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."referral_agreements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "referral_agreements_delete_own_tenant" ON "public"."referral_agreements" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "referral_agreements_insert_own_tenant" ON "public"."referral_agreements" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "referral_agreements_select_own_tenant" ON "public"."referral_agreements" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "referral_agreements_service_role_all" ON "public"."referral_agreements" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "referral_agreements_update_own_tenant" ON "public"."referral_agreements" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."referral_commissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "referral_commissions_delete_own_tenant" ON "public"."referral_commissions" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "referral_commissions_insert_own_tenant" ON "public"."referral_commissions" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "referral_commissions_select_own_tenant" ON "public"."referral_commissions" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "referral_commissions_service_role_all" ON "public"."referral_commissions" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "referral_commissions_update_own_tenant" ON "public"."referral_commissions" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."referral_partners" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "referral_partners_delete_own_tenant" ON "public"."referral_partners" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "referral_partners_insert_own_tenant" ON "public"."referral_partners" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "referral_partners_select_own_tenant" ON "public"."referral_partners" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "referral_partners_service_role_all" ON "public"."referral_partners" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "referral_partners_update_own_tenant" ON "public"."referral_partners" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."reimbursements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "reimbursements tenant all" ON "public"."reimbursements" TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."renewal_email_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "renewal_email_log_select" ON "public"."renewal_email_log" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "renewal_email_log_service" ON "public"."renewal_email_log" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."salary_payments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."site_promos" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "site_promos_tenant_read" ON "public"."site_promos" FOR SELECT USING (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))));



CREATE POLICY "site_promos_tenant_write" ON "public"."site_promos" USING (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"())))) WITH CHECK (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))));



ALTER TABLE "public"."statutory_dues_payments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "subs_delete" ON "public"."subscriptions" FOR DELETE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "subs_insert" ON "public"."subscriptions" FOR INSERT TO "authenticated" WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "subs_select" ON "public"."subscriptions" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "subs_update" ON "public"."subscriptions" FOR UPDATE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."subscriptions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "subscriptions_select_own_customer" ON "public"."subscriptions" FOR SELECT USING (("customer_id" = "public"."current_customer_id"()));



ALTER TABLE "public"."support_plans" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "support_plans_select_own_tenant" ON "public"."support_plans" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "support_plans_write_own_tenant" ON "public"."support_plans" TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."support_sync_outbox" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "support_sync_outbox_service_role" ON "public"."support_sync_outbox" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."support_tickets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "support_tickets_delete_own_tenant" ON "public"."support_tickets" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "support_tickets_insert_own_customer" ON "public"."support_tickets" FOR INSERT WITH CHECK (("customer_id" = "public"."current_customer_id"()));



CREATE POLICY "support_tickets_insert_own_tenant" ON "public"."support_tickets" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "support_tickets_select_own_customer" ON "public"."support_tickets" FOR SELECT USING (("customer_id" = "public"."current_customer_id"()));



CREATE POLICY "support_tickets_select_own_tenant" ON "public"."support_tickets" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "support_tickets_update_own_tenant" ON "public"."support_tickets" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."tasks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tasks_delete" ON "public"."tasks" FOR DELETE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tasks_insert" ON "public"."tasks" FOR INSERT TO "authenticated" WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tasks_select" ON "public"."tasks" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tasks_update" ON "public"."tasks" FOR UPDATE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."tds_receivable" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tds_receivable_delete_own_tenant" ON "public"."tds_receivable" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tds_receivable_insert_own_tenant" ON "public"."tds_receivable" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tds_receivable_select_own_tenant" ON "public"."tds_receivable" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tds_receivable_update_own_tenant" ON "public"."tds_receivable" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."team_invites" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "team_invites_owner_manage" ON "public"."team_invites" TO "authenticated" USING ((("tenant_id" = "public"."current_tenant_id"()) AND (EXISTS ( SELECT 1
   FROM "public"."users" "u"
  WHERE (("u"."id" = "auth"."uid"()) AND ("u"."role" = 'owner'::"public"."user_role")))))) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) AND (EXISTS ( SELECT 1
   FROM "public"."users" "u"
  WHERE (("u"."id" = "auth"."uid"()) AND ("u"."role" = 'owner'::"public"."user_role"))))));



CREATE POLICY "tenant delete bank_aa_connections" ON "public"."bank_aa_connections" FOR DELETE USING (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))));



CREATE POLICY "tenant insert bank_aa_connections" ON "public"."bank_aa_connections" FOR INSERT WITH CHECK (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))));



CREATE POLICY "tenant isolation delete" ON "public"."attendance" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation delete" ON "public"."balance_sheet_items" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation delete" ON "public"."bank_accounts" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation delete" ON "public"."bank_transactions" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation delete" ON "public"."business_loan_payments" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation delete" ON "public"."business_loans" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation delete" ON "public"."emi_payments" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation delete" ON "public"."emi_purchases" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation delete" ON "public"."employee_loan_repayments" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation delete" ON "public"."employee_loans" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation delete" ON "public"."employees" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation delete" ON "public"."expense_claims" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation delete" ON "public"."lead_activities" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation delete" ON "public"."leave_entries" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation delete" ON "public"."salary_payments" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation delete" ON "public"."statutory_dues_payments" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation insert" ON "public"."lead_activities" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation read" ON "public"."attendance" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation read" ON "public"."attendance_settings" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation read" ON "public"."balance_sheet_items" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation read" ON "public"."bank_accounts" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation read" ON "public"."bank_transactions" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation read" ON "public"."business_loan_payments" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation read" ON "public"."business_loans" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation read" ON "public"."emi_payments" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation read" ON "public"."emi_purchases" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation read" ON "public"."employee_loan_repayments" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation read" ON "public"."employee_loans" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation read" ON "public"."employees" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation read" ON "public"."expense_claims" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation read" ON "public"."lead_activities" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation read" ON "public"."leave_entries" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation read" ON "public"."salary_payments" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation read" ON "public"."statutory_dues_payments" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation update" ON "public"."attendance" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation update" ON "public"."attendance_settings" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation update" ON "public"."balance_sheet_items" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation update" ON "public"."bank_accounts" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation update" ON "public"."bank_transactions" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation update" ON "public"."business_loan_payments" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation update" ON "public"."business_loans" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation update" ON "public"."emi_payments" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation update" ON "public"."emi_purchases" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation update" ON "public"."employee_loans" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation update" ON "public"."employees" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation update" ON "public"."expense_claims" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation update" ON "public"."leave_entries" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation update" ON "public"."salary_payments" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation update" ON "public"."statutory_dues_payments" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation write" ON "public"."attendance" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation write" ON "public"."attendance_settings" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation write" ON "public"."balance_sheet_items" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation write" ON "public"."bank_accounts" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation write" ON "public"."bank_transactions" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation write" ON "public"."business_loan_payments" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation write" ON "public"."business_loans" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation write" ON "public"."emi_payments" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation write" ON "public"."emi_purchases" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation write" ON "public"."employee_loan_repayments" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation write" ON "public"."employee_loans" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation write" ON "public"."employees" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation write" ON "public"."leave_entries" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation write" ON "public"."salary_payments" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant isolation write" ON "public"."statutory_dues_payments" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant select bank_aa_connections" ON "public"."bank_aa_connections" FOR SELECT USING (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))));



CREATE POLICY "tenant update bank_aa_connections" ON "public"."bank_aa_connections" FOR UPDATE USING (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))));



ALTER TABLE "public"."tenant_domains" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tenant_domains_select" ON "public"."tenant_domains" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "tenant_domains_write" ON "public"."tenant_domains" TO "authenticated" USING ((("tenant_id" = "public"."current_tenant_id"()) AND (EXISTS ( SELECT 1
   FROM "public"."users" "u"
  WHERE (("u"."id" = "auth"."uid"()) AND ("u"."role" = 'owner'::"public"."user_role")))))) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) AND (EXISTS ( SELECT 1
   FROM "public"."users" "u"
  WHERE (("u"."id" = "auth"."uid"()) AND ("u"."role" = 'owner'::"public"."user_role"))))));



ALTER TABLE "public"."tenant_secrets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tenant_secrets_owner_insert" ON "public"."tenant_secrets" FOR INSERT WITH CHECK ((("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))) AND (( SELECT "users"."role"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"())) = 'owner'::"public"."user_role")));



CREATE POLICY "tenant_secrets_owner_read" ON "public"."tenant_secrets" FOR SELECT USING ((("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))) AND (( SELECT "users"."role"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"())) = 'owner'::"public"."user_role")));



CREATE POLICY "tenant_secrets_owner_write" ON "public"."tenant_secrets" FOR UPDATE USING ((("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))) AND (( SELECT "users"."role"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"())) = 'owner'::"public"."user_role"))) WITH CHECK ((("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))) AND (( SELECT "users"."role"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"())) = 'owner'::"public"."user_role")));



ALTER TABLE "public"."tenants" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tenants_select_own_customer" ON "public"."tenants" FOR SELECT USING (("id" = ( SELECT "customer_users"."tenant_id"
   FROM "public"."customer_users"
  WHERE ("customer_users"."auth_user_id" = "auth"."uid"())
 LIMIT 1)));



CREATE POLICY "tenants_self_read" ON "public"."tenants" FOR SELECT TO "authenticated" USING (("id" = "public"."current_tenant_id"()));



CREATE POLICY "tenants_self_update" ON "public"."tenants" FOR UPDATE TO "authenticated" USING ((("id" = "public"."current_tenant_id"()) AND (EXISTS ( SELECT 1
   FROM "public"."users"
  WHERE (("users"."id" = "auth"."uid"()) AND ("users"."role" = 'owner'::"public"."user_role"))))));



CREATE POLICY "tenants_signup_insert" ON "public"."tenants" FOR INSERT TO "authenticated" WITH CHECK (true);



ALTER TABLE "public"."user_google_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "users_self_read" ON "public"."users" FOR SELECT TO "authenticated" USING (("id" = "auth"."uid"()));



CREATE POLICY "users_self_update" ON "public"."users" FOR UPDATE TO "authenticated" USING (("id" = "auth"."uid"()));



CREATE POLICY "users_signup_insert" ON "public"."users" FOR INSERT TO "authenticated" WITH CHECK (("id" = "auth"."uid"()));



CREATE POLICY "users_tenant_delete" ON "public"."users" FOR DELETE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "users_tenant_read" ON "public"."users" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "users_tenant_update" ON "public"."users" FOR UPDATE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."vault_access_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vault_access_log_insert" ON "public"."vault_access_log" FOR INSERT TO "authenticated" WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "vault_access_log_select" ON "public"."vault_access_log" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."vault_passwords" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vault_passwords_delete" ON "public"."vault_passwords" FOR DELETE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "vault_passwords_insert" ON "public"."vault_passwords" FOR INSERT TO "authenticated" WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "vault_passwords_select" ON "public"."vault_passwords" FOR SELECT TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "vault_passwords_update" ON "public"."vault_passwords" FOR UPDATE TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."vendor_bills" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vendor_bills_delete_own_tenant" ON "public"."vendor_bills" FOR DELETE USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "vendor_bills_insert_own_tenant" ON "public"."vendor_bills" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "vendor_bills_select_own_tenant" ON "public"."vendor_bills" FOR SELECT USING (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "vendor_bills_update_own_tenant" ON "public"."vendor_bills" FOR UPDATE USING (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."vendors" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vendors tenant all" ON "public"."vendors" TO "authenticated" USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."whatsapp_messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "whatsapp_messages_tenant_read" ON "public"."whatsapp_messages" FOR SELECT USING (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))));



CREATE POLICY "whatsapp_messages_tenant_write" ON "public"."whatsapp_messages" USING (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"())))) WITH CHECK (("tenant_id" = ( SELECT "users"."tenant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))));



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "public"."accept_project_quote"("p_project_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."accept_project_quote"("p_project_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."accept_project_quote"("p_project_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."accept_quote"("p_quote_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."accept_quote"("p_quote_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."accept_quote"("p_quote_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."add_reimbursement"("p_person" "text", "p_purpose" "text", "p_category" "text", "p_amount" integer, "p_gst" integer, "p_incurred_on" "date", "p_paid_via" "text", "p_employee_id" "uuid", "p_receipt_path" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."add_reimbursement"("p_person" "text", "p_purpose" "text", "p_category" "text", "p_amount" integer, "p_gst" integer, "p_incurred_on" "date", "p_paid_via" "text", "p_employee_id" "uuid", "p_receipt_path" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."add_reimbursement"("p_person" "text", "p_purpose" "text", "p_category" "text", "p_amount" integer, "p_gst" integer, "p_incurred_on" "date", "p_paid_via" "text", "p_employee_id" "uuid", "p_receipt_path" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."approve_expense_claim"("p_claim_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."approve_expense_claim"("p_claim_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."approve_expense_claim"("p_claim_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."assign_customer_number"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."assign_customer_number"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."assign_customer_number"() TO "service_role";



GRANT ALL ON FUNCTION "public"."auto_backup_if_stale"() TO "anon";
GRANT ALL ON FUNCTION "public"."auto_backup_if_stale"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."auto_backup_if_stale"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."backup_all_tenants"("p_label" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."backup_all_tenants"("p_label" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."bank_account_current_balance"("p_account_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."bank_account_current_balance"("p_account_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."bank_account_current_balance"("p_account_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."book_bank_advance"("p_txn_id" "uuid", "p_counterparty" "text", "p_kind" "text", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."book_bank_advance"("p_txn_id" "uuid", "p_counterparty" "text", "p_kind" "text", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."book_bank_advance"("p_txn_id" "uuid", "p_counterparty" "text", "p_kind" "text", "p_notes" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."book_bank_credit"("p_txn_id" "uuid", "p_kind" "text", "p_label" "text", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."book_bank_credit"("p_txn_id" "uuid", "p_kind" "text", "p_label" "text", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."book_bank_credit"("p_txn_id" "uuid", "p_kind" "text", "p_label" "text", "p_notes" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."book_bank_txn_as_expense"("p_txn_id" "uuid", "p_category" "text", "p_vendor" "text", "p_gst" integer, "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."book_bank_txn_as_expense"("p_txn_id" "uuid", "p_category" "text", "p_vendor" "text", "p_gst" integer, "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."book_bank_txn_as_expense"("p_txn_id" "uuid", "p_category" "text", "p_vendor" "text", "p_gst" integer, "p_notes" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."book_bank_txn_as_statutory"("p_txn_id" "uuid", "p_kind" "text", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."book_bank_txn_as_statutory"("p_txn_id" "uuid", "p_kind" "text", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."book_bank_txn_as_statutory"("p_txn_id" "uuid", "p_kind" "text", "p_notes" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."campaign_templates_touch"() TO "anon";
GRANT ALL ON FUNCTION "public"."campaign_templates_touch"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."campaign_templates_touch"() TO "service_role";



GRANT ALL ON FUNCTION "public"."campaigns_touch_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."campaigns_touch_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."campaigns_touch_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."compute_advance_adjustment"("p_quote_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."compute_advance_adjustment"("p_quote_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."compute_advance_adjustment"("p_quote_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."consume_prepaid_advance"("p_advance_id" "uuid", "p_amount" integer, "p_date" "date", "p_note" "text", "p_gst" integer, "p_attachment" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."consume_prepaid_advance"("p_advance_id" "uuid", "p_amount" integer, "p_date" "date", "p_note" "text", "p_gst" integer, "p_attachment" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."consume_prepaid_advance"("p_advance_id" "uuid", "p_amount" integer, "p_date" "date", "p_note" "text", "p_gst" integer, "p_attachment" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."contacts_touch"() TO "anon";
GRANT ALL ON FUNCTION "public"."contacts_touch"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."contacts_touch"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."convert_inbound_email_to_lead"("p_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."convert_inbound_email_to_lead"("p_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."convert_inbound_email_to_lead"("p_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."coupons_touch"() TO "anon";
GRANT ALL ON FUNCTION "public"."coupons_touch"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."coupons_touch"() TO "service_role";



GRANT ALL ON FUNCTION "public"."create_direct_invoice"("p_customer_id" "uuid", "p_line_items" "jsonb", "p_notes" "text", "p_recurring" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."create_direct_invoice"("p_customer_id" "uuid", "p_line_items" "jsonb", "p_notes" "text", "p_recurring" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_direct_invoice"("p_customer_id" "uuid", "p_line_items" "jsonb", "p_notes" "text", "p_recurring" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."create_project_direct_invoice"("p_customer_id" "uuid", "p_customer_name" "text", "p_title" "text", "p_description" "text", "p_line_items" "jsonb", "p_gst_rate" integer, "p_inter_state" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."create_project_direct_invoice"("p_customer_id" "uuid", "p_customer_name" "text", "p_title" "text", "p_description" "text", "p_line_items" "jsonb", "p_gst_rate" integer, "p_inter_state" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_project_direct_invoice"("p_customer_id" "uuid", "p_customer_name" "text", "p_title" "text", "p_description" "text", "p_line_items" "jsonb", "p_gst_rate" integer, "p_inter_state" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_project_quote"("p_customer_id" "uuid", "p_customer_name" "text", "p_title" "text", "p_description" "text", "p_line_items" "jsonb", "p_gst_rate" integer, "p_inter_state" boolean, "p_milestones" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_project_quote"("p_customer_id" "uuid", "p_customer_name" "text", "p_title" "text", "p_description" "text", "p_line_items" "jsonb", "p_gst_rate" integer, "p_inter_state" boolean, "p_milestones" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_project_quote"("p_customer_id" "uuid", "p_customer_name" "text", "p_title" "text", "p_description" "text", "p_line_items" "jsonb", "p_gst_rate" integer, "p_inter_state" boolean, "p_milestones" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_project_sale"("p_customer_id" "uuid", "p_customer_name" "text", "p_title" "text", "p_description" "text", "p_taxable" integer, "p_gst_rate" integer, "p_inter_state" boolean, "p_milestones" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_project_sale"("p_customer_id" "uuid", "p_customer_name" "text", "p_title" "text", "p_description" "text", "p_taxable" integer, "p_gst_rate" integer, "p_inter_state" boolean, "p_milestones" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_project_sale"("p_customer_id" "uuid", "p_customer_name" "text", "p_title" "text", "p_description" "text", "p_taxable" integer, "p_gst_rate" integer, "p_inter_state" boolean, "p_milestones" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_site_promo"("p_tenant_id" "uuid", "p_headline" "text", "p_subheadline" "text", "p_badge_text" "text", "p_discount_type" "text", "p_discount_value" integer, "p_applies_to_tier" "text", "p_min_seats" integer, "p_max_seats" integer, "p_banner_style" "text", "p_valid_until" timestamp with time zone, "p_created_by" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_site_promo"("p_tenant_id" "uuid", "p_headline" "text", "p_subheadline" "text", "p_badge_text" "text", "p_discount_type" "text", "p_discount_value" integer, "p_applies_to_tier" "text", "p_min_seats" integer, "p_max_seats" integer, "p_banner_style" "text", "p_valid_until" timestamp with time zone, "p_created_by" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_site_promo"("p_tenant_id" "uuid", "p_headline" "text", "p_subheadline" "text", "p_badge_text" "text", "p_discount_type" "text", "p_discount_value" integer, "p_applies_to_tier" "text", "p_min_seats" integer, "p_max_seats" integer, "p_banner_style" "text", "p_valid_until" timestamp with time zone, "p_created_by" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."create_tenant_backup"("p_label" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."create_tenant_backup"("p_label" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_tenant_backup"("p_label" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."current_customer_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_customer_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_customer_id"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."current_tenant_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_tenant_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_tenant_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."default_doc_prefix"("p_doc_type" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."default_doc_prefix"("p_doc_type" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."default_doc_prefix"("p_doc_type" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_bank_account"("p_account_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_bank_account"("p_account_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_bank_account"("p_account_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_business_loan"("p_loan_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_business_loan"("p_loan_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_business_loan"("p_loan_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_claim_public"("p_tenant_id" "uuid", "p_employee_id" "uuid", "p_pin" "text", "p_claim_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_claim_public"("p_tenant_id" "uuid", "p_employee_id" "uuid", "p_pin" "text", "p_claim_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_claim_public"("p_tenant_id" "uuid", "p_employee_id" "uuid", "p_pin" "text", "p_claim_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_customer"("p_customer_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_customer"("p_customer_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_customer"("p_customer_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_employee_loan"("p_loan_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_employee_loan"("p_loan_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_employee_loan"("p_loan_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_expense_claim"("p_claim_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_expense_claim"("p_claim_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_expense_claim"("p_claim_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_payment"("p_payment_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_payment"("p_payment_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_payment"("p_payment_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_project_invoice"("p_invoice_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_project_invoice"("p_invoice_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_project_invoice"("p_invoice_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_project_sale"("p_project_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_project_sale"("p_project_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_project_sale"("p_project_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_reimbursement"("p_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_reimbursement"("p_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_reimbursement"("p_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_salary_payment"("p_salary_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_salary_payment"("p_salary_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_salary_payment"("p_salary_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_subscription"("p_subscription_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_subscription"("p_subscription_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_subscription"("p_subscription_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_subscription_invoice"("p_invoice_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_subscription_invoice"("p_invoice_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_subscription_invoice"("p_invoice_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."delete_tenant_backup"("p_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."delete_tenant_backup"("p_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_tenant_backup"("p_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."disburse_employee_loan"("p_employee_name" "text", "p_principal" integer, "p_disbursed_on" "date", "p_bank_account_id" "uuid", "p_kind" "text", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."disburse_employee_loan"("p_employee_name" "text", "p_principal" integer, "p_disbursed_on" "date", "p_bank_account_id" "uuid", "p_kind" "text", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."disburse_employee_loan"("p_employee_name" "text", "p_principal" integer, "p_disbursed_on" "date", "p_bank_account_id" "uuid", "p_kind" "text", "p_notes" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."edit_claim_public"("p_tenant_id" "uuid", "p_employee_id" "uuid", "p_pin" "text", "p_claim_id" "uuid", "p_amount" integer, "p_category" "text", "p_purpose" "text", "p_spent_on" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."edit_claim_public"("p_tenant_id" "uuid", "p_employee_id" "uuid", "p_pin" "text", "p_claim_id" "uuid", "p_amount" integer, "p_category" "text", "p_purpose" "text", "p_spent_on" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."edit_claim_public"("p_tenant_id" "uuid", "p_employee_id" "uuid", "p_pin" "text", "p_claim_id" "uuid", "p_amount" integer, "p_category" "text", "p_purpose" "text", "p_spent_on" "date") TO "service_role";



REVOKE ALL ON FUNCTION "public"."edit_employee_loan"("p_loan_id" "uuid", "p_employee_name" "text", "p_principal" integer, "p_disbursed_on" "date", "p_bank_account_id" "uuid", "p_kind" "text", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."edit_employee_loan"("p_loan_id" "uuid", "p_employee_name" "text", "p_principal" integer, "p_disbursed_on" "date", "p_bank_account_id" "uuid", "p_kind" "text", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."edit_employee_loan"("p_loan_id" "uuid", "p_employee_name" "text", "p_principal" integer, "p_disbursed_on" "date", "p_bank_account_id" "uuid", "p_kind" "text", "p_notes" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."edit_expense_claim"("p_claim_id" "uuid", "p_amount" integer, "p_category" "text", "p_purpose" "text", "p_spent_on" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."edit_expense_claim"("p_claim_id" "uuid", "p_amount" integer, "p_category" "text", "p_purpose" "text", "p_spent_on" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."edit_expense_claim"("p_claim_id" "uuid", "p_amount" integer, "p_category" "text", "p_purpose" "text", "p_spent_on" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_accrue_referral_commission"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_accrue_referral_commission"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_accrue_referral_commission"() TO "service_role";



GRANT ALL ON FUNCTION "public"."format_document_number"("p_prefix" "text", "p_fiscal_year" "text", "p_number" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."format_document_number"("p_prefix" "text", "p_fiscal_year" "text", "p_number" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."format_document_number"("p_prefix" "text", "p_fiscal_year" "text", "p_number" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."generate_invoice"("p_quote_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."generate_invoice"("p_quote_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_invoice"("p_quote_id" "text") TO "service_role";



GRANT ALL ON TABLE "public"."site_promos" TO "anon";
GRANT ALL ON TABLE "public"."site_promos" TO "authenticated";
GRANT ALL ON TABLE "public"."site_promos" TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_active_site_promo"("p_tenant_id" "uuid", "p_tier_id" "text", "p_seats" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_active_site_promo"("p_tenant_id" "uuid", "p_tier_id" "text", "p_seats" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_active_site_promo"("p_tenant_id" "uuid", "p_tier_id" "text", "p_seats" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_my_tenant_with_parent"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_my_tenant_with_parent"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_my_tenant_with_parent"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_partner_catalog"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_partner_catalog"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_partner_catalog"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_partner_metrics"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_partner_metrics"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_partner_metrics"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_tenant_backup"("p_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_tenant_backup"("p_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_tenant_backup"("p_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_quote_status_change"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_quote_status_change"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_quote_status_change"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_task_completion"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_task_completion"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_task_completion"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."indian_fiscal_year"("p_date" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."indian_fiscal_year"("p_date" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."indian_fiscal_year"("p_date" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."issue_credit_note"("p_invoice_id" "text", "p_gross_amount" integer, "p_reason_code" "text", "p_reason" "text", "p_notes" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."issue_credit_note"("p_invoice_id" "text", "p_gross_amount" integer, "p_reason_code" "text", "p_reason" "text", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."issue_credit_note"("p_invoice_id" "text", "p_gross_amount" integer, "p_reason_code" "text", "p_reason" "text", "p_notes" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."issue_debit_note"("p_invoice_id" "text", "p_gross_amount" integer, "p_reason_code" "text", "p_reason" "text", "p_notes" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."issue_debit_note"("p_invoice_id" "text", "p_gross_amount" integer, "p_reason_code" "text", "p_reason" "text", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."issue_debit_note"("p_invoice_id" "text", "p_gross_amount" integer, "p_reason_code" "text", "p_reason" "text", "p_notes" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."leads_autolink_contact"() TO "anon";
GRANT ALL ON FUNCTION "public"."leads_autolink_contact"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."leads_autolink_contact"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."list_stranded_auth_users"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_stranded_auth_users"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_stranded_auth_users"() TO "service_role";



GRANT ALL ON FUNCTION "public"."list_tenant_backups"() TO "anon";
GRANT ALL ON FUNCTION "public"."list_tenant_backups"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_tenant_backups"() TO "service_role";



GRANT ALL ON FUNCTION "public"."log_activity"("p_action" "text", "p_entity" "text", "p_entity_id" "text", "p_label" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."log_activity"("p_action" "text", "p_entity" "text", "p_entity_id" "text", "p_label" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."log_activity"("p_action" "text", "p_entity" "text", "p_entity_id" "text", "p_label" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."log_lead_activity"("p_lead_id" "text", "p_kind" "text", "p_detail" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."log_lead_activity"("p_lead_id" "text", "p_kind" "text", "p_detail" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."log_lead_activity"("p_lead_id" "text", "p_kind" "text", "p_detail" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."log_row_change"() TO "anon";
GRANT ALL ON FUNCTION "public"."log_row_change"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."log_row_change"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."mark_attendance"("p_employee_id" "uuid", "p_pin" "text", "p_ip" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."mark_attendance"("p_employee_id" "uuid", "p_pin" "text", "p_ip" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."mark_attendance"("p_employee_id" "uuid", "p_pin" "text", "p_ip" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."mark_attendance"("p_employee_id" "uuid", "p_pin" "text", "p_ip" "text") TO "anon";



GRANT ALL ON FUNCTION "public"."mark_self_attendance"() TO "anon";
GRANT ALL ON FUNCTION "public"."mark_self_attendance"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."mark_self_attendance"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."merge_leads"("p_primary_id" "text", "p_duplicate_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."merge_leads"("p_primary_id" "text", "p_duplicate_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."merge_leads"("p_primary_id" "text", "p_duplicate_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."merge_stranded_user_into_tenant"("p_email" "text", "p_tenant_id" "uuid", "p_role" "public"."user_role") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."merge_stranded_user_into_tenant"("p_email" "text", "p_tenant_id" "uuid", "p_role" "public"."user_role") TO "authenticated";
GRANT ALL ON FUNCTION "public"."merge_stranded_user_into_tenant"("p_email" "text", "p_tenant_id" "uuid", "p_role" "public"."user_role") TO "service_role";



GRANT ALL ON FUNCTION "public"."my_attendance_history"("p_days" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."my_attendance_history"("p_days" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."my_attendance_history"("p_days" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."my_attendance_today"() TO "anon";
GRANT ALL ON FUNCTION "public"."my_attendance_today"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."my_attendance_today"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."next_customer_number"("p_tenant" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."next_customer_number"("p_tenant" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."next_customer_number"("p_tenant" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."next_document_number"("p_doc_type" "text", "p_tenant_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."next_document_number"("p_doc_type" "text", "p_tenant_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."next_document_number"("p_doc_type" "text", "p_tenant_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."pay_referral_commission"("p_commission_id" "uuid", "p_bank_account_id" "uuid", "p_paid_on" "date", "p_method" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."pay_referral_commission"("p_commission_id" "uuid", "p_bank_account_id" "uuid", "p_paid_on" "date", "p_method" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pay_referral_commission"("p_commission_id" "uuid", "p_bank_account_id" "uuid", "p_paid_on" "date", "p_method" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."pay_salary"("p_employee_id" "uuid", "p_period" "text", "p_pay_date" "date", "p_gross" integer, "p_lop_days" numeric, "p_lop_amount" integer, "p_advance_recovered" integer, "p_advance_loan_id" "uuid", "p_tds" integer, "p_pf" integer, "p_esi" integer, "p_other" integer, "p_bank_account_id" "uuid", "p_notes" "text", "p_incentive" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."pay_salary"("p_employee_id" "uuid", "p_period" "text", "p_pay_date" "date", "p_gross" integer, "p_lop_days" numeric, "p_lop_amount" integer, "p_advance_recovered" integer, "p_advance_loan_id" "uuid", "p_tds" integer, "p_pf" integer, "p_esi" integer, "p_other" integer, "p_bank_account_id" "uuid", "p_notes" "text", "p_incentive" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."pay_salary"("p_employee_id" "uuid", "p_period" "text", "p_pay_date" "date", "p_gross" integer, "p_lop_days" numeric, "p_lop_amount" integer, "p_advance_recovered" integer, "p_advance_loan_id" "uuid", "p_tds" integer, "p_pf" integer, "p_esi" integer, "p_other" integer, "p_bank_account_id" "uuid", "p_notes" "text", "p_incentive" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."pay_salary"("p_employee_id" "uuid", "p_period" "text", "p_pay_date" "date", "p_gross" integer, "p_lop_days" numeric, "p_lop_amount" integer, "p_advance_recovered" integer, "p_advance_loan_id" "uuid", "p_tds" integer, "p_pf" integer, "p_esi" integer, "p_other" integer, "p_bank_account_id" "uuid", "p_notes" "text", "p_incentive" integer, "p_esi_employer" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."pay_salary"("p_employee_id" "uuid", "p_period" "text", "p_pay_date" "date", "p_gross" integer, "p_lop_days" numeric, "p_lop_amount" integer, "p_advance_recovered" integer, "p_advance_loan_id" "uuid", "p_tds" integer, "p_pf" integer, "p_esi" integer, "p_other" integer, "p_bank_account_id" "uuid", "p_notes" "text", "p_incentive" integer, "p_esi_employer" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."pay_salary"("p_employee_id" "uuid", "p_period" "text", "p_pay_date" "date", "p_gross" integer, "p_lop_days" numeric, "p_lop_amount" integer, "p_advance_recovered" integer, "p_advance_loan_id" "uuid", "p_tds" integer, "p_pf" integer, "p_esi" integer, "p_other" integer, "p_bank_account_id" "uuid", "p_notes" "text", "p_incentive" integer, "p_esi_employer" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."pay_salary"("p_employee_id" "uuid", "p_period" "text", "p_pay_date" "date", "p_gross" integer, "p_lop_days" numeric, "p_lop_amount" integer, "p_advance_recovered" integer, "p_advance_loan_id" "uuid", "p_tds" integer, "p_pf" integer, "p_esi" integer, "p_other" integer, "p_bank_account_id" "uuid", "p_notes" "text", "p_incentive" integer, "p_esi_employer" integer, "p_pf_employer" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."pay_salary"("p_employee_id" "uuid", "p_period" "text", "p_pay_date" "date", "p_gross" integer, "p_lop_days" numeric, "p_lop_amount" integer, "p_advance_recovered" integer, "p_advance_loan_id" "uuid", "p_tds" integer, "p_pf" integer, "p_esi" integer, "p_other" integer, "p_bank_account_id" "uuid", "p_notes" "text", "p_incentive" integer, "p_esi_employer" integer, "p_pf_employer" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."pay_salary"("p_employee_id" "uuid", "p_period" "text", "p_pay_date" "date", "p_gross" integer, "p_lop_days" numeric, "p_lop_amount" integer, "p_advance_recovered" integer, "p_advance_loan_id" "uuid", "p_tds" integer, "p_pf" integer, "p_esi" integer, "p_other" integer, "p_bank_account_id" "uuid", "p_notes" "text", "p_incentive" integer, "p_esi_employer" integer, "p_pf_employer" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."pay_statutory_dues"("p_amount" integer, "p_kind" "text", "p_paid_on" "date", "p_bank_account_id" "uuid", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."pay_statutory_dues"("p_amount" integer, "p_kind" "text", "p_paid_on" "date", "p_bank_account_id" "uuid", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pay_statutory_dues"("p_amount" integer, "p_kind" "text", "p_paid_on" "date", "p_bank_account_id" "uuid", "p_notes" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."pay_vendor_bill"("p_bill_id" "text", "p_amount" integer, "p_paid_on" "date", "p_bank_account_id" "uuid", "p_method" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."pay_vendor_bill"("p_bill_id" "text", "p_amount" integer, "p_paid_on" "date", "p_bank_account_id" "uuid", "p_method" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pay_vendor_bill"("p_bill_id" "text", "p_amount" integer, "p_paid_on" "date", "p_bank_account_id" "uuid", "p_method" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."plan_key"("p_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."plan_key"("p_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."plan_key"("p_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."portal_customer_exists"("p_email" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."portal_customer_exists"("p_email" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."portal_customer_exists"("p_email" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."portal_customer_exists"("p_email" "text") TO "anon";



REVOKE ALL ON FUNCTION "public"."portal_ensure_customer_link"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."portal_ensure_customer_link"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."portal_ensure_customer_link"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."portal_list_products"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."portal_list_products"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."portal_list_products"() TO "service_role";
GRANT ALL ON FUNCTION "public"."portal_list_products"() TO "anon";



REVOKE ALL ON FUNCTION "public"."portal_request_quote"("p_item_id" "text", "p_seats" integer, "p_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."portal_request_quote"("p_item_id" "text", "p_seats" integer, "p_note" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."portal_request_quote"("p_item_id" "text", "p_seats" integer, "p_note" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."portal_request_quote"("p_item_id" "text", "p_seats" integer, "p_note" "text") TO "anon";



REVOKE ALL ON FUNCTION "public"."portal_touch_login"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."portal_touch_login"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."portal_touch_login"() TO "service_role";



GRANT ALL ON FUNCTION "public"."purchase_orders_touch_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."purchase_orders_touch_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."purchase_orders_touch_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."queue_support_sync"() TO "anon";
GRANT ALL ON FUNCTION "public"."queue_support_sync"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."queue_support_sync"() TO "service_role";



GRANT ALL ON FUNCTION "public"."queue_support_sync_on_customer_status"() TO "anon";
GRANT ALL ON FUNCTION "public"."queue_support_sync_on_customer_status"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."queue_support_sync_on_customer_status"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."raise_project_milestone_invoice"("p_milestone_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."raise_project_milestone_invoice"("p_milestone_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."raise_project_milestone_invoice"("p_milestone_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."reconcile_expenses_to_bank_txn"("p_bank_txn_id" "uuid", "p_expense_ids" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reconcile_expenses_to_bank_txn"("p_bank_txn_id" "uuid", "p_expense_ids" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."reconcile_expenses_to_bank_txn"("p_bank_txn_id" "uuid", "p_expense_ids" "text"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."reconcile_salaries_to_bank_txn"("p_bank_txn_id" "uuid", "p_salary_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reconcile_salaries_to_bank_txn"("p_bank_txn_id" "uuid", "p_salary_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."reconcile_salaries_to_bank_txn"("p_bank_txn_id" "uuid", "p_salary_ids" "uuid"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."reconcile_salary_advance_split"("p_txn_id" "uuid", "p_salary_id" "uuid", "p_advance_amount" integer, "p_employee_name" "text", "p_notes" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."reconcile_salary_advance_split"("p_txn_id" "uuid", "p_salary_id" "uuid", "p_advance_amount" integer, "p_employee_name" "text", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reconcile_salary_advance_split"("p_txn_id" "uuid", "p_salary_id" "uuid", "p_advance_amount" integer, "p_employee_name" "text", "p_notes" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_account_transfer"("p_from_account" "uuid", "p_to_account" "uuid", "p_amount" integer, "p_txn_date" "date", "p_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_account_transfer"("p_from_account" "uuid", "p_to_account" "uuid", "p_amount" integer, "p_txn_date" "date", "p_note" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_account_transfer"("p_from_account" "uuid", "p_to_account" "uuid", "p_amount" integer, "p_txn_date" "date", "p_note" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."record_attendance_consent"() TO "anon";
GRANT ALL ON FUNCTION "public"."record_attendance_consent"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_attendance_consent"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_business_loan"("p_lender" "text", "p_purpose" "text", "p_principal" integer, "p_interest_rate" numeric, "p_tenure_months" integer, "p_emi_amount" integer, "p_disbursed_on" "date", "p_deposit_account" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_business_loan"("p_lender" "text", "p_purpose" "text", "p_principal" integer, "p_interest_rate" numeric, "p_tenure_months" integer, "p_emi_amount" integer, "p_disbursed_on" "date", "p_deposit_account" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_business_loan"("p_lender" "text", "p_purpose" "text", "p_principal" integer, "p_interest_rate" numeric, "p_tenure_months" integer, "p_emi_amount" integer, "p_disbursed_on" "date", "p_deposit_account" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_emi_payment"("p_purchase_id" "uuid", "p_amount" integer, "p_interest" integer, "p_paid_on" "date", "p_bank_account_id" "uuid", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_emi_payment"("p_purchase_id" "uuid", "p_amount" integer, "p_interest" integer, "p_paid_on" "date", "p_bank_account_id" "uuid", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_emi_payment"("p_purchase_id" "uuid", "p_amount" integer, "p_interest" integer, "p_paid_on" "date", "p_bank_account_id" "uuid", "p_notes" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_emi_purchase"("p_name" "text", "p_category" "text", "p_total_cost" integer, "p_down_payment" integer, "p_emi_count" integer, "p_emi_amount" integer, "p_purchased_on" "date", "p_down_account" "uuid", "p_lender" "text", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_emi_purchase"("p_name" "text", "p_category" "text", "p_total_cost" integer, "p_down_payment" integer, "p_emi_count" integer, "p_emi_amount" integer, "p_purchased_on" "date", "p_down_account" "uuid", "p_lender" "text", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_emi_purchase"("p_name" "text", "p_category" "text", "p_total_cost" integer, "p_down_payment" integer, "p_emi_count" integer, "p_emi_amount" integer, "p_purchased_on" "date", "p_down_account" "uuid", "p_lender" "text", "p_notes" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_employee_loan_repayment"("p_loan_id" "uuid", "p_amount" integer, "p_repaid_on" "date", "p_method" "text", "p_bank_account_id" "uuid", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_employee_loan_repayment"("p_loan_id" "uuid", "p_amount" integer, "p_repaid_on" "date", "p_method" "text", "p_bank_account_id" "uuid", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_employee_loan_repayment"("p_loan_id" "uuid", "p_amount" integer, "p_repaid_on" "date", "p_method" "text", "p_bank_account_id" "uuid", "p_notes" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_loan_emi"("p_loan_id" "uuid", "p_amount" integer, "p_interest" integer, "p_paid_on" "date", "p_bank_account_id" "uuid", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_loan_emi"("p_loan_id" "uuid", "p_amount" integer, "p_interest" integer, "p_paid_on" "date", "p_bank_account_id" "uuid", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_loan_emi"("p_loan_id" "uuid", "p_amount" integer, "p_interest" integer, "p_paid_on" "date", "p_bank_account_id" "uuid", "p_notes" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_payment"("p_quote_id" "text", "p_amount" integer, "p_method" "text", "p_reference" "text", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_payment"("p_quote_id" "text", "p_amount" integer, "p_method" "text", "p_reference" "text", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_payment"("p_quote_id" "text", "p_amount" integer, "p_method" "text", "p_reference" "text", "p_notes" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."record_payment_with_tds"("p_quote_id" "text", "p_amount" integer, "p_method" "text", "p_reference" "text", "p_notes" "text", "p_tds_amount" integer, "p_tds_gross" integer, "p_tds_net_paid" integer, "p_tds_section" "text", "p_tds_rate_pct" numeric, "p_customer_tan" "text", "p_invoice_id" "text", "p_fiscal_year" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."record_payment_with_tds"("p_quote_id" "text", "p_amount" integer, "p_method" "text", "p_reference" "text", "p_notes" "text", "p_tds_amount" integer, "p_tds_gross" integer, "p_tds_net_paid" integer, "p_tds_section" "text", "p_tds_rate_pct" numeric, "p_customer_tan" "text", "p_invoice_id" "text", "p_fiscal_year" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_payment_with_tds"("p_quote_id" "text", "p_amount" integer, "p_method" "text", "p_reference" "text", "p_notes" "text", "p_tds_amount" integer, "p_tds_gross" integer, "p_tds_net_paid" integer, "p_tds_section" "text", "p_tds_rate_pct" numeric, "p_customer_tan" "text", "p_invoice_id" "text", "p_fiscal_year" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_project_payment"("p_milestone_id" "uuid", "p_amount" integer, "p_method" "text", "p_reference" "text", "p_received_at" "date", "p_bank_txn_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_project_payment"("p_milestone_id" "uuid", "p_amount" integer, "p_method" "text", "p_reference" "text", "p_received_at" "date", "p_bank_txn_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_project_payment"("p_milestone_id" "uuid", "p_amount" integer, "p_method" "text", "p_reference" "text", "p_received_at" "date", "p_bank_txn_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."redeem_coupon"("p_code" "text", "p_tenant_id" "uuid", "p_tier_id" "text", "p_seats" integer, "p_gross_amount" integer, "p_quote_id" "text", "p_lead_id" "text", "p_email" "text", "p_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."redeem_coupon"("p_code" "text", "p_tenant_id" "uuid", "p_tier_id" "text", "p_seats" integer, "p_gross_amount" integer, "p_quote_id" "text", "p_lead_id" "text", "p_email" "text", "p_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."redeem_coupon"("p_code" "text", "p_tenant_id" "uuid", "p_tier_id" "text", "p_seats" integer, "p_gross_amount" integer, "p_quote_id" "text", "p_lead_id" "text", "p_email" "text", "p_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."redeem_customer_credits"("p_customer_id" "uuid", "p_amount" integer, "p_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."redeem_customer_credits"("p_customer_id" "uuid", "p_amount" integer, "p_note" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."redeem_customer_credits"("p_customer_id" "uuid", "p_amount" integer, "p_note" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."reject_expense_claim"("p_claim_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reject_expense_claim"("p_claim_id" "uuid", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reject_expense_claim"("p_claim_id" "uuid", "p_reason" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."reopen_quote"("p_quote_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."reopen_quote"("p_quote_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reopen_quote"("p_quote_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."reset_tenant_selected_tables"("p_tables" "text"[], "p_label" "text", "p_confirm_statutory" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reset_tenant_selected_tables"("p_tables" "text"[], "p_label" "text", "p_confirm_statutory" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."reset_tenant_selected_tables"("p_tables" "text"[], "p_label" "text", "p_confirm_statutory" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."reset_tenant_selected_tables"("p_tables" "text"[], "p_label" "text", "p_confirm_statutory" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."resolve_or_create_contact"("p_tenant" "uuid", "p_email" "text", "p_phone" "text", "p_name" "text", "p_company" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."resolve_or_create_contact"("p_tenant" "uuid", "p_email" "text", "p_phone" "text", "p_name" "text", "p_company" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_or_create_contact"("p_tenant" "uuid", "p_email" "text", "p_phone" "text", "p_name" "text", "p_company" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_or_create_contact"("p_tenant" "uuid", "p_email" "text", "p_phone" "text", "p_name" "text", "p_company" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."restore_tenant_backup"("p_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."restore_tenant_backup"("p_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."restore_tenant_backup"("p_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_document_series_start"("p_doc_type" "text", "p_fiscal_year" "text", "p_start_number" integer, "p_prefix" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_document_series_start"("p_doc_type" "text", "p_fiscal_year" "text", "p_start_number" integer, "p_prefix" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_document_series_start"("p_doc_type" "text", "p_fiscal_year" "text", "p_start_number" integer, "p_prefix" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_employee_pin"("p_employee_id" "uuid", "p_pin" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_employee_pin"("p_employee_id" "uuid", "p_pin" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_employee_pin"("p_employee_id" "uuid", "p_pin" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_my_employee"("p_employee_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."set_my_employee"("p_employee_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_my_employee"("p_employee_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_subscription_auto_renew"("p_sub_id" "uuid", "p_value" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_subscription_auto_renew"("p_sub_id" "uuid", "p_value" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."set_subscription_auto_renew"("p_sub_id" "uuid", "p_value" boolean) TO "authenticated";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."settle_expense_advance"("p_loan_id" "uuid", "p_spent_amount" integer, "p_category" "text", "p_return_amount" integer, "p_return_account" "uuid", "p_date" "date", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."settle_expense_advance"("p_loan_id" "uuid", "p_spent_amount" integer, "p_category" "text", "p_return_amount" integer, "p_return_account" "uuid", "p_date" "date", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."settle_expense_advance"("p_loan_id" "uuid", "p_spent_amount" integer, "p_category" "text", "p_return_amount" integer, "p_return_account" "uuid", "p_date" "date", "p_notes" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."settle_reimbursement"("p_id" "uuid", "p_settled_on" "date", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."settle_reimbursement"("p_id" "uuid", "p_settled_on" "date", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."settle_reimbursement"("p_id" "uuid", "p_settled_on" "date", "p_notes" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."site_promos_touch_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."site_promos_touch_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."site_promos_touch_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."submit_expense_claim"("p_tenant_id" "uuid", "p_employee_id" "uuid", "p_pin" "text", "p_amount" integer, "p_category" "text", "p_purpose" "text", "p_spent_on" "date", "p_receipt_path" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_expense_claim"("p_tenant_id" "uuid", "p_employee_id" "uuid", "p_pin" "text", "p_amount" integer, "p_category" "text", "p_purpose" "text", "p_spent_on" "date", "p_receipt_path" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."submit_expense_claim"("p_tenant_id" "uuid", "p_employee_id" "uuid", "p_pin" "text", "p_amount" integer, "p_category" "text", "p_purpose" "text", "p_spent_on" "date", "p_receipt_path" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."subscriptions_resolve_item"() TO "anon";
GRANT ALL ON FUNCTION "public"."subscriptions_resolve_item"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."subscriptions_resolve_item"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."suggest_bank_transaction_matches"("p_bank_txn_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."suggest_bank_transaction_matches"("p_bank_txn_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."suggest_bank_transaction_matches"("p_bank_txn_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."sync_partner_item"("p_partner_item_id" "text", "p_my_msrp" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_partner_item"("p_partner_item_id" "text", "p_my_msrp" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_partner_item"("p_partner_item_id" "text", "p_my_msrp" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."sync_partner_item"("p_partner_item_id" "text", "p_my_msrp" integer, "p_link_existing_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_partner_item"("p_partner_item_id" "text", "p_my_msrp" integer, "p_link_existing_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_partner_item"("p_partner_item_id" "text", "p_my_msrp" integer, "p_link_existing_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_project_invoice_paid"() TO "anon";
GRANT ALL ON FUNCTION "public"."sync_project_invoice_paid"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_project_invoice_paid"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."sync_salary_paid_status"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_salary_paid_status"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_salary_paid_status"() TO "service_role";



GRANT ALL ON FUNCTION "public"."tenant_secrets_touch_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."tenant_secrets_touch_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."tenant_secrets_touch_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."tg_expense_delete_guards_salary"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."tg_expense_delete_guards_salary"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."tg_expense_delete_guards_salary"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."tg_mirror_invoice_to_child_vendor_bill"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."tg_mirror_invoice_to_child_vendor_bill"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."tg_mirror_invoice_to_child_vendor_bill"() TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_customer_groups_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_customer_groups_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_customer_groups_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."undo_my_last_punch"() TO "anon";
GRANT ALL ON FUNCTION "public"."undo_my_last_punch"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."undo_my_last_punch"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."update_project_future_milestones"("p_project_id" "uuid", "p_milestones" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_project_future_milestones"("p_project_id" "uuid", "p_milestones" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_project_future_milestones"("p_project_id" "uuid", "p_milestones" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."update_project_quote"("p_project_id" "uuid", "p_customer_name" "text", "p_title" "text", "p_description" "text", "p_line_items" "jsonb", "p_gst_rate" integer, "p_inter_state" boolean, "p_milestones" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_project_quote"("p_project_id" "uuid", "p_customer_name" "text", "p_title" "text", "p_description" "text", "p_line_items" "jsonb", "p_gst_rate" integer, "p_inter_state" boolean, "p_milestones" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_project_quote"("p_project_id" "uuid", "p_customer_name" "text", "p_title" "text", "p_description" "text", "p_line_items" "jsonb", "p_gst_rate" integer, "p_inter_state" boolean, "p_milestones" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."verify_claim_access"("p_tenant_id" "uuid", "p_employee_id" "uuid", "p_pin" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."verify_claim_access"("p_tenant_id" "uuid", "p_employee_id" "uuid", "p_pin" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."verify_claim_access"("p_tenant_id" "uuid", "p_employee_id" "uuid", "p_pin" "text") TO "service_role";



GRANT ALL ON TABLE "public"."access_credentials" TO "anon";
GRANT ALL ON TABLE "public"."access_credentials" TO "authenticated";
GRANT ALL ON TABLE "public"."access_credentials" TO "service_role";



GRANT ALL ON TABLE "public"."activity_log" TO "anon";
GRANT ALL ON TABLE "public"."activity_log" TO "authenticated";
GRANT ALL ON TABLE "public"."activity_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."activity_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."activity_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."activity_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."api_keys" TO "anon";
GRANT ALL ON TABLE "public"."api_keys" TO "authenticated";
GRANT ALL ON TABLE "public"."api_keys" TO "service_role";



GRANT ALL ON TABLE "public"."assessment_attempts" TO "anon";
GRANT ALL ON TABLE "public"."assessment_attempts" TO "authenticated";
GRANT ALL ON TABLE "public"."assessment_attempts" TO "service_role";



GRANT ALL ON TABLE "public"."assessments" TO "anon";
GRANT ALL ON TABLE "public"."assessments" TO "authenticated";
GRANT ALL ON TABLE "public"."assessments" TO "service_role";



GRANT ALL ON TABLE "public"."attendance" TO "anon";
GRANT ALL ON TABLE "public"."attendance" TO "authenticated";
GRANT ALL ON TABLE "public"."attendance" TO "service_role";



GRANT ALL ON TABLE "public"."attendance_settings" TO "anon";
GRANT ALL ON TABLE "public"."attendance_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."attendance_settings" TO "service_role";



GRANT ALL ON TABLE "public"."balance_sheet_items" TO "anon";
GRANT ALL ON TABLE "public"."balance_sheet_items" TO "authenticated";
GRANT ALL ON TABLE "public"."balance_sheet_items" TO "service_role";



GRANT ALL ON TABLE "public"."bank_aa_connections" TO "anon";
GRANT ALL ON TABLE "public"."bank_aa_connections" TO "authenticated";
GRANT ALL ON TABLE "public"."bank_aa_connections" TO "service_role";



GRANT ALL ON TABLE "public"."bank_accounts" TO "anon";
GRANT ALL ON TABLE "public"."bank_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."bank_accounts" TO "service_role";



GRANT ALL ON TABLE "public"."bank_transactions" TO "anon";
GRANT ALL ON TABLE "public"."bank_transactions" TO "authenticated";
GRANT ALL ON TABLE "public"."bank_transactions" TO "service_role";



GRANT ALL ON TABLE "public"."business_loan_payments" TO "anon";
GRANT ALL ON TABLE "public"."business_loan_payments" TO "authenticated";
GRANT ALL ON TABLE "public"."business_loan_payments" TO "service_role";



GRANT ALL ON TABLE "public"."business_loans" TO "anon";
GRANT ALL ON TABLE "public"."business_loans" TO "authenticated";
GRANT ALL ON TABLE "public"."business_loans" TO "service_role";



GRANT ALL ON TABLE "public"."campaign_sends" TO "anon";
GRANT ALL ON TABLE "public"."campaign_sends" TO "authenticated";
GRANT ALL ON TABLE "public"."campaign_sends" TO "service_role";



GRANT ALL ON TABLE "public"."campaign_templates" TO "anon";
GRANT ALL ON TABLE "public"."campaign_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."campaign_templates" TO "service_role";



GRANT ALL ON TABLE "public"."campaigns" TO "anon";
GRANT ALL ON TABLE "public"."campaigns" TO "authenticated";
GRANT ALL ON TABLE "public"."campaigns" TO "service_role";



GRANT ALL ON TABLE "public"."compliance_log" TO "anon";
GRANT ALL ON TABLE "public"."compliance_log" TO "authenticated";
GRANT ALL ON TABLE "public"."compliance_log" TO "service_role";



GRANT ALL ON TABLE "public"."compliance_reminder_log" TO "anon";
GRANT ALL ON TABLE "public"."compliance_reminder_log" TO "authenticated";
GRANT ALL ON TABLE "public"."compliance_reminder_log" TO "service_role";



GRANT ALL ON TABLE "public"."contact_greeting_log" TO "anon";
GRANT ALL ON TABLE "public"."contact_greeting_log" TO "authenticated";
GRANT ALL ON TABLE "public"."contact_greeting_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."contact_greeting_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."contact_greeting_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."contact_greeting_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."contacts" TO "anon";
GRANT ALL ON TABLE "public"."contacts" TO "authenticated";
GRANT ALL ON TABLE "public"."contacts" TO "service_role";



GRANT ALL ON TABLE "public"."coupon_redemptions" TO "anon";
GRANT ALL ON TABLE "public"."coupon_redemptions" TO "authenticated";
GRANT ALL ON TABLE "public"."coupon_redemptions" TO "service_role";



GRANT ALL ON TABLE "public"."coupons" TO "anon";
GRANT ALL ON TABLE "public"."coupons" TO "authenticated";
GRANT ALL ON TABLE "public"."coupons" TO "service_role";



GRANT ALL ON TABLE "public"."credit_notes" TO "anon";
GRANT ALL ON TABLE "public"."credit_notes" TO "authenticated";
GRANT ALL ON TABLE "public"."credit_notes" TO "service_role";



GRANT ALL ON TABLE "public"."customer_credits" TO "anon";
GRANT ALL ON TABLE "public"."customer_credits" TO "authenticated";
GRANT ALL ON TABLE "public"."customer_credits" TO "service_role";



GRANT ALL ON TABLE "public"."customer_domains" TO "anon";
GRANT ALL ON TABLE "public"."customer_domains" TO "authenticated";
GRANT ALL ON TABLE "public"."customer_domains" TO "service_role";



GRANT ALL ON TABLE "public"."customer_groups" TO "anon";
GRANT ALL ON TABLE "public"."customer_groups" TO "authenticated";
GRANT ALL ON TABLE "public"."customer_groups" TO "service_role";



GRANT ALL ON TABLE "public"."customer_number_seq" TO "anon";
GRANT ALL ON TABLE "public"."customer_number_seq" TO "authenticated";
GRANT ALL ON TABLE "public"."customer_number_seq" TO "service_role";



GRANT ALL ON TABLE "public"."customer_users" TO "anon";
GRANT ALL ON TABLE "public"."customer_users" TO "authenticated";
GRANT ALL ON TABLE "public"."customer_users" TO "service_role";



GRANT ALL ON TABLE "public"."customers" TO "anon";
GRANT ALL ON TABLE "public"."customers" TO "authenticated";
GRANT ALL ON TABLE "public"."customers" TO "service_role";



GRANT ALL ON TABLE "public"."debit_notes" TO "anon";
GRANT ALL ON TABLE "public"."debit_notes" TO "authenticated";
GRANT ALL ON TABLE "public"."debit_notes" TO "service_role";



GRANT ALL ON TABLE "public"."document_series" TO "anon";
GRANT ALL ON TABLE "public"."document_series" TO "authenticated";
GRANT ALL ON TABLE "public"."document_series" TO "service_role";



GRANT ALL ON TABLE "public"."documents" TO "anon";
GRANT ALL ON TABLE "public"."documents" TO "authenticated";
GRANT ALL ON TABLE "public"."documents" TO "service_role";



GRANT ALL ON TABLE "public"."email_log" TO "anon";
GRANT ALL ON TABLE "public"."email_log" TO "authenticated";
GRANT ALL ON TABLE "public"."email_log" TO "service_role";



GRANT ALL ON TABLE "public"."emi_payments" TO "anon";
GRANT ALL ON TABLE "public"."emi_payments" TO "authenticated";
GRANT ALL ON TABLE "public"."emi_payments" TO "service_role";



GRANT ALL ON TABLE "public"."emi_purchases" TO "anon";
GRANT ALL ON TABLE "public"."emi_purchases" TO "authenticated";
GRANT ALL ON TABLE "public"."emi_purchases" TO "service_role";



GRANT ALL ON TABLE "public"."employee_documents" TO "anon";
GRANT ALL ON TABLE "public"."employee_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."employee_documents" TO "service_role";



GRANT ALL ON TABLE "public"."employee_loan_repayments" TO "anon";
GRANT ALL ON TABLE "public"."employee_loan_repayments" TO "authenticated";
GRANT ALL ON TABLE "public"."employee_loan_repayments" TO "service_role";



GRANT ALL ON TABLE "public"."employee_loans" TO "anon";
GRANT ALL ON TABLE "public"."employee_loans" TO "authenticated";
GRANT ALL ON TABLE "public"."employee_loans" TO "service_role";



GRANT ALL ON TABLE "public"."employees" TO "anon";
GRANT ALL ON TABLE "public"."employees" TO "authenticated";
GRANT ALL ON TABLE "public"."employees" TO "service_role";



GRANT ALL ON TABLE "public"."expense_claims" TO "anon";
GRANT ALL ON TABLE "public"."expense_claims" TO "authenticated";
GRANT ALL ON TABLE "public"."expense_claims" TO "service_role";



GRANT ALL ON TABLE "public"."expenses" TO "anon";
GRANT ALL ON TABLE "public"."expenses" TO "authenticated";
GRANT ALL ON TABLE "public"."expenses" TO "service_role";



GRANT ALL ON TABLE "public"."google_contact_links" TO "anon";
GRANT ALL ON TABLE "public"."google_contact_links" TO "authenticated";
GRANT ALL ON TABLE "public"."google_contact_links" TO "service_role";



GRANT ALL ON TABLE "public"."holidays" TO "anon";
GRANT ALL ON TABLE "public"."holidays" TO "authenticated";
GRANT ALL ON TABLE "public"."holidays" TO "service_role";



GRANT ALL ON TABLE "public"."inbound_emails" TO "anon";
GRANT ALL ON TABLE "public"."inbound_emails" TO "authenticated";
GRANT ALL ON TABLE "public"."inbound_emails" TO "service_role";



GRANT ALL ON TABLE "public"."inbound_purchases" TO "anon";
GRANT ALL ON TABLE "public"."inbound_purchases" TO "authenticated";
GRANT ALL ON TABLE "public"."inbound_purchases" TO "service_role";



GRANT ALL ON SEQUENCE "public"."inbound_purchases_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."inbound_purchases_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."inbound_purchases_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."invoices" TO "anon";
GRANT ALL ON TABLE "public"."invoices" TO "authenticated";
GRANT ALL ON TABLE "public"."invoices" TO "service_role";



GRANT ALL ON TABLE "public"."items" TO "anon";
GRANT ALL ON TABLE "public"."items" TO "authenticated";
GRANT ALL ON TABLE "public"."items" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."join_requests" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."join_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."join_requests" TO "service_role";



GRANT ALL ON TABLE "public"."lead_activities" TO "anon";
GRANT ALL ON TABLE "public"."lead_activities" TO "authenticated";
GRANT ALL ON TABLE "public"."lead_activities" TO "service_role";



GRANT ALL ON TABLE "public"."leads" TO "anon";
GRANT ALL ON TABLE "public"."leads" TO "authenticated";
GRANT ALL ON TABLE "public"."leads" TO "service_role";



GRANT ALL ON TABLE "public"."leave_entries" TO "anon";
GRANT ALL ON TABLE "public"."leave_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."leave_entries" TO "service_role";



GRANT ALL ON TABLE "public"."payments" TO "anon";
GRANT ALL ON TABLE "public"."payments" TO "authenticated";
GRANT ALL ON TABLE "public"."payments" TO "service_role";



GRANT ALL ON TABLE "public"."po_bill_allocations" TO "anon";
GRANT ALL ON TABLE "public"."po_bill_allocations" TO "authenticated";
GRANT ALL ON TABLE "public"."po_bill_allocations" TO "service_role";



GRANT ALL ON TABLE "public"."prepaid_advances" TO "anon";
GRANT ALL ON TABLE "public"."prepaid_advances" TO "authenticated";
GRANT ALL ON TABLE "public"."prepaid_advances" TO "service_role";



GRANT ALL ON TABLE "public"."project_labour" TO "anon";
GRANT ALL ON TABLE "public"."project_labour" TO "authenticated";
GRANT ALL ON TABLE "public"."project_labour" TO "service_role";



GRANT ALL ON TABLE "public"."project_milestones" TO "anon";
GRANT ALL ON TABLE "public"."project_milestones" TO "authenticated";
GRANT ALL ON TABLE "public"."project_milestones" TO "service_role";



GRANT ALL ON TABLE "public"."project_payments" TO "anon";
GRANT ALL ON TABLE "public"."project_payments" TO "authenticated";
GRANT ALL ON TABLE "public"."project_payments" TO "service_role";



GRANT ALL ON TABLE "public"."project_sales" TO "anon";
GRANT ALL ON TABLE "public"."project_sales" TO "authenticated";
GRANT ALL ON TABLE "public"."project_sales" TO "service_role";



GRANT ALL ON TABLE "public"."project_tasks" TO "anon";
GRANT ALL ON TABLE "public"."project_tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."project_tasks" TO "service_role";



GRANT ALL ON TABLE "public"."purchase_order_summary" TO "anon";
GRANT ALL ON TABLE "public"."purchase_order_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."purchase_order_summary" TO "service_role";



GRANT ALL ON TABLE "public"."purchase_orders" TO "anon";
GRANT ALL ON TABLE "public"."purchase_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."purchase_orders" TO "service_role";



GRANT ALL ON TABLE "public"."quote_send_log" TO "anon";
GRANT ALL ON TABLE "public"."quote_send_log" TO "authenticated";
GRANT ALL ON TABLE "public"."quote_send_log" TO "service_role";



GRANT ALL ON TABLE "public"."quotes" TO "anon";
GRANT ALL ON TABLE "public"."quotes" TO "authenticated";
GRANT ALL ON TABLE "public"."quotes" TO "service_role";



GRANT ALL ON TABLE "public"."referral_agreements" TO "anon";
GRANT ALL ON TABLE "public"."referral_agreements" TO "authenticated";
GRANT ALL ON TABLE "public"."referral_agreements" TO "service_role";



GRANT ALL ON TABLE "public"."referral_commissions" TO "anon";
GRANT ALL ON TABLE "public"."referral_commissions" TO "authenticated";
GRANT ALL ON TABLE "public"."referral_commissions" TO "service_role";



GRANT ALL ON TABLE "public"."referral_partners" TO "anon";
GRANT ALL ON TABLE "public"."referral_partners" TO "authenticated";
GRANT ALL ON TABLE "public"."referral_partners" TO "service_role";



GRANT ALL ON TABLE "public"."reimbursements" TO "anon";
GRANT ALL ON TABLE "public"."reimbursements" TO "authenticated";
GRANT ALL ON TABLE "public"."reimbursements" TO "service_role";



GRANT ALL ON TABLE "public"."renewal_email_log" TO "anon";
GRANT ALL ON TABLE "public"."renewal_email_log" TO "authenticated";
GRANT ALL ON TABLE "public"."renewal_email_log" TO "service_role";



GRANT ALL ON TABLE "public"."salary_payments" TO "anon";
GRANT ALL ON TABLE "public"."salary_payments" TO "authenticated";
GRANT ALL ON TABLE "public"."salary_payments" TO "service_role";



GRANT ALL ON TABLE "public"."statutory_dues_payments" TO "anon";
GRANT ALL ON TABLE "public"."statutory_dues_payments" TO "authenticated";
GRANT ALL ON TABLE "public"."statutory_dues_payments" TO "service_role";



GRANT ALL ON TABLE "public"."subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."subscriptions" TO "service_role";



GRANT ALL ON TABLE "public"."support_plans" TO "anon";
GRANT ALL ON TABLE "public"."support_plans" TO "authenticated";
GRANT ALL ON TABLE "public"."support_plans" TO "service_role";



GRANT ALL ON TABLE "public"."support_sync_outbox" TO "anon";
GRANT ALL ON TABLE "public"."support_sync_outbox" TO "authenticated";
GRANT ALL ON TABLE "public"."support_sync_outbox" TO "service_role";



GRANT ALL ON TABLE "public"."support_tickets" TO "anon";
GRANT ALL ON TABLE "public"."support_tickets" TO "authenticated";
GRANT ALL ON TABLE "public"."support_tickets" TO "service_role";



GRANT ALL ON TABLE "public"."tasks" TO "anon";
GRANT ALL ON TABLE "public"."tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."tasks" TO "service_role";



GRANT ALL ON TABLE "public"."tds_receivable" TO "anon";
GRANT ALL ON TABLE "public"."tds_receivable" TO "authenticated";
GRANT ALL ON TABLE "public"."tds_receivable" TO "service_role";



GRANT ALL ON TABLE "public"."team_invites" TO "anon";
GRANT ALL ON TABLE "public"."team_invites" TO "authenticated";
GRANT ALL ON TABLE "public"."team_invites" TO "service_role";



GRANT ALL ON TABLE "public"."tenant_domains" TO "anon";
GRANT ALL ON TABLE "public"."tenant_domains" TO "authenticated";
GRANT ALL ON TABLE "public"."tenant_domains" TO "service_role";



GRANT ALL ON TABLE "public"."tenant_secrets" TO "anon";
GRANT ALL ON TABLE "public"."tenant_secrets" TO "authenticated";
GRANT ALL ON TABLE "public"."tenant_secrets" TO "service_role";



GRANT ALL ON TABLE "public"."tenants" TO "anon";
GRANT ALL ON TABLE "public"."tenants" TO "authenticated";
GRANT ALL ON TABLE "public"."tenants" TO "service_role";



GRANT ALL ON TABLE "public"."user_google_tokens" TO "anon";
GRANT ALL ON TABLE "public"."user_google_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."user_google_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."users" TO "anon";
GRANT ALL ON TABLE "public"."users" TO "authenticated";
GRANT ALL ON TABLE "public"."users" TO "service_role";



GRANT ALL ON TABLE "public"."v_tenant_with_parent" TO "anon";
GRANT ALL ON TABLE "public"."v_tenant_with_parent" TO "authenticated";
GRANT ALL ON TABLE "public"."v_tenant_with_parent" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."vault_access_log" TO "anon";
GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."vault_access_log" TO "authenticated";
GRANT ALL ON TABLE "public"."vault_access_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."vault_access_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."vault_access_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."vault_access_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."vault_passwords" TO "anon";
GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."vault_passwords" TO "authenticated";
GRANT ALL ON TABLE "public"."vault_passwords" TO "service_role";



GRANT SELECT("id") ON TABLE "public"."vault_passwords" TO "authenticated";



GRANT SELECT("tenant_id") ON TABLE "public"."vault_passwords" TO "authenticated";



GRANT SELECT("customer_id") ON TABLE "public"."vault_passwords" TO "authenticated";



GRANT SELECT("title") ON TABLE "public"."vault_passwords" TO "authenticated";



GRANT SELECT("category") ON TABLE "public"."vault_passwords" TO "authenticated";



GRANT SELECT("url") ON TABLE "public"."vault_passwords" TO "authenticated";



GRANT SELECT("password_fingerprint") ON TABLE "public"."vault_passwords" TO "authenticated";



GRANT SELECT("last_rotated_at") ON TABLE "public"."vault_passwords" TO "authenticated";



GRANT SELECT("created_by") ON TABLE "public"."vault_passwords" TO "authenticated";



GRANT SELECT("created_at") ON TABLE "public"."vault_passwords" TO "authenticated";



GRANT SELECT("updated_at") ON TABLE "public"."vault_passwords" TO "authenticated";



GRANT ALL ON TABLE "public"."vendor_bills" TO "anon";
GRANT ALL ON TABLE "public"."vendor_bills" TO "authenticated";
GRANT ALL ON TABLE "public"."vendor_bills" TO "service_role";



GRANT ALL ON TABLE "public"."vendors" TO "anon";
GRANT ALL ON TABLE "public"."vendors" TO "authenticated";
GRANT ALL ON TABLE "public"."vendors" TO "service_role";



GRANT ALL ON TABLE "public"."whatsapp_messages" TO "anon";
GRANT ALL ON TABLE "public"."whatsapp_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."whatsapp_messages" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







