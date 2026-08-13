begin;

delete from public.project_tasks      where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.project_milestones where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.project_labour     where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.project_payments   where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.project_sales      where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

delete from public.support_sync_outbox where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.support_tickets     where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

delete from public.assessment_attempts where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.assessments         where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

delete from public.tasks              where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.inbound_emails     where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.whatsapp_messages  where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.campaign_sends     where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.campaigns          where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

commit;
