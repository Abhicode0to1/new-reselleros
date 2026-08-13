-- Reset verification — RUN ON ITS OWN, AFTER the batches.
-- ONE statement: the editor shows only the LAST result of a multi-statement
-- script, which has already hidden checks once today.

select 'customers' as table_name, count(*)::text as rows_left,
       case when count(*) = 0 then 'CLEARED' else 'still has rows' end as state
  from public.customers
union all select 'subscriptions', count(*)::text,
       case when count(*) = 0 then 'CLEARED' else 'still has rows' end from public.subscriptions
union all select 'quotes', count(*)::text,
       case when count(*) = 0 then 'CLEARED' else 'still has rows' end from public.quotes
union all select 'invoices', count(*)::text,
       case when count(*) = 0 then 'CLEARED' else 'still has rows' end from public.invoices
union all select 'leads', count(*)::text,
       case when count(*) = 0 then 'CLEARED' else 'still has rows' end from public.leads
union all
-- MUST still have rows. If these are empty, a REAL batch was run by mistake
-- and the backup is now the only copy.
select 'bank_transactions (REAL — must NOT be 0)', count(*)::text,
       case when count(*) > 0 then 'INTACT' else 'DELETED — restore from backup' end
  from public.bank_transactions
union all
select 'employees (REAL — must NOT be 0)', count(*)::text,
       case when count(*) > 0 then 'INTACT' else 'DELETED — restore from backup' end
  from public.employees;
