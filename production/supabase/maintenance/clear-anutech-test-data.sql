-- Clear ANUTECH's test data, keeping the things that are not test data.
--
-- Pardeep confirmed twice on 22 Aug 2026 that the transactional data in
-- fbb976f1-9090-4f10-9726-0901bd144e42 is test data he entered while trying the app, and
-- that he will re-enter it properly. He also asked to keep products, and agreed that
-- employees, bank accounts and team logins are not test data either.
--
-- ─── WHY THIS DOES THE WHOLE JOB, NOT JUST HALF ─────────────────────────────
-- Settings → Reset data covers only six sections (its allowlist is leads, quotes, tasks,
-- expenses, invoices, attendance) and needs the operator's login password, which he does
-- not have — the app has no forgot-password route (AGENTS.md L15; a page is now built).
-- Customers, subscriptions, bank transactions, salary payments and support tickets are
-- unreachable from that screen at all.
--
-- ─── ORDER IS NOT A PREFERENCE ──────────────────────────────────────────────
--   quotes BEFORE customers — payments_customer_id_fkey is NO ACTION, so a customer with
--     a payment pointing at it cannot be deleted. payments_quote_id_fkey is CASCADE, so
--     deleting the quotes takes the payments and clears the path.
--   invoices EXPLICITLY — invoices_quote_id_fkey and invoices_customer_id_fkey are both
--     SET NULL, so invoices survive both deletes and have to be named.
--   nothing blocks — credit_notes and debit_notes RESTRICT on invoices, and this tenant
--     has 0 of each (checked before writing this).
--
-- ─── WHAT GOES WITH WHAT, VIA CASCADE ───────────────────────────────────────
--   quotes    → payments, quote_send_log, quote_signatures, provisioning_tasks, tasks
--   customers → subscriptions, customer_users, customer_credits, customer_domains,
--               payment_mandates, referral_agreements, mrr_snapshots, vault_passwords
--               (0 rows — no customer passwords are lost), support_sync_outbox
--   leads     → lead_activities
--   invoices  → invoice_dunning_log
--
-- ─── KEPT ───────────────────────────────────────────────────────────────────
--   items (25) · employees (10) · bank_accounts (2) · users (10) · tenant settings
--   (GSTIN 07ABDCA0298H1ZP, doc_code ADPL) · tenant_secrets · document_series.
--
--   document_series is deliberately NOT reset, so the next invoice is
--   INV-ADPL-2026-27-0033 rather than 0001. Leaving a GST series alone is the safe
--   choice — CGST Rule 46 wants an unbroken series, and re-using numbers that have been
--   issued is worse than starting from 33.

begin;

do $$
declare
  v_tenant  uuid := 'fbb976f1-9090-4f10-9726-0901bd144e42';
  v_name    text;
  v_backup  uuid;
  v_items   int; v_emps int; v_banks int; v_users int;
begin
  -- ── Guard: this is the tenant we think it is ─────────────────────────────
  select name into v_name from public.tenants where id = v_tenant;
  if v_name is distinct from 'ANUTECH DIGITAL PVT LTD' then
    raise exception 'STOP: tenant % is named %, expected ANUTECH DIGITAL PVT LTD. Nothing changed.', v_tenant, coalesce(v_name, '(missing)');
  end if;

  -- ── A restore point of its own, before anything is removed ───────────────
  v_backup := backup._take(v_tenant, 'Before clearing ANUTECH test data (22 Aug 2026)', 'manual');
  if v_backup is null then
    raise exception 'STOP: the pre-delete snapshot came back null. Nothing changed.';
  end if;

  -- ── Counts to protect ────────────────────────────────────────────────────
  select count(*) into v_items from public.items         where tenant_id = v_tenant;
  select count(*) into v_emps  from public.employees     where tenant_id = v_tenant;
  select count(*) into v_banks from public.bank_accounts where tenant_id = v_tenant;
  select count(*) into v_users from public.users         where tenant_id = v_tenant;

  -- ── Delete, in FK-safe order ─────────────────────────────────────────────
  delete from public.support_tickets    where tenant_id = v_tenant;
  delete from public.salary_payments    where tenant_id = v_tenant;
  delete from public.attendance         where tenant_id = v_tenant;
  delete from public.expenses           where tenant_id = v_tenant;
  delete from public.bank_transactions  where tenant_id = v_tenant;
  delete from public.invoices           where tenant_id = v_tenant;
  delete from public.quotes             where tenant_id = v_tenant;  -- payments CASCADE here
  delete from public.tasks              where tenant_id = v_tenant;
  delete from public.leads              where tenant_id = v_tenant;
  delete from public.customers          where tenant_id = v_tenant;  -- subscriptions CASCADE here

  -- ── Guards that ABORT the whole thing if a keeper was touched ────────────
  /* Raising here rolls the transaction back, which is why this belongs inside it — unlike
     a verification SELECT, which would report success for a change not yet committed
     (CLAUDE.md §25.6). The real verification runs separately, after the commit. */
  if (select count(*) from public.items         where tenant_id = v_tenant) <> v_items then
    raise exception 'STOP: items changed from % — rolling back everything.', v_items;
  end if;
  if (select count(*) from public.employees     where tenant_id = v_tenant) <> v_emps then
    raise exception 'STOP: employees changed from % — rolling back everything.', v_emps;
  end if;
  if (select count(*) from public.bank_accounts where tenant_id = v_tenant) <> v_banks then
    raise exception 'STOP: bank_accounts changed from % — rolling back everything.', v_banks;
  end if;
  if (select count(*) from public.users         where tenant_id = v_tenant) <> v_users then
    raise exception 'STOP: users changed from % — rolling back everything. Nobody gets locked out.', v_users;
  end if;

  raise notice 'Cleared. Kept items=% employees=% bank_accounts=% users=%', v_items, v_emps, v_banks, v_users;
end $$;

commit;
