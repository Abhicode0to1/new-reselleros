-- ============================================================================
-- R-163 (5 Oct 2026): Payment run + Approval — paying vendors the Pazy way, inside ResellerOS
--
-- WHY
--   Pardeep: "Pazy jo feature de raha hai wo apne app me hi bana le." The first piece is the
--   one that saves time every week: pick the bills that are due, get the owner's yes, hand the
--   bank ONE bulk-payment file, and have every bill marked paid when the money has gone.
--
-- THE RULE THAT SHAPES ALL OF IT
--   ResellerOS never moves money. It writes the bank's bulk-upload file; a person uploads it
--   in their own net-banking login. The bills turn "paid" only when that person says the bank
--   has paid (mark_payment_run_paid) — never when the file is downloaded, because a file can
--   be downloaded and never uploaded, or rejected by the bank.
--
-- WHO MAY DO WHAT (users.role)
--   create / cancel a draft ...... owner, manager, billing, accountant   (the Books roles)
--   approve ...................... owner, manager — and a manager may not approve a run they
--                                  created (two people for a payment). The owner may: in a
--                                  small company the owner is often both, and that is a choice
--                                  they make knowingly; it is recorded (approved_by = created_by).
--   mark paid .................... owner, manager, billing, accountant, only once approved
--
-- WHAT IT REFUSES
--   * a bill or expense that is already paid, or a larger amount than is still owed;
--   * the same bill in two open runs (draft/approved) — the double payment Pazy exists to stop;
--   * marking paid a run whose bills were paid elsewhere since it was approved — it names them.
--
-- THE TABLES
--   payment_runs / payment_run_items are written ONLY by the functions below (no insert/update
--   policy for authenticated), so every rule above holds whatever the browser sends.
--   vendors gains bank details — the bulk file needs account number + IFSC (or a UPI id).
-- ============================================================================
begin;

-- ─── Vendor bank details ─────────────────────────────────────────────────────
alter table public.vendors add column if not exists bank_account_name text;
alter table public.vendors add column if not exists bank_account_no   text;
alter table public.vendors add column if not exists bank_ifsc         text;
alter table public.vendors add column if not exists upi_id            text;

alter table public.vendors drop constraint if exists vendors_bank_ifsc_format;
alter table public.vendors add constraint vendors_bank_ifsc_format
  check (bank_ifsc is null or bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$');
alter table public.vendors drop constraint if exists vendors_bank_account_no_format;
alter table public.vendors add constraint vendors_bank_account_no_format
  check (bank_account_no is null or bank_account_no ~ '^[0-9]{6,18}$');
alter table public.vendors drop constraint if exists vendors_upi_id_format;
alter table public.vendors add constraint vendors_upi_id_format
  check (upi_id is null or upi_id ~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9.-]{1,64}$');

-- ─── Runs ────────────────────────────────────────────────────────────────────
create table if not exists public.payment_runs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  run_no          text not null,
  status          text not null default 'draft' check (status in ('draft','approved','paid','cancelled')),
  bank_account_id uuid not null references public.bank_accounts(id),
  pay_on          date not null default current_date,
  total           bigint not null default 0 check (total >= 0),
  note            text check (note is null or length(note) <= 500),
  created_by      uuid not null references auth.users(id),
  created_at      timestamptz not null default now(),
  approved_by     uuid references auth.users(id),
  approved_at     timestamptz,
  paid_by         uuid references auth.users(id),
  paid_at         timestamptz,
  paid_on         date,
  cancelled_by    uuid references auth.users(id),
  cancelled_at    timestamptz,
  updated_at      timestamptz not null default now(),
  unique (tenant_id, run_no)
);
create index if not exists payment_runs_tenant_status_idx on public.payment_runs (tenant_id, status, created_at desc);

create table if not exists public.payment_run_items (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references public.payment_runs(id) on delete cascade,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  source      text not null check (source in ('vendor_bill','expense')),
  doc_id      text not null,
  doc_ref     text,
  vendor_id   uuid references public.vendors(id) on delete set null,
  vendor_name text not null,
  amount      integer not null check (amount > 0),
  unique (run_id, source, doc_id)
);
create index if not exists payment_run_items_doc_idx on public.payment_run_items (tenant_id, source, doc_id);

