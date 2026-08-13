begin;

update public.document_series
   set last_number = 0, updated_at = now()
 where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

update public.customer_number_seq
   set last_number = 0
 where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

-- 634 rows. This is the audit trail of the dummy data — nothing above it
-- survives, so keeping it would only produce activity entries pointing at
-- records that no longer exist.
delete from public.activity_log            where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.compliance_log          where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.compliance_reminder_log where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

commit;
