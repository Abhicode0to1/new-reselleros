-- ============================================================================
-- One contact person can serve SEVERAL customers — 18 Sep 2026.
--
-- WHY
--   `contacts_unique_email_per_tenant` says one email is one person, which is right.
--   But `contacts.customer_id` is a single column, so that one person could belong to
--   exactly one customer — and the two rules together made a real situation
--   unrepresentable: an IT consultant who looks after three of your customers, or the
--   reseller's own address used while a customer's own contact is still unknown.
--
--   Abhishek hit it head-on on 18 Sep 2026: creating FF Impex with an email that was
--   already on Doodh Sang's contact. The database refused, correctly, and there was no
--   way to say "same person, second customer".
--
--   His instruction: "a contact can serve multiple customers … and give option in
--   subscription and customer creation time existing contact get picked".
--
-- WHAT THIS DOES
--   Adds `customer_contacts` — the link between a PERSON and a CUSTOMER. Role and
--   primary-ness move onto the LINK, because they are properties of the relationship,
--   not of the human: the same person can be the accountant for one customer and the
--   owner of another.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   `contacts.customer_id`, `contacts.role` and `contacts.is_primary` are NOT dropped.
--   Ten files still read them, including the invoice and dunning recipient lookup —
--   dropping them here would break who gets the payment reminder, in the same breath as
--   a schema change. They are backfilled into the link table and left in place; the
--   application layer moves over first, and a later migration removes them once nothing
--   reads them. Same staging as the 10 Sep contacts merge, for the same reason.
-- ============================================================================

create table if not exists public.customer_contacts (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  contact_id  text not null references public.contacts(id) on delete cascade,
  -- What this person does FOR THIS CUSTOMER. Same vocabulary as contacts.role.
  role        text,
  -- Receives this customer's invoices and payment reminders.
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now(),
  constraint customer_contacts_role_check
    check (role is null or role in ('owner','accountant','it_head','poc','other'))
);

comment on table public.customer_contacts is
  'Which people serve which customers. A contact may be linked to several customers; '
  'role and is_primary describe the RELATIONSHIP, not the person, because the same '
  'human can be an accountant for one customer and the owner of another.';

-- ── The same person is linked to a customer at most once ────────────────────
create unique index if not exists customer_contacts_unique_pair
  on public.customer_contacts (customer_id, contact_id);

-- ── Exactly one primary per customer ────────────────────────────────────────
-- Mirrors contacts_one_primary_per_customer. The primary is who gets the invoice and
-- the reminder, so "which one?" must never be a guess.
create unique index if not exists customer_contacts_one_primary
  on public.customer_contacts (customer_id)
  where is_primary;

create index if not exists customer_contacts_contact_idx
  on public.customer_contacts (tenant_id, contact_id);
create index if not exists customer_contacts_customer_idx
  on public.customer_contacts (tenant_id, customer_id);

-- ── Backfill from the single-customer world ─────────────────────────────────
-- Idempotent: on conflict do nothing, so re-running cannot duplicate a link.
insert into public.customer_contacts (tenant_id, customer_id, contact_id, role, is_primary)
select c.tenant_id, c.customer_id, c.id, c.role, coalesce(c.is_primary, false)
  from public.contacts c
 where c.customer_id is not null
on conflict (customer_id, contact_id) do nothing;

-- ── RLS — same shape as every other tenant-scoped table ─────────────────────
alter table public.customer_contacts enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                  where tablename = 'customer_contacts' and policyname = 'customer_contacts_select') then
    create policy customer_contacts_select on public.customer_contacts
      for select to authenticated using (tenant_id = public.current_tenant_id());
  end if;

  if not exists (select 1 from pg_policies
                  where tablename = 'customer_contacts' and policyname = 'customer_contacts_insert') then
    create policy customer_contacts_insert on public.customer_contacts
      for insert to authenticated with check (tenant_id = public.current_tenant_id());
  end if;

  if not exists (select 1 from pg_policies
                  where tablename = 'customer_contacts' and policyname = 'customer_contacts_update') then
    create policy customer_contacts_update on public.customer_contacts
      for update to authenticated using (tenant_id = public.current_tenant_id())
      with check (tenant_id = public.current_tenant_id());
  end if;

  if not exists (select 1 from pg_policies
                  where tablename = 'customer_contacts' and policyname = 'customer_contacts_delete') then
    create policy customer_contacts_delete on public.customer_contacts
      for delete to authenticated using (tenant_id = public.current_tenant_id());
  end if;

  if not exists (select 1 from pg_policies
                  where tablename = 'customer_contacts' and policyname = 'customer_contacts_service') then
    create policy customer_contacts_service on public.customer_contacts
      for all to service_role using (true) with check (true);
  end if;
end $$;

-- ── Mark the old columns as the legacy they now are ─────────────────────────
comment on column public.contacts.customer_id is
  'LEGACY since 18 Sep 2026 — a person now serves many customers via '
  'customer_contacts. Kept because ten files still read it, including the invoice and '
  'dunning recipient lookup. New code must read customer_contacts. Treated as the '
  'person''s FIRST/home customer where it is still consulted.';
comment on column public.contacts.is_primary is
  'LEGACY since 18 Sep 2026 — primary-ness is per CUSTOMER and lives on '
  'customer_contacts.is_primary. This column only describes the legacy home customer.';