alter table public.payment_runs enable row level security;
alter table public.payment_run_items enable row level security;

drop policy if exists payment_runs_select on public.payment_runs;
create policy payment_runs_select on public.payment_runs for select to authenticated
  using (tenant_id = public.current_tenant_id());
drop policy if exists payment_run_items_select on public.payment_run_items;
create policy payment_run_items_select on public.payment_run_items for select to authenticated
  using (tenant_id = public.current_tenant_id());

drop policy if exists zzz_service_role_all on public.payment_runs;
create policy zzz_service_role_all on public.payment_runs as permissive for all to service_role using (true) with check (true);
drop policy if exists zzz_service_role_all on public.payment_run_items;
create policy zzz_service_role_all on public.payment_run_items as permissive for all to service_role using (true) with check (true);

-- Cloud SQL default privileges were deferred (01b): grant explicitly. Read-only for members.
-- The revoke is not redundant: on hosted/local Supabase default privileges hand every new
-- table to authenticated and anon with ALL rights. RLS (no write policy) would still stop a
-- write, but these rows are money decisions — two locks, not one (test 6 checks this one).
revoke all on public.payment_runs, public.payment_run_items from anon, authenticated;
grant select on public.payment_runs, public.payment_run_items to authenticated;
grant select, insert, update, delete on public.payment_runs, public.payment_run_items to service_role;

-- ─── Helpers ─────────────────────────────────────────────────────────────────
create or replace function public.payment_run_role()
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select role::text from public.users where id = auth.uid();
$$;
revoke all on function public.payment_run_role() from public, anon;
grant execute on function public.payment_run_role() to authenticated;

/* What is still owed on one document, for this tenant. null = not found / not payable.
   Rupee documents only: a bulk NEFT/RTGS file pays in INR, and a USD bill's total is in USD
   (a foreign vendor is paid by wire, outside a payment run). */
create or replace function public.payment_run_outstanding(p_tenant uuid, p_source text, p_doc text)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select case p_source
    when 'vendor_bill' then (select greatest(coalesce(b.total,0) - coalesce(b.paid_amount,0), 0)
                               from public.vendor_bills b
                              where b.id = p_doc and b.tenant_id = p_tenant and coalesce(b.status,'unpaid') <> 'paid'
                                and upper(coalesce(b.currency,'INR')) = 'INR')
    when 'expense'     then (select greatest(coalesce(e.amount,0), 0)
                               from public.expenses e
                              where e.id = p_doc and e.tenant_id = p_tenant and coalesce(e.paid, true) = false
                                and upper(coalesce(e.currency,'INR')) = 'INR')
  end;
$$;
revoke all on function public.payment_run_outstanding(uuid, text, text) from public, anon;

