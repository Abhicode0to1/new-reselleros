-- ============================================================================
-- A customer cannot disappear from under its own financial records — 26 Sep 2026.
-- Cross-team request R-007, raised by Pardeep (Accounting & Finance) on 25 Sep 2026.
--
-- WHY
--   Invoices, credit notes, debit notes and TDS entries are legal records. GSTR-1, the
--   customer Ledger (Khata) and Aging all read the customer off them. Today the schema
--   lets the customer vanish and leaves the record behind:
--
--     invoices, quotes, credit_notes, debit_notes, tds_receivable, project_sales
--                                     ON DELETE SET NULL  -> the record survives with
--                                                            nobody on it
--     subscriptions                   ON DELETE CASCADE   -> the record is DESTROYED
--
--   `delete_customer` (0174) does refuse when there are subscriptions, payments,
--   invoices, quotes or projects — but it is one door, not the wall. A `delete from
--   public.customers` in psql, a future bulk tool, or any code path that skips the RPC
--   walks straight past it. Measured on this database on 25 Sep 2026: deleting four
--   customers directly detached five quotes, four of them accepted.
--
--   And the RPC never counted credit notes, debit notes or TDS entries at all, so a
--   customer holding only those was deletable through the front door as well.
--
-- WHAT THIS DOES
--   1. Those six foreign keys become ON DELETE RESTRICT, so the DATABASE refuses while
--      any financial record points at the customer. `payments` is left alone — it is
--      already NO ACTION, which refuses the same way.
--   2. `subscriptions` goes from CASCADE to RESTRICT. This is the biggest change here:
--      today a direct delete silently erases recurring revenue and its renewals.
--   3. `delete_customer` also counts credit notes, debit notes and TDS entries, so the
--      friendly message and the hard wall agree about what blocks a delete. Two
--      guards that disagree is how one of them gets deleted as a nuisance.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   It does not touch the columns, and it does not make the keys composite on
--   (tenant_id, id) the way AGENTS.md §4 wants. That is a real and separate defect on
--   six tables; folding it into a delete-rule change would put a tenant-boundary
--   migration inside one about deletion, and neither would be reviewable.
--
--   It also does not clean up rows whose customer_id is already NULL. Those are the
--   damage this prevents from recurring, not something a schema change can undo — the
--   customer they pointed at is gone.
--
-- IF THIS MIGRATION FAILS on `ADD CONSTRAINT`, a row points at a customer id that does
-- not exist (only possible if a customer was deleted with the FK already dropped). The
-- pre-flight block below names the table and count rather than letting Postgres report
-- it as an opaque constraint violation.
-- ============================================================================

begin;

-- ── Pre-flight: say which table is wrong, not just that something is ────────
do $$
declare
  r        record;
  v_bad    bigint;
  v_report text := '';
begin
  for r in
    select unnest(array['invoices','quotes','credit_notes','debit_notes',
                        'tds_receivable','project_sales','subscriptions']) as tbl
  loop
    execute format(
      'select count(*) from public.%I t where t.customer_id is not null
         and not exists (select 1 from public.customers c where c.id = t.customer_id)',
      r.tbl) into v_bad;
    if v_bad > 0 then
      v_report := v_report || format('%s: %s row(s); ', r.tbl, v_bad);
    end if;
  end loop;

  if v_report <> '' then
    raise exception
      'Cannot add the RESTRICT keys: some rows point at a customer that no longer exists (%). Fix those rows first — set customer_id to the right customer, or to NULL if the party is genuinely unknown — then re-run this migration.',
      v_report;
  end if;
end $$;

-- ── The six that used to detach ─────────────────────────────────────────────
alter table public.invoices        drop constraint if exists invoices_customer_id_fkey;
alter table public.invoices        add  constraint invoices_customer_id_fkey
  foreign key (customer_id) references public.customers(id) on delete restrict;

alter table public.quotes          drop constraint if exists quotes_customer_id_fkey;
alter table public.quotes          add  constraint quotes_customer_id_fkey
  foreign key (customer_id) references public.customers(id) on delete restrict;

