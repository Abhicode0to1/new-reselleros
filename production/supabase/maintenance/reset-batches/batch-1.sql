begin;

delete from public.tds_receivable    where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.prepaid_advances  where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.customer_credits  where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.credit_notes      where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.debit_notes       where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

delete from public.payments          where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.invoices          where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.subscriptions     where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.quote_send_log    where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.quotes            where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

delete from public.renewal_email_log where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

-- Purchase side: allocations link POs to bills, so they go first.
delete from public.po_bill_allocations where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.vendor_bills        where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.inbound_purchases   where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.purchase_orders     where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

-- CRM. lead_activities before leads; customers before customer_groups
-- (customers carry the group reference, not the other way round).
delete from public.lead_activities   where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.leads             where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.contact_greeting_log where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.google_contact_links where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.contacts          where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.customer_domains  where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.customer_users    where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.customers         where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.customer_groups   where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

commit;