-- ─── create_payment_run ──────────────────────────────────────────────────────
/* p_items: [{"source":"vendor_bill"|"expense","doc_id":"…","amount":1234}, …] */
create or replace function public.create_payment_run(p_items jsonb, p_bank_account_id uuid, p_pay_on date default null, p_note text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_role   text := public.payment_run_role();
  v_run    uuid;
  v_no     text;
  v_total  bigint := 0;
  it       jsonb;
  v_src    text; v_doc text; v_amt integer; v_owed integer;
  v_vid uuid; v_vname text; v_ref text;
begin
  if v_tenant is null then raise exception 'No tenant context' using errcode = 'insufficient_privilege'; end if;
  if v_role is null or v_role not in ('owner','manager','billing','accountant') then
    raise exception 'Only owner, manager, billing or accountant can create a payment run' using errcode = 'insufficient_privilege';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Pick at least one bill to pay';
  end if;
  if jsonb_array_length(p_items) > 200 then raise exception 'At most 200 bills in one run'; end if;
  if not exists (select 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant) then
    raise exception 'Pay-from bank account not found';
  end if;

  -- Run number: PR-YYYYMM-NNN, per tenant. The advisory lock makes two creates in the same
  -- instant take turns instead of colliding on the unique (tenant_id, run_no).
  perform pg_advisory_xact_lock(hashtext('payment_run_no:' || v_tenant::text));
  select 'PR-' || to_char(coalesce(p_pay_on, current_date), 'YYYYMM') || '-' ||
         lpad((count(*) + 1)::text, 3, '0')
    into v_no
    from public.payment_runs
   where tenant_id = v_tenant and run_no like 'PR-' || to_char(coalesce(p_pay_on, current_date), 'YYYYMM') || '-%';

  insert into public.payment_runs (tenant_id, run_no, bank_account_id, pay_on, note, created_by)
  values (v_tenant, v_no, p_bank_account_id, coalesce(p_pay_on, current_date), nullif(trim(p_note), ''), auth.uid())
  returning id into v_run;

  for it in select * from jsonb_array_elements(p_items) loop
    v_src := it->>'source';
    v_doc := it->>'doc_id';
    v_amt := (it->>'amount')::integer;
    if v_src not in ('vendor_bill','expense') or v_doc is null then raise exception 'Bad item in the run'; end if;
    if v_amt is null or v_amt <= 0 then raise exception 'Amount must be more than zero (%)', v_doc; end if;

    v_owed := public.payment_run_outstanding(v_tenant, v_src, v_doc);
    if v_owed is null or v_owed = 0 then raise exception '% is already paid or not found', v_doc; end if;
    if v_amt > v_owed then raise exception '% — ₹% is more than the ₹% still owed', v_doc, v_amt, v_owed; end if;

    if exists (select 1 from public.payment_run_items i join public.payment_runs r on r.id = i.run_id
                where i.tenant_id = v_tenant and i.source = v_src and i.doc_id = v_doc
                  and r.status in ('draft','approved') and r.id <> v_run) then
      raise exception '% is already in another open payment run', v_doc;
    end if;

    if v_src = 'vendor_bill' then
      select b.vendor_id, b.vendor_name, b.bill_no into v_vid, v_vname, v_ref from public.vendor_bills b where b.id = v_doc;
    else
      select e.vendor_id, coalesce(e.vendor_name, e.category), e.bill_no into v_vid, v_vname, v_ref from public.expenses e where e.id = v_doc;
    end if;

    insert into public.payment_run_items (run_id, tenant_id, source, doc_id, doc_ref, vendor_id, vendor_name, amount)
    values (v_run, v_tenant, v_src, v_doc, v_ref, v_vid, coalesce(v_vname, 'Vendor'), v_amt);
    v_total := v_total + v_amt;
  end loop;

  update public.payment_runs set total = v_total where id = v_run;
  return v_run;
end $$;
revoke all on function public.create_payment_run(jsonb, uuid, date, text) from public, anon;
grant execute on function public.create_payment_run(jsonb, uuid, date, text) to authenticated;

-- ─── approve_payment_run ─────────────────────────────────────────────────────
create or replace function public.approve_payment_run(p_run_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_role   text := public.payment_run_role();
  r        public.payment_runs;
  it       public.payment_run_items;
  v_owed   integer;
begin
  if v_tenant is null then raise exception 'No tenant context' using errcode = 'insufficient_privilege'; end if;
  select * into r from public.payment_runs where id = p_run_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Payment run not found'; end if;
  if v_role is null or v_role not in ('owner','manager') then
    raise exception 'Only the owner or a manager can approve a payment run' using errcode = 'insufficient_privilege';
  end if;
  if v_role = 'manager' and r.created_by = auth.uid() then
    raise exception 'A manager cannot approve a run they created — ask the owner or another manager' using errcode = 'insufficient_privilege';
  end if;
  if r.status <> 'draft' then raise exception 'Only a draft run can be approved (this one is %)', r.status; end if;

  -- Re-check: a bill may have been paid by hand since the draft was made.
  for it in select * from public.payment_run_items where run_id = r.id loop
    v_owed := public.payment_run_outstanding(v_tenant, it.source, it.doc_id);
    if v_owed is null or v_owed < it.amount then
      raise exception '% (%) is no longer owed in full — cancel this run and make a new one', coalesce(it.doc_ref, it.doc_id), it.vendor_name;
    end if;
  end loop;

  update public.payment_runs set status = 'approved', approved_by = auth.uid(), approved_at = now(), updated_at = now() where id = r.id;
end $$;
revoke all on function public.approve_payment_run(uuid) from public, anon;
grant execute on function public.approve_payment_run(uuid) to authenticated;

-- ─── mark_payment_run_paid ───────────────────────────────────────────────────
create or replace function public.mark_payment_run_paid(p_run_id uuid, p_paid_on date default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_role   text := public.payment_run_role();
  r        public.payment_runs;
  it       public.payment_run_items;
  v_owed   integer;
  v_on     date := coalesce(p_paid_on, current_date);
  v_txn    uuid;
  v_bill   public.vendor_bills;
begin
  if v_tenant is null then raise exception 'No tenant context' using errcode = 'insufficient_privilege'; end if;
  if v_role is null or v_role not in ('owner','manager','billing','accountant') then
    raise exception 'Only owner, manager, billing or accountant can mark a run paid' using errcode = 'insufficient_privilege';
  end if;
  select * into r from public.payment_runs where id = p_run_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Payment run not found'; end if;
  if r.status <> 'approved' then raise exception 'Only an approved run can be marked paid (this one is %)', r.status; end if;

  for it in select * from public.payment_run_items where run_id = r.id order by vendor_name loop
    v_owed := public.payment_run_outstanding(v_tenant, it.source, it.doc_id);
    if v_owed is null or v_owed < it.amount then
      raise exception '% (%) was paid elsewhere after approval — nothing was marked; check it and try again', coalesce(it.doc_ref, it.doc_id), it.vendor_name;
    end if;

    if it.source = 'vendor_bill' then
      select * into v_bill from public.vendor_bills where id = it.doc_id and tenant_id = v_tenant for update;
      update public.vendor_bills
         set paid_amount = coalesce(paid_amount,0) + it.amount,
             status = case when coalesce(paid_amount,0) + it.amount >= total then 'paid' else 'partial' end,
             updated_at = now()
       where id = it.doc_id and tenant_id = v_tenant;
      insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, debit, credit, source,
                                            matched_to_type, matched_to_id, match_confidence, reference)
      values (v_tenant, r.bank_account_id, v_on, 'Bill payment: ' || it.vendor_name || ' · ' || r.run_no, it.amount, 0, 'manual',
              'vendor_bill', it.doc_id, 'manual', r.run_no);
    else
      insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, debit, credit, source,
                                            matched_to_type, matched_to_id, match_confidence, reference)
      values (v_tenant, r.bank_account_id, v_on, 'Expense payment: ' || it.vendor_name || ' · ' || r.run_no, it.amount, 0, 'manual',
              'expense', it.doc_id, 'manual', r.run_no)
      returning id into v_txn;
      update public.expenses
         set paid = true, paid_date = v_on, payment_method = 'bank_transfer',
             bank_account_id = r.bank_account_id, reconciled_txn_id = v_txn
       where id = it.doc_id and tenant_id = v_tenant;
    end if;
  end loop;

  update public.payment_runs set status = 'paid', paid_by = auth.uid(), paid_at = now(), paid_on = v_on, updated_at = now() where id = r.id;
end $$;
revoke all on function public.mark_payment_run_paid(uuid, date) from public, anon;
grant execute on function public.mark_payment_run_paid(uuid, date) to authenticated;

-- ─── cancel_payment_run ──────────────────────────────────────────────────────
create or replace function public.cancel_payment_run(p_run_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_role   text := public.payment_run_role();
  r        public.payment_runs;
begin
  if v_tenant is null then raise exception 'No tenant context' using errcode = 'insufficient_privilege'; end if;
  select * into r from public.payment_runs where id = p_run_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Payment run not found'; end if;
  if r.status not in ('draft','approved') then raise exception 'A % run cannot be cancelled', r.status; end if;
  -- An approved run is the owner's decision: only owner/manager undo it. A draft, its maker too.
  if not (v_role in ('owner','manager') or (r.status = 'draft' and r.created_by = auth.uid() and v_role in ('billing','accountant'))) then
    raise exception 'You cannot cancel this payment run' using errcode = 'insufficient_privilege';
  end if;
  update public.payment_runs set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), updated_at = now() where id = r.id;
end $$;
revoke all on function public.cancel_payment_run(uuid) from public, anon;
grant execute on function public.cancel_payment_run(uuid) to authenticated;

comment on table public.payment_runs is 'R-163: a batch of vendor payments — draft → approved (owner/manager) → paid (after the bank paid). ResellerOS never moves money; it writes the bulk-upload file.';

commit;