alter table public.credit_notes    drop constraint if exists credit_notes_customer_id_fkey;
alter table public.credit_notes    add  constraint credit_notes_customer_id_fkey
  foreign key (customer_id) references public.customers(id) on delete restrict;

alter table public.debit_notes     drop constraint if exists debit_notes_customer_id_fkey;
alter table public.debit_notes     add  constraint debit_notes_customer_id_fkey
  foreign key (customer_id) references public.customers(id) on delete restrict;

alter table public.tds_receivable  drop constraint if exists tds_receivable_customer_id_fkey;
alter table public.tds_receivable  add  constraint tds_receivable_customer_id_fkey
  foreign key (customer_id) references public.customers(id) on delete restrict;

alter table public.project_sales   drop constraint if exists project_sales_customer_id_fkey;
alter table public.project_sales   add  constraint project_sales_customer_id_fkey
  foreign key (customer_id) references public.customers(id) on delete restrict;

-- ── And the one that used to DESTROY ────────────────────────────────────────
alter table public.subscriptions   drop constraint if exists subscriptions_customer_id_fkey;
alter table public.subscriptions   add  constraint subscriptions_customer_id_fkey
  foreign key (customer_id) references public.customers(id) on delete restrict;

commit;

-- ============================================================================
-- delete_customer: count the three record types it never looked at.
--
-- A separate transaction from the DDL above, deliberately — AGENTS.md §5. If the
-- function body has a problem, the keys are already committed and the wall stands;
-- the friendly message is the part that would be missing, not the protection.
-- ============================================================================

begin;

create or replace function public.delete_customer(p_customer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant      uuid;
  v_caller      uuid;
  v_is_service  boolean;
  v_subs        integer;
  v_pays        integer;
  v_invs        integer;
  v_quotes      integer;
  v_projs       integer;
  v_credits     integer;
  v_debits      integer;
  v_tds         integer;
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

  select count(*) into v_subs    from public.subscriptions  where customer_id = p_customer_id;
  select count(*) into v_pays    from public.payments       where customer_id = p_customer_id;
  select count(*) into v_invs    from public.invoices       where customer_id = p_customer_id;
  select count(*) into v_quotes  from public.quotes         where customer_id = p_customer_id;
  select count(*) into v_projs   from public.project_sales  where customer_id = p_customer_id;
  -- R-007: these three are legal records too, and nothing counted them. A customer
  -- holding only a credit note was deletable through the front door.
  select count(*) into v_credits from public.credit_notes   where customer_id = p_customer_id;
  select count(*) into v_debits  from public.debit_notes    where customer_id = p_customer_id;
  select count(*) into v_tds     from public.tds_receivable where customer_id = p_customer_id;

  if v_subs    > 0 then v_parts := v_parts || format('%s subscription(s)', v_subs);   end if;
  if v_pays    > 0 then v_parts := v_parts || format('%s payment(s)',      v_pays);    end if;
  if v_invs    > 0 then v_parts := v_parts || format('%s invoice(s)',      v_invs);    end if;
  if v_quotes  > 0 then v_parts := v_parts || format('%s quote(s)',        v_quotes);  end if;
  if v_projs   > 0 then v_parts := v_parts || format('%s project(s)',      v_projs);   end if;
  if v_credits > 0 then v_parts := v_parts || format('%s credit note(s)',  v_credits); end if;
  if v_debits  > 0 then v_parts := v_parts || format('%s debit note(s)',   v_debits);  end if;
  if v_tds     > 0 then v_parts := v_parts || format('%s TDS entry(s)',    v_tds);     end if;

  if array_length(v_parts, 1) is not null then
    raise exception
      'Cannot delete customer "%": has %. Those are financial records and must keep their customer. Archive the customer instead (Customers -> the customer -> Archive), which hides it everywhere without touching the books.',
      v_name, array_to_string(v_parts, ', ');
  end if;

  delete from public.customers where id = p_customer_id and tenant_id = v_tenant;

  return jsonb_build_object('deleted', true, 'customer_id', p_customer_id);
end;
$function$;

commit;
