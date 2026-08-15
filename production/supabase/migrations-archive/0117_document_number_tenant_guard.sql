-- 0117 — stop callers minting document/customer numbers for ANOTHER tenant (SEC-2).
--
-- next_document_number(doc_type, tenant_id) and next_customer_number(tenant) are
-- SECURITY DEFINER and granted to authenticated. They took a caller-supplied
-- tenant id with NO check that it belongs to the caller — so any logged-in user
-- could burn/gap another supplier's statutory GST invoice sequence (CGST Rule 46
-- requires gap-free numbering) or its customer sequence.
--
-- Fix: when the caller is an authenticated user (current_tenant_id() is not
-- null), force their own tenant and reject a mismatched explicit tenant id.
-- Trusted server contexts (service_role — webhooks, public checkout) have a null
-- current_tenant_id() and keep passing the tenant explicitly, unchanged.

create or replace function public.next_document_number(p_doc_type text, p_tenant_id uuid DEFAULT NULL::uuid)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_caller      uuid := public.current_tenant_id();
  v_tenant_id   uuid;
  v_fy          text;
  v_prefix      text;
  v_code        text;
  v_next_number integer;
begin
  -- Authorization: an authenticated user may only allocate for their own tenant.
  if v_caller is not null then
    if p_tenant_id is not null and p_tenant_id <> v_caller then
      raise exception 'Cannot allocate a document number for another tenant'
        using errcode = 'insufficient_privilege';
    end if;
    v_tenant_id := v_caller;
  else
    v_tenant_id := p_tenant_id;   -- trusted server context (service_role)
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
$function$;

create or replace function public.next_customer_number(p_tenant uuid)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
$function$;

-- Least privilege: this was callable by PUBLIC. Restrict to real roles.
revoke execute on function public.next_customer_number(uuid) from public;
grant  execute on function public.next_customer_number(uuid) to authenticated, service_role;
