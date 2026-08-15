-- 0079_inbound_email_body_and_convert.sql
-- Enquiries Inbox — make inbound email READABLE inside the ERP + convertible.
--
-- 0069 kept only metadata (from/subject/status) for dedup + audit. To "show the
-- email logically" the operator needs the actual body, so we add body_text /
-- body_html. We also add an atomic convert-to-lead RPC for emails Gemini did
-- NOT auto-classify as an enquiry (status = received / skipped_non_enquiry):
-- the operator triages them in the inbox and promotes the real ones by hand.

-- 1. Store the message body (nullable — old rows + body-less providers stay valid).
alter table public.inbound_emails add column if not exists body_text text;
alter table public.inbound_emails add column if not exists body_html text;

-- 2. Atomic convert-to-lead.
--    SECURITY DEFINER so the operator can insert the lead + stamp the email row
--    in one transaction (mirrors the §17b atomic-write convention — never chain
--    two client writes). Tenant-scoped via current_tenant_id() so it can only
--    touch the caller's own row. Idempotent: an email that already produced a
--    lead returns that lead_id unchanged (no duplicate leads on double-click).
create or replace function public.convert_inbound_email_to_lead(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
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

  -- Already converted → idempotent no-op.
  if v_email.lead_id is not null then
    return v_email.lead_id;
  end if;

  v_company := coalesce(
    nullif(v_email.from_name, ''),
    nullif(split_part(coalesce(v_email.from_email, ''), '@', 2), ''),
    'Email lead'
  );

  -- Lead ids are text ("L-…"); mirror the JS generator (Date.now → base) with a
  -- microsecond epoch in hex so concurrent converts can't collide.
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

grant execute on function public.convert_inbound_email_to_lead(uuid) to authenticated;
